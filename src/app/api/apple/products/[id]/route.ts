import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import {
  getInAppPurchase,
  getBaseTerritoryForProduct,
  getInAppPurchasePrices,
  updateInAppPurchasePrice,
  updateInAppPurchasePrices,
  resolvePPPPricesToPricePoints,
  type PPPResolutionResult,
} from '@/lib/apple-connect';
import { appleErrorResponse, getAppleErrorMessage } from '../../_lib/error-response';
import {
  validateAndDecodeAppleProductId,
  ValidationError,
  regionCodeSchema,
  currencyCodeSchema,
} from '@/lib/validation';
import { RequestBudget } from '@/lib/utils/request-budget';
import { mapWithConcurrency } from '@/lib/pricing/concurrency';

// GET /api/apple/products/[id] - Get a single product with prices
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Validate and decode product ID
    let productId: string;
    try {
      productId = validateAndDecodeAppleProductId(id);
    } catch (error) {
      if (error instanceof ValidationError) {
        return NextResponse.json(
          { error: error.message, details: error.details },
          { status: 400 }
        );
      }
      throw error;
    }

    const product = await getInAppPurchase(auth.credentials, productId);
    if (!product) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      );
    }

    // Fetch prices and base territory in parallel
    const [prices, baseTerritory] = await Promise.all([
      getInAppPurchasePrices(auth.credentials, product.id),
      getBaseTerritoryForProduct(auth.credentials, product.id),
    ]);
    product.prices = prices;
    product.baseTerritory = baseTerritory ?? undefined;

    return NextResponse.json({ product });
  } catch (error) {
    console.error('Error fetching Apple product:', error);

    return appleErrorResponse(error, 'Failed to fetch product');
  }
}

// Schema for price update - supports both pricePointId and Money format
const updatePriceSchema = z.object({
  prices: z.record(
    regionCodeSchema,
    z.union([
      // Format 1: Direct price point ID
      z.object({
        pricePointId: z.string().min(1),
        startDate: z.string().optional(),
      }),
      // Format 2: Money format (from bulk pricing modal)
      z.object({
        currencyCode: currencyCodeSchema,
        units: z.string().regex(/^-?\d+$/, 'Units must be a numeric string'),
        nanos: z.number().int().min(-999999999).max(999999999).optional(),
      }),
    ])
  ),
  defaultPrice: z.object({
    currencyCode: currencyCodeSchema,
    units: z.string().regex(/^-?\d+$/, 'Units must be a numeric string'),
    nanos: z.number().int().min(-999999999).max(999999999).optional(),
  }).optional(),
});

// PATCH /api/apple/products/[id] - Update product prices
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const { id } = await params;
    // One budget for the whole run (Apple allows ~3600 requests/hour per key)
    const ctx = { budget: new RequestBudget() };

    // Validate and decode product ID
    let productId: string;
    try {
      productId = validateAndDecodeAppleProductId(id);
    } catch (error) {
      if (error instanceof ValidationError) {
        return NextResponse.json(
          { error: error.message, details: error.details },
          { status: 400 }
        );
      }
      throw error;
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
    const result = updatePriceSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    // Get the product to find its internal ID
    const product = await getInAppPurchase(auth.credentials, productId, ctx);
    if (!product) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      );
    }

    // Fetch base territory from Apple's dedicated endpoint
    product.baseTerritory =
      (await getBaseTerritoryForProduct(auth.credentials, product.id, ctx)) ?? undefined;

    // Update prices
    const { prices } = result.data;

    // Check if any price uses Money format (vs pricePointId format)
    const usesMoneyFormat = Object.values(prices).some(p => 'currencyCode' in p);

    // Track skipped territories for response
    let skippedTerritories: string[] = [];
    let updatedCount = 0;

    if (usesMoneyFormat) {
      // Money format - process ALL territories with PPP pricing
      // Filter to only Money format prices
      const moneyPrices: Record<string, { currencyCode: string; units: string; nanos?: number }> = {};
      for (const [territoryCode, price] of Object.entries(prices)) {
        if ('currencyCode' in price) {
          moneyPrices[territoryCode] = price;
        }
      }

      if (Object.keys(moneyPrices).length === 0) {
        return NextResponse.json(
          { error: 'No valid prices provided' },
          { status: 400 }
        );
      }

      // Ensure base territory is included. Only a product with no price
      // schedule yet has no base territory (read errors are thrown above);
      // a new schedule uses USA as its base
      const baseTerritory = product.baseTerritory || 'USA';
      if (!moneyPrices[baseTerritory]) {
        return NextResponse.json(
          { error: `${baseTerritory} price required when using calculated prices. Apple uses ${baseTerritory} as the base territory.` },
          { status: 400 }
        );
      }

      // Resolve all PPP prices to price points (batched parallel requests)
      const result: PPPResolutionResult = await resolvePPPPricesToPricePoints(
        auth.credentials,
        product.id,
        moneyPrices,
        ctx
      );

      skippedTerritories = result.skipped;

      if (result.resolved.length === 0) {
        return NextResponse.json(
          {
            error: 'Could not resolve any price points',
            skipped: result.skipped
          },
          { status: 400 }
        );
      }


      // Update all prices at once
      await updateInAppPurchasePrices(
        auth.credentials,
        product.id,
        result.resolved,
        baseTerritory,
        ctx
      );

      updatedCount = result.resolved.length;
    } else {
      // Direct pricePointId format - update each territory, one at a time
      const updates = Object.entries(prices).flatMap(([territoryCode, priceData]) =>
        'pricePointId' in priceData ? [{ territoryCode, ...priceData }] : []
      );

      await mapWithConcurrency(updates, 1, (update) =>
        updateInAppPurchasePrice(
          auth.credentials,
          product.id,
          update.pricePointId,
          update.territoryCode,
          update.startDate,
          ctx
        )
      );
      updatedCount = updates.length;
    }

    // Fetch updated product. The write is already done, so a failed refresh
    // is reported alongside the result rather than as a failure
    let updatedProduct: Awaited<ReturnType<typeof getInAppPurchase>> = null;
    let refreshError: string | undefined;
    try {
      updatedProduct = await getInAppPurchase(auth.credentials, productId, ctx);
      if (updatedProduct) {
        const [updatedPrices, updatedBaseTerritory] = await Promise.all([
          getInAppPurchasePrices(auth.credentials, updatedProduct.id, ctx),
          getBaseTerritoryForProduct(auth.credentials, updatedProduct.id, ctx),
        ]);
        updatedProduct.prices = updatedPrices;
        updatedProduct.baseTerritory = updatedBaseTerritory ?? undefined;
      }
    } catch (error) {
      console.error('Error refreshing Apple product after update:', error);
      updatedProduct = null;
      refreshError = getAppleErrorMessage(error, 'Could not reload prices after the update');
    }

    return NextResponse.json({
      success: true,
      product: updatedProduct,
      updated: updatedCount,
      skipped: skippedTerritories,
      ...(refreshError ? { refreshError } : {}),
    });
  } catch (error) {
    console.error('Error updating Apple product:', error);

    return appleErrorResponse(error, 'Failed to update prices');
  }
}
