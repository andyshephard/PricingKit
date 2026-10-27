import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthFromCookies } from '../auth/route';
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

type SkippedRegion = { regionCode: string; reason: string };

const NO_EXISTING_PRICE = 'No existing price in this region (bulk update only changes existing prices)';

const bulkOperationSchema = z.object({
  type: z.enum(['fixed', 'percentage', 'round']),
  value: z.number().min(-99, 'Percentage cannot reduce price by more than 99%').max(10000, 'Value cannot exceed 10000').optional(),
  roundTo: z.number().min(0, 'Round-to value must be non-negative').max(0.99, 'Round-to value must be at most 0.99').optional(),
});

const bulkUpdateSchema = z.object({
  items: z.array(
    z.object({
      type: z.enum(['product', 'subscription']),
      id: z.string(),
      basePlanId: z.string().optional(),
    })
  ).min(1, 'At least one item is required').max(100, 'Maximum 100 items per bulk update'),
  operation: bulkOperationSchema,
  targetRegions: z.array(z.string()).min(1, 'At least one target region is required').max(200, 'Maximum 200 target regions per bulk update'),
  stopOnFailure: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }
    const result = bulkUpdateSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const { items, operation, targetRegions, stopOnFailure } = result.data;

    const results: Array<{
      id: string;
      basePlanId?: string;
      success: boolean;
      committed: boolean;
      error?: string;
      changes?: Array<{
        regionCode: string;
        oldPrice: string;
        newPrice: string;
      }>;
      /** Target regions left unchanged, with the reason */
      skippedRegions?: SkippedRegion[];
    }> = [];

    let stopped = false;

    for (const item of items) {
      if (stopped) {
        results.push({
          id: item.id,
          basePlanId: item.basePlanId,
          success: false,
          committed: false,
          error: 'Skipped due to earlier failure (stopOnFailure)',
        });
        continue;
      }

      try {
        if (item.type === 'product') {
          const product = await getInAppProduct(
            auth.credentials,
            auth.packageName,
            item.id
          );

          if (!product) {
            results.push({
              id: item.id,
              success: false,
              committed: false,
              error: 'Product not found',
            });
            if (stopOnFailure) { stopped = true; }
            continue;
          }

          const changes: Array<{
            regionCode: string;
            oldPrice: string;
            newPrice: string;
          }> = [];
          const newPrices: Record<string, Money> = {};
          const skippedRegions: SkippedRegion[] = [];

          for (const regionCode of targetRegions) {
            const currentPrice = product.prices?.[regionCode];
            if (!currentPrice) {
              skippedRegions.push({ regionCode, reason: NO_EXISTING_PRICE });
              continue;
            }

            const newPrice = calculateNewPrice(currentPrice, operation);
            newPrices[regionCode] = newPrice;

            const oldAmount =
              parseFloat(currentPrice.units) +
              (currentPrice.nanos ? currentPrice.nanos / 1_000_000_000 : 0);
            const newAmount =
              parseFloat(newPrice.units) +
              (newPrice.nanos ? newPrice.nanos / 1_000_000_000 : 0);

            changes.push({
              regionCode,
              oldPrice: `${currentPrice.currencyCode} ${oldAmount.toFixed(2)}`,
              newPrice: `${newPrice.currencyCode} ${newAmount.toFixed(2)}`,
            });
          }

          // Nothing to write is a failure, not a successful no-op
          if (Object.keys(newPrices).length === 0) {
            results.push({
              id: item.id,
              success: false,
              committed: false,
              error: 'None of the target regions have an existing price for this product',
              skippedRegions,
            });
            if (stopOnFailure) { stopped = true; }
            continue;
          }

          await updateInAppProductPrices(
            auth.credentials,
            auth.packageName,
            item.id,
            newPrices
          );

          results.push({
            id: item.id,
            success: true,
            committed: true,
            changes,
            ...(skippedRegions.length > 0 ? { skippedRegions } : {}),
          });
        } else if (item.type === 'subscription') {
          const subscription = await getSubscription(
            auth.credentials,
            auth.packageName,
            item.id
          );

          if (!subscription) {
            results.push({
              id: item.id,
              basePlanId: item.basePlanId,
              success: false,
              committed: false,
              error: 'Subscription not found',
            });
            if (stopOnFailure) { stopped = true; }
            continue;
          }

          // Without a basePlanId the item expands to every base plan of the
          // subscription, each reported as its own result
          const basePlans = item.basePlanId
            ? (subscription.basePlans ?? []).filter(
                (bp) => bp.basePlanId === item.basePlanId
              )
            : subscription.basePlans ?? [];

          if (basePlans.length === 0) {
            results.push({
              id: item.id,
              basePlanId: item.basePlanId,
              success: false,
              committed: false,
              error: item.basePlanId
                ? 'Base plan not found'
                : 'Subscription has no base plans',
            });
            if (stopOnFailure) { stopped = true; }
            continue;
          }

          for (const basePlan of basePlans) {
            if (stopped) {
              results.push({
                id: item.id,
                basePlanId: basePlan.basePlanId,
                success: false,
                committed: false,
                error: 'Skipped due to earlier failure (stopOnFailure)',
              });
              continue;
            }

            try {
              const changes: Array<{
                regionCode: string;
                oldPrice: string;
                newPrice: string;
              }> = [];
              const newConfigs: RegionalBasePlanConfig[] = [];
              const skippedRegions: SkippedRegion[] = [];

              for (const regionCode of targetRegions) {
                const currentConfig = basePlan.regionalConfigs?.find(
                  (rc) => rc.regionCode === regionCode
                );
                if (!currentConfig) {
                  skippedRegions.push({ regionCode, reason: NO_EXISTING_PRICE });
                  continue;
                }

                // Same price maths as products (round never raises, no JPY decimals)
                const newConfig: RegionalBasePlanConfig = {
                  ...currentConfig,
                  price: calculateNewPrice(currentConfig.price, operation),
                };
                newConfigs.push(newConfig);

                const oldAmount =
                  parseFloat(currentConfig.price.units) +
                  (currentConfig.price.nanos
                    ? currentConfig.price.nanos / 1_000_000_000
                    : 0);
                const newAmount =
                  parseFloat(newConfig.price.units) +
                  (newConfig.price.nanos
                    ? newConfig.price.nanos / 1_000_000_000
                    : 0);

                changes.push({
                  regionCode,
                  oldPrice: `${currentConfig.price.currencyCode} ${oldAmount.toFixed(2)}`,
                  newPrice: `${newConfig.price.currencyCode} ${newAmount.toFixed(2)}`,
                });
              }

              // Nothing to write is a failure, not a successful no-op
              if (newConfigs.length === 0) {
                results.push({
                  id: item.id,
                  basePlanId: basePlan.basePlanId,
                  success: false,
                  committed: false,
                  error: 'None of the target regions have an existing price for this base plan',
                  skippedRegions,
                });
                if (stopOnFailure) { stopped = true; }
                continue;
              }

              await updateBasePlanPrices(
                auth.credentials,
                auth.packageName,
                item.id,
                basePlan.basePlanId,
                newConfigs
              );

              results.push({
                id: item.id,
                basePlanId: basePlan.basePlanId,
                success: true,
                committed: true,
                changes,
                ...(skippedRegions.length > 0 ? { skippedRegions } : {}),
              });
            } catch (error) {
              // One failing base plan must not hide the outcome of the others
              results.push({
                id: item.id,
                basePlanId: basePlan.basePlanId,
                success: false,
                committed: false,
                error: toApiError(error, 'google').message,
              });
              if (stopOnFailure) { stopped = true; }
            }
          }
        }
      } catch (error) {
        results.push({
          id: item.id,
          basePlanId: item.basePlanId,
          success: false,
          committed: false,
          error: toApiError(error, 'google').message,
        });
        if (stopOnFailure) { stopped = true; }
      }
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const committed = results.filter((r) => r.committed).length;
    const skipped = results.filter((r) => !r.success && r.error?.includes('Skipped')).length;
    const skippedRegions = results.reduce((n, r) => n + (r.skippedRegions?.length ?? 0), 0);

    return NextResponse.json({
      success: failed === 0 && successful > 0,
      // One result per product / base plan (subscriptions expand to base plans)
      total: results.length,
      successful,
      failed,
      committed,
      skippedRegions,
      ...(stopped ? { stoppedEarly: true, skipped } : {}),
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
