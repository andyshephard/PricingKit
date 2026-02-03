import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '../../auth/route';
import {
  getInAppPurchase,
  getInAppPurchasePrices,
  updateInAppPurchasePrice,
  updateInAppPurchasePrices,
  resolvePPPPricesToPricePoints,
  AppleApiError,
  type PPPResolutionResult,
} from '@/lib/apple-connect';
import {
  validateAndDecodeAppleProductId,
  ValidationError,
  regionCodeSchema,
  currencyCodeSchema,
} from '@/lib/validation';

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

    // Fetch prices for this product
    const prices = await getInAppPurchasePrices(auth.credentials, product.id);
    product.prices = prices;

    return NextResponse.json({ product });
  } catch (error) {
    console.error('Error fetching Apple product:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to fetch product' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch product' },
      { status: 500 }
    );
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

    const body = await request.json();
    const result = updatePriceSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    // Get the product to find its internal ID
    const product = await getInAppPurchase(auth.credentials, productId);
    if (!product) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      );
    }

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

      // Ensure USA is included as base territory
      if (!moneyPrices['USA']) {
        return NextResponse.json(
          { error: 'USA price required when using calculated prices. Apple uses USA as the base territory.' },
          { status: 400 }
        );
      }

      console.log(`[Apple PATCH] Processing PPP prices for ${Object.keys(moneyPrices).length} territories`);

      // Resolve all PPP prices to price points (batched parallel requests)
      const result: PPPResolutionResult = await resolvePPPPricesToPricePoints(
        auth.credentials,
        product.id,
        moneyPrices
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

      if (result.skipped.length > 0) {
        console.warn(`[Apple PATCH] Skipped ${result.skipped.length} territories:`, result.skipped);
      }

      console.log(`[Apple PATCH] Resolved ${result.resolved.length} price points, sending to Apple API`);

      // Update all prices at once
      await updateInAppPurchasePrices(
        auth.credentials,
        product.id,
        result.resolved,
        'USA' // Base territory
      );

      updatedCount = result.resolved.length;
      console.log(`[Apple PATCH] Successfully updated ${result.resolved.length} manual prices`);
    } else {
      // Direct pricePointId format - update each territory
      const updates: Promise<void>[] = [];

      for (const [territoryCode, priceData] of Object.entries(prices)) {
        if ('pricePointId' in priceData) {
          updates.push(
            updateInAppPurchasePrice(
              auth.credentials,
              product.id,
              priceData.pricePointId,
              territoryCode,
              priceData.startDate
            )
          );
        }
      }

      await Promise.all(updates);
      updatedCount = updates.length;
    }

    // Fetch updated product
    const updatedProduct = await getInAppPurchase(auth.credentials, productId);
    if (updatedProduct) {
      updatedProduct.prices = await getInAppPurchasePrices(
        auth.credentials,
        updatedProduct.id
      );
    }

    return NextResponse.json({
      success: true,
      product: updatedProduct,
      updated: updatedCount,
      skipped: skippedTerritories,
    });
  } catch (error) {
    console.error('Error updating Apple product:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to update product' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: `Failed to update prices: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
