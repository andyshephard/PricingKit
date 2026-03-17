import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '../auth/route';
import {
  getAppPrices,
  updateAppPriceSchedule,
  resolveAppPricesToPricePoints,
  AppleApiError,
} from '@/lib/apple-connect';
import { regionCodeSchema, currencyCodeSchema } from '@/lib/validation';

// GET /api/apple/app-price — fetch app price schedule + all territory prices
export async function GET() {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { manual, automatic, baseTerritory } = await getAppPrices(auth.credentials);

    // Merge manual and automatic prices (manual takes precedence)
    const prices: Record<string, (typeof manual)[string]> = { ...automatic, ...manual };

    return NextResponse.json({
      prices,
      baseTerritory,
      hasSchedule: Object.keys(prices).length > 0,
    });
  } catch (error) {
    console.error('Error fetching app price:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to fetch app price' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch app price' },
      { status: 500 }
    );
  }
}

// Schema for price update
const updateAppPriceSchema = z.object({
  prices: z.record(
    regionCodeSchema,
    z.union([
      // Direct price point ID
      z.object({
        pricePointId: z.string().min(1),
      }),
      // Money format (from bulk pricing modal)
      z.object({
        currencyCode: currencyCodeSchema,
        units: z.string().regex(/^-?\d+$/, 'Units must be a numeric string'),
        nanos: z.number().int().min(-999999999).max(999999999).optional(),
      }),
    ])
  ),
  baseTerritoryId: z.string().min(1).optional(),
});

// PATCH /api/apple/app-price — update app price schedule
export async function PATCH(request: NextRequest) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
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

    const result = updateAppPriceSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const { prices, baseTerritoryId = 'USA' } = result.data;

    // Check if any price uses Money format
    const usesMoneyFormat = Object.values(prices).some((p) => 'currencyCode' in p);

    let manualPrices: Array<{ territoryId: string; pricePointId: string }>;
    let skippedTerritories: string[] = [];

    if (usesMoneyFormat) {
      // Resolve Money format to price points
      const moneyPrices: Record<string, { currencyCode: string; units: string; nanos?: number }> = {};
      for (const [territoryCode, price] of Object.entries(prices)) {
        if ('currencyCode' in price) {
          moneyPrices[territoryCode] = price;
        }
      }

      if (Object.keys(moneyPrices).length === 0) {
        return NextResponse.json({ error: 'No valid prices provided' }, { status: 400 });
      }

      if (!moneyPrices[baseTerritoryId]) {
        return NextResponse.json(
          { error: `${baseTerritoryId} price required. Apple uses ${baseTerritoryId} as the base territory.` },
          { status: 400 }
        );
      }

      const resolution = await resolveAppPricesToPricePoints(auth.credentials, moneyPrices);
      skippedTerritories = resolution.skipped;

      if (resolution.resolved.length === 0) {
        return NextResponse.json(
          { error: 'Could not resolve any price points', skipped: resolution.skipped },
          { status: 400 }
        );
      }

      manualPrices = resolution.resolved;
    } else {
      // Direct pricePointId format
      manualPrices = Object.entries(prices).map(([territoryId, price]) => ({
        territoryId,
        pricePointId: (price as { pricePointId: string }).pricePointId,
      }));
    }

    await updateAppPriceSchedule(auth.credentials, manualPrices, baseTerritoryId);

    // Fetch updated prices
    const updated = await getAppPrices(auth.credentials);
    const allPrices = { ...updated.automatic, ...updated.manual };

    return NextResponse.json({
      success: true,
      prices: allPrices,
      baseTerritory: updated.baseTerritory,
      updated: manualPrices.length,
      skipped: skippedTerritories,
    });
  } catch (error) {
    console.error('Error updating app price:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to update app price' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: `Failed to update app price: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
