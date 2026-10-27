import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies, getGoogleAuthFromCookies } from '@/middleware/auth';
import { appleKeyConnection, GoogleKeyTokenSource } from '@/lib/key-token-source';
import { APP_MISMATCH, assertSubscriptionInApp } from '@/lib/apple-connect/ownership';
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
import { priceExportToPricesCsv } from '@/lib/pricing/prices-csv';
import {
  appleInternalIdSchema,
  appleProductIdSchema,
  googlePlayBasePlanIdSchema,
  googlePlaySkuSchema,
} from '@/lib/validation';

// GET /api/export?platform=google|apple&type=inapp|subscription&id=...&basePlanId=...&format=json|csv|prices-csv
// prices-csv: the pricingkit.prices CSV the CLI imports as fixed targets (pricesFile)
// Read-only snapshot of current prices. This route only exports GET and only
// calls store read functions; it never writes to a store.

const querySchema = z
  .object({
    platform: z.enum(['google', 'apple']),
    type: z.enum(['inapp', 'subscription']),
    id: z.string().min(1),
    basePlanId: googlePlayBasePlanIdSchema.optional(),
    format: z.enum(['json', 'csv', 'prices-csv']).default('json'),
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
  const auth = await getGoogleAuthFromCookies();
  if (!auth) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const tokens = new GoogleKeyTokenSource(auth.credentials);

  if (query.type === 'inapp') {
    let product;
    try {
      product = await getInAppProductRaw(tokens, auth.packageName, query.id);
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

  const subscription = await getGoogleSubscription(tokens, auth.packageName, query.id);
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
// status in GET) or as an empty price list (from readers that swallow API
// errors, or a product with no price schedule yet). An empty list is refused
// either way: an empty "backup" is worse than no backup.
const APPLE_EMPTY_PRICES_ERROR =
  'App Store Connect returned no prices for this product (none are set, or the read failed). Nothing was exported.';

const APPLE_BASE_TERRITORY_ERROR =
  'Could not read the base territory for this product from App Store Connect. Nothing was exported.';

// The base territory is part of the export, so a failed lookup fails the
// whole export rather than guessing (it used to fall back to USA silently).
async function getAppleBaseTerritory(
  connection: Parameters<typeof getBaseTerritoryForProduct>[0],
  inAppPurchaseId: string
): Promise<string | null> {
  try {
    return await getBaseTerritoryForProduct(connection, inAppPurchaseId);
  } catch (error) {
    console.error('Price export: base territory lookup failed:', error);
    // Keep auth/rate-limit statuses; anything else is a bad upstream read
    const status = errorStatus(error);
    throw new ExportHttpError(
      status === 401 || status === 403 || status === 429 ? status : 502,
      APPLE_BASE_TERRITORY_ERROR
    );
  }
}

async function buildAppleExport(query: ExportQuery): Promise<PriceExport | Response> {
  const auth = await getAppleAuthFromCookies();
  if (!auth) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const connection = appleKeyConnection(auth.credentials);

  if (query.type === 'inapp') {
    const product = await getInAppPurchase(connection, query.id);
    if (!product) throw new ExportHttpError(404, 'Product not found');

    const [prices, baseTerritory] = await Promise.all([
      getInAppPurchasePrices(connection, product.id),
      getAppleBaseTerritory(connection, product.id),
    ]);
    if (Object.keys(prices).length === 0) throw new ExportHttpError(502, APPLE_EMPTY_PRICES_ERROR);
    // Prices exist, so a price schedule (and its base territory) must too
    if (!baseTerritory) throw new ExportHttpError(502, APPLE_BASE_TERRITORY_ERROR);

    return appleInAppPurchaseToExport(auth.bundleId, {
      id: product.id,
      productId: product.productId,
      baseTerritory,
      prices,
    });
  }

  if (/^\d+$/.test(query.id)) {
    // API keys reach every app of a team: a numeric ID could be another app's
    // subscription, which would be exported under this app's bundle ID
    try {
      await assertSubscriptionInApp(connection, query.id);
    } catch (error) {
      if ((error as { code?: unknown }).code === APP_MISMATCH) throw new ExportHttpError(409, 'This subscription belongs to another app');
      throw error;
    }
  }
  const subscription = /^\d+$/.test(query.id)
    ? await getAppleSubscriptionById(connection, query.id)
    : await getAppleSubscription(connection, query.id);
  if (!subscription) throw new ExportHttpError(404, 'Subscription not found');

  const prices = await getAppleSubscriptionPrices(connection, subscription.id);
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

    const body = query.format === 'csv' ? priceExportToCsv(result) : query.format === 'prices-csv' ? priceExportToPricesCsv(result) : priceExportToJson(result);
    const filename = query.format === 'prices-csv' ? buildExportFilename(result, 'csv').replace(/\.csv$/, '.prices.csv') : buildExportFilename(result, query.format);

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type':
          query.format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
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
