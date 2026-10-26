import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthFromCookies } from '../auth/route';
import { getAppleAuthFromCookies } from '../apple/auth/route';
import { getInAppProductRaw } from '@/lib/google-play/products';
import { getSubscription as getGoogleSubscription } from '@/lib/google-play/subscriptions';
import {
  getInAppPurchase,
  getBaseTerritoryForProduct,
  getInAppPurchasePrices,
  getSubscription as getAppleSubscription,
  getSubscriptionById as getAppleSubscriptionById,
  getSubscriptionPrices as getAppleSubscriptionPrices,
} from '@/lib/apple-connect';
import {
  appleInAppPurchaseToExport,
  appleSubscriptionToExport,
  buildExportFilename,
  googleBasePlanToExport,
  googleOneTimeProductToExport,
  InvalidAmountError,
  priceExportToCsv,
  priceExportToJson,
  type PriceExport,
} from '@/lib/export';
import {
  appleInternalIdSchema,
  appleProductIdSchema,
  googlePlayBasePlanIdSchema,
  googlePlaySkuSchema,
} from '@/lib/validation';

// GET /api/export?platform=google|apple&type=inapp|subscription&id=...&basePlanId=...&format=json|csv
// Read-only snapshot of current prices. This route only exports GET and only
// calls store read functions; it never writes to a store.

const querySchema = z
  .object({
    platform: z.enum(['google', 'apple']),
    type: z.enum(['inapp', 'subscription']),
    id: z.string().min(1),
    basePlanId: googlePlayBasePlanIdSchema.optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .superRefine((query, ctx) => {
    if (query.platform === 'google') {
      if (!googlePlaySkuSchema.safeParse(query.id).success) {
        ctx.addIssue({ code: 'custom', path: ['id'], message: 'Invalid Google Play product ID' });
      }
      if (query.type === 'subscription' && !query.basePlanId) {
        ctx.addIssue({ code: 'custom', path: ['basePlanId'], message: 'basePlanId is required for Google subscriptions' });
      }
    } else {
      const validId =
        appleProductIdSchema.safeParse(query.id).success ||
        (query.type === 'subscription' && appleInternalIdSchema.safeParse(query.id).success);
      if (!validId) {
        ctx.addIssue({ code: 'custom', path: ['id'], message: 'Invalid App Store product ID' });
      }
    }
    if (query.platform === 'apple' && query.basePlanId) {
      ctx.addIssue({ code: 'custom', path: ['basePlanId'], message: 'basePlanId only applies to Google subscriptions' });
    }
  });

type ExportQuery = z.infer<typeof querySchema>;

class ExportHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Reads the HTTP status from any store error shape: `statusCode`
// (AppleApiError), numeric `status` (normalised ApiError) or numeric `code`
// (Google). Duck-typed so it does not depend on which error class the store
// clients throw.
function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { statusCode?: unknown; status?: unknown; code?: unknown };
  for (const value of [e.statusCode, e.status, e.code]) {
    if (typeof value === 'number' && value >= 400 && value < 600) return value;
  }
  return undefined;
}

async function buildGoogleExport(query: ExportQuery): Promise<PriceExport | Response> {
  const auth = await getAuthFromCookies();
  if (!auth) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  if (query.type === 'inapp') {
    let product;
    try {
      product = await getInAppProductRaw(auth.credentials, auth.packageName, query.id);
    } catch (error) {
      if (errorStatus(error) === 404) throw new ExportHttpError(404, 'Product not found');
      throw error;
    }
    const data = googleOneTimeProductToExport(auth.packageName, product);
    if (data.prices.length === 0) {
      throw new ExportHttpError(404, 'Product has no regional prices to export');
    }
    return data;
  }

  const subscription = await getGoogleSubscription(auth.credentials, auth.packageName, query.id);
  if (!subscription) throw new ExportHttpError(404, 'Subscription not found');
  const basePlan = subscription.basePlans?.find((bp) => bp.basePlanId === query.basePlanId);
  if (!basePlan) throw new ExportHttpError(404, 'Base plan not found');

  const data = googleBasePlanToExport(auth.packageName, subscription.productId || query.id, basePlan);
  if (data.prices.length === 0 && !data.otherRegions) {
    throw new ExportHttpError(404, 'Base plan has no regional prices to export');
  }
  return data;
}

// A store read failure may surface either as a thrown error (mapped to its
// status in GET) or, for readers that swallow API errors, as an empty price
// list. Both are treated as a failed read: an empty "backup" is worse than no
// backup.
const APPLE_EMPTY_PRICES_ERROR =
  'App Store Connect returned no prices for this product. Nothing was exported; try again.';

async function buildAppleExport(query: ExportQuery): Promise<PriceExport | Response> {
  const auth = await getAppleAuthFromCookies();
  if (!auth) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  if (query.type === 'inapp') {
    const product = await getInAppPurchase(auth.credentials, query.id);
    if (!product) throw new ExportHttpError(404, 'Product not found');

    const [prices, baseTerritory] = await Promise.all([
      getInAppPurchasePrices(auth.credentials, product.id),
      getBaseTerritoryForProduct(auth.credentials, product.id),
    ]);
    if (Object.keys(prices).length === 0) throw new ExportHttpError(502, APPLE_EMPTY_PRICES_ERROR);

    return appleInAppPurchaseToExport(auth.bundleId, {
      id: product.id,
      productId: product.productId,
      baseTerritory,
      prices,
    });
  }

  const subscription = /^\d+$/.test(query.id)
    ? await getAppleSubscriptionById(auth.credentials, query.id)
    : await getAppleSubscription(auth.credentials, query.id);
  if (!subscription) throw new ExportHttpError(404, 'Subscription not found');

  const prices = await getAppleSubscriptionPrices(auth.credentials, subscription.id);
  if (Object.keys(prices.current).length === 0 && Object.keys(prices.scheduled).length === 0) {
    throw new ExportHttpError(502, APPLE_EMPTY_PRICES_ERROR);
  }

  return appleSubscriptionToExport(auth.bundleId, {
    id: subscription.id,
    productId: subscription.productId,
    prices: prices.current,
    scheduledPrices: prices.scheduled,
  });
}

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid export request', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const query = parsed.data;

  try {
    const result =
      query.platform === 'google' ? await buildGoogleExport(query) : await buildAppleExport(query);
    if (result instanceof Response) return result;

    const body = query.format === 'csv' ? priceExportToCsv(result) : priceExportToJson(result);
    const filename = buildExportFilename(result, query.format);

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type':
          query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ExportHttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof InvalidAmountError) {
      console.error('Price export: unexpected amount from store:', error.message);
      return NextResponse.json(
        { error: 'Store returned a price that could not be exported exactly' },
        { status: 502 }
      );
    }

    console.error('Price export error:', error);
    // Store errors keep their status (401/403/404/429/5xx) so the client can
    // tell auth, missing-product and rate-limit failures apart.
    const status = errorStatus(error) ?? 500;
    return NextResponse.json({ error: 'Failed to export prices' }, { status });
  }
}
