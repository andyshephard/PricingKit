import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getGoogleAuthFromCookies } from '@/middleware/auth';
import {
  getInAppProduct,
  updateInAppProductPrices,
  calculateNewPrice,
} from '@/lib/google-play/products';
import {
  getSubscription,
  updateBasePlanPrices,
} from '@/lib/google-play/subscriptions';
import type { Money, RegionalBasePlanConfig } from '@/lib/google-play/types';
import { toApiError } from '@/lib/utils/api-error';
import { RequestBudget } from '@/lib/utils/request-budget';
import { rejectCrossSite, readJsonBody, LARGE_BODY_LIMIT } from '@/lib/request-guard';
import { currencyCodeSchema, googlePlayBasePlanIdSchema, googlePlaySkuSchema, regionCodeSchema } from '@/lib/validation';

// POST /api/bulk: one operation (percentage, fixed price, round) on the
// existing prices of several Google Play products or base plans.
//
// Two steps, so nothing is written that wasn't shown:
// 1. { ..., dryRun: true } reads the products and returns, per product or
//    base plan, every region's current price (`oldPrice`) and the price the
//    operation gives (`newPrice`). Nothing is written.
// 2. The same request with `expectedPrices` ({ "<id>" or "<id>/<basePlanId>":
//    { "<region>": "<oldPrice from the preview>" } }) writes only the regions
//    listed there whose price is still exactly what the preview showed;
//    a region whose price has changed since, or that the preview didn't list,
//    is left alone and reported (PRICE_CHANGED / NOT_PREVIEWED).
//
// "fixed" sets one amount in one currency (`currency`); regions billed in
// another currency are left alone, never converted.
//
// The previewed prices are checked twice: against this request's read, and
// again by the write helper against its own fresh read just before the PATCH
// (`expected`), so a price changed in between refuses the write
// (PRICE_CHANGED). Items are deduplicated on product / base plan, so no base
// plan is written twice in one request; what was dropped is listed in
// `duplicates`.

type SkippedRegion = { regionCode: string; reason: string; code?: 'NO_PRICE' | 'OTHER_CURRENCY' | 'PRICE_CHANGED' | 'NOT_PREVIEWED' };

const NO_EXISTING_PRICE = 'No existing price in this region (bulk update only changes existing prices)';
const PRICE_CHANGED = 'The price changed since the preview; preview again';
const NOT_PREVIEWED = 'Not in the preview this update was confirmed against';

const bulkOperationSchema = z
  .object({
    type: z.enum(['fixed', 'percentage', 'round']),
    value: z.number().finite().min(-99, 'Percentage cannot reduce price by more than 99%').max(10000, 'Value cannot exceed 10000').optional(),
    /** Required for "fixed": the currency of `value` */
    currency: currencyCodeSchema.optional(),
    roundTo: z.number().min(0, 'Round-to value must be non-negative').max(0.99, 'Round-to value must be at most 0.99').optional(),
  })
  .superRefine((op, ctx) => {
    if (op.type === 'fixed') {
      if (op.value === undefined || op.value < 0) ctx.addIssue({ code: 'custom', path: ['value'], message: 'A fixed price must be 0 or more' });
      if (!op.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'A fixed price needs its currency; only regions billed in it are changed' });
    }
    if (op.type === 'percentage' && op.value === undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage change needs a value' });
  });

const bulkUpdateSchema = z.object({
  items: z
    .array(
      z.object({
        type: z.enum(['product', 'subscription']),
        id: googlePlaySkuSchema,
        basePlanId: googlePlayBasePlanIdSchema.optional(),
      })
    )
    .min(1, 'At least one item is required')
    .max(100, 'Maximum 100 items per bulk update'),
  operation: bulkOperationSchema,
  targetRegions: z
    .array(regionCodeSchema)
    .min(1, 'At least one target region is required')
    .max(200, 'Maximum 200 target regions per bulk update')
    .transform((regions) => [...new Set(regions)]),
  stopOnFailure: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
  /** Required unless dryRun: the preview's oldPrice per item and region */
  expectedPrices: z.record(z.string().max(320), z.record(regionCodeSchema, z.string().max(64))).optional(),
});

type BulkOperation = z.infer<typeof bulkOperationSchema>;

/** A Money as "<currency> <exact decimal>", e.g. "USD 9.99"; never through floating point */
function formatMoney(money: Money): string {
  const nanos = money.nanos ? String(money.nanos).padStart(9, '0').replace(/0+$/, '') : '';
  return `${money.currencyCode} ${money.units}${nanos ? `.${nanos}` : ''}`;
}

interface RegionPlan {
  changes: Array<{ regionCode: string; oldPrice: string; newPrice: string; price: Money; current: Money }>;
  skippedRegions: SkippedRegion[];
}

/** What the operation does to each target region of one product or base plan */
function planRegions(prices: Record<string, Money | undefined>, targetRegions: string[], operation: BulkOperation): RegionPlan {
  const plan: RegionPlan = { changes: [], skippedRegions: [] };
  for (const regionCode of targetRegions) {
    const current = prices[regionCode];
    if (!current) {
      plan.skippedRegions.push({ regionCode, reason: NO_EXISTING_PRICE, code: 'NO_PRICE' });
      continue;
    }
    if (operation.type === 'fixed' && current.currencyCode !== operation.currency) {
      plan.skippedRegions.push({
        regionCode,
        reason: `Billed in ${current.currencyCode}, not ${operation.currency}: a fixed price is never converted`,
        code: 'OTHER_CURRENCY',
      });
      continue;
    }
    const price = calculateNewPrice(current, operation);
    plan.changes.push({ regionCode, oldPrice: formatMoney(current), newPrice: formatMoney(price), price, current });
  }
  return plan;
}

/** Keeps only regions whose current price is still what the preview showed */
function confirmedAgainst(plan: RegionPlan, expected: Record<string, string> | undefined): RegionPlan {
  const out: RegionPlan = { changes: [], skippedRegions: [...plan.skippedRegions] };
  for (const change of plan.changes) {
    const previewed = expected?.[change.regionCode];
    if (previewed === undefined) out.skippedRegions.push({ regionCode: change.regionCode, reason: NOT_PREVIEWED, code: 'NOT_PREVIEWED' });
    else if (previewed !== change.oldPrice) out.skippedRegions.push({ regionCode: change.regionCode, reason: PRICE_CHANGED, code: 'PRICE_CHANGED' });
    else out.changes.push(change);
  }
  return out;
}

type BulkResult = {
  id: string;
  basePlanId?: string;
  success: boolean;
  committed: boolean;
  error?: string;
  changes?: Array<{ regionCode: string; oldPrice: string; newPrice: string }>;
  /** Target regions left unchanged, with the reason */
  skippedRegions?: SkippedRegion[];
};

/** An item or base plan left out because the request already covers it */
type DroppedDuplicate = {
  type: 'product' | 'subscription';
  id: string;
  basePlanId?: string;
  /** REPEATED_ITEM: the same item twice; BASE_PLAN_COVERED: a base plan an earlier item already handled */
  reason: 'REPEATED_ITEM' | 'BASE_PLAN_COVERED';
};

export async function POST(request: NextRequest) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const auth = await getGoogleAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const read = await readJsonBody(request, LARGE_BODY_LIMIT);
    if (!read.ok) return read.response;
    const result = bulkUpdateSchema.safeParse(read.body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const { items, operation, targetRegions, stopOnFailure, dryRun, expectedPrices } = result.data;
    if (!dryRun && !expectedPrices) {
      return NextResponse.json(
        { error: 'Preview first: send dryRun: true, then the same request with expectedPrices from the preview' },
        { status: 400 }
      );
    }
    // One request budget for the whole bulk run
    const ctx = { budget: new RequestBudget() };

    const results: BulkResult[] = [];
    let stopped = false;
    // Each product / base plan at most once per request (first occurrence wins)
    const seen = new Set<string>();
    const firstTime = (key: string) => (seen.has(key) ? false : (seen.add(key), true));
    const duplicates: DroppedDuplicate[] = [];

    /** Plans one product or base plan, writes it unless this is a dry run, and records the result */
    const run = async (
      key: string,
      head: { id: string; basePlanId?: string },
      prices: Record<string, Money | undefined>,
      write: (plan: RegionPlan) => Promise<unknown>
    ) => {
      const planned = planRegions(prices, targetRegions, operation);
      const plan = dryRun ? planned : confirmedAgainst(planned, expectedPrices?.[key]);
      const changes = plan.changes.map(({ regionCode, oldPrice, newPrice }) => ({ regionCode, oldPrice, newPrice }));
      const skipped = plan.skippedRegions.length > 0 ? { skippedRegions: plan.skippedRegions } : {};
      if (!firstTime(key)) {
        // already handled in this request (a subscription item and one of its base plans)
        duplicates.push({ type: head.basePlanId ? 'subscription' : 'product', ...head, reason: 'BASE_PLAN_COVERED' });
        return;
      }
      // Nothing to write is a failure, not a successful no-op
      if (plan.changes.length === 0) {
        results.push({ ...head, success: false, committed: false, error: 'None of the target regions can be changed', ...skipped });
        if (stopOnFailure) stopped = true;
        return;
      }
      if (!dryRun) await write(plan);
      results.push({ ...head, success: true, committed: !dryRun, changes, ...skipped });
    };

    const uniqueItems = items.filter((item) => {
      if (firstTime(`${item.type}:${item.id}/${item.basePlanId ?? '*'}`)) return true;
      duplicates.push({ type: item.type, id: item.id, ...(item.basePlanId ? { basePlanId: item.basePlanId } : {}), reason: 'REPEATED_ITEM' });
      return false;
    });
    seen.clear();
    for (const item of uniqueItems) {
      if (stopped) {
        results.push({ id: item.id, basePlanId: item.basePlanId, success: false, committed: false, error: 'Skipped due to earlier failure (stopOnFailure)' });
        continue;
      }

      try {
        if (item.type === 'product') {
          const product = await getInAppProduct(auth.credentials, auth.packageName, item.id, ctx);
          if (!product) {
            results.push({ id: item.id, success: false, committed: false, error: 'Product not found' });
            if (stopOnFailure) stopped = true;
            continue;
          }
          await run(item.id, { id: item.id }, product.prices ?? {}, (plan) =>
            updateInAppProductPrices(
              auth.credentials,
              auth.packageName,
              item.id,
              Object.fromEntries(plan.changes.map((c) => [c.regionCode, c.price])),
              undefined,
              ctx,
              { expected: Object.fromEntries(plan.changes.map((c) => [c.regionCode, c.current])) }
            )
          );
        } else {
          const subscription = await getSubscription(auth.credentials, auth.packageName, item.id, ctx);
          if (!subscription) {
            results.push({ id: item.id, basePlanId: item.basePlanId, success: false, committed: false, error: 'Subscription not found' });
            if (stopOnFailure) stopped = true;
            continue;
          }

          // Without a basePlanId the item expands to every base plan of the
          // subscription, each reported as its own result
          const basePlans = item.basePlanId
            ? (subscription.basePlans ?? []).filter((bp) => bp.basePlanId === item.basePlanId)
            : subscription.basePlans ?? [];

          if (basePlans.length === 0) {
            results.push({
              id: item.id,
              basePlanId: item.basePlanId,
              success: false,
              committed: false,
              error: item.basePlanId ? 'Base plan not found' : 'Subscription has no base plans',
            });
            if (stopOnFailure) stopped = true;
            continue;
          }

          for (const basePlan of basePlans) {
            const head = { id: item.id, basePlanId: basePlan.basePlanId };
            if (stopped) {
              results.push({ ...head, success: false, committed: false, error: 'Skipped due to earlier failure (stopOnFailure)' });
              continue;
            }
            try {
              const configs = new Map((basePlan.regionalConfigs ?? []).map((rc) => [rc.regionCode, rc]));
              const prices = Object.fromEntries([...configs].map(([region, rc]) => [region, rc.price]));
              await run(`${item.id}/${basePlan.basePlanId}`, head, prices, (plan) => {
                // Same price maths as products; everything else in the config is sent back as fetched
                const newConfigs: RegionalBasePlanConfig[] = plan.changes.map((c) => ({ ...configs.get(c.regionCode)!, price: c.price }));
                return updateBasePlanPrices(auth.credentials, auth.packageName, item.id, basePlan.basePlanId, newConfigs, ctx, {
                  expected: Object.fromEntries(plan.changes.map((c) => [c.regionCode, c.current])),
                });
              });
            } catch (error) {
              // One failing base plan must not hide the outcome of the others
              results.push({ ...head, success: false, committed: false, error: toApiError(error, 'google').message });
              if (stopOnFailure) stopped = true;
            }
          }
        }
      } catch (error) {
        results.push({ id: item.id, basePlanId: item.basePlanId, success: false, committed: false, error: toApiError(error, 'google').message });
        if (stopOnFailure) stopped = true;
      }
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const committed = results.filter((r) => r.committed).length;
    const skipped = results.filter((r) => !r.success && r.error?.includes('Skipped')).length;
    const skippedRegions = results.reduce((n, r) => n + (r.skippedRegions?.length ?? 0), 0);

    return NextResponse.json({
      success: failed === 0 && successful > 0,
      ...(dryRun ? { dryRun: true } : {}),
      // One result per product / base plan (subscriptions expand to base plans)
      total: results.length,
      successful,
      failed,
      committed,
      skippedRegions,
      ...(stopped ? { stoppedEarly: true, skipped } : {}),
      // Items and base plans dropped because the request already covers them
      ...(duplicates.length > 0 ? { duplicates } : {}),
      results,
    });
  } catch (error) {
    console.error('Bulk update error:', error);
    return NextResponse.json(
      { error: 'Failed to perform bulk update' },
      { status: 500 }
    );
  }
}
