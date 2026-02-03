import { NextResponse } from 'next/server';
import { getPPPMultipliers } from '@/lib/world-bank/ppp';
import { PRICING_INDEX, DEFAULT_PRICING_INDEX_ENTRY } from '@/lib/conversion-indexes/ppp';
import { BIG_MAC_INDEX, DEFAULT_BIG_MAC_MULTIPLIER } from '@/lib/conversion-indexes/big-mac';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';

  try {
    const pppData = await getPPPMultipliers(forceRefresh);

    // Merge World Bank data with our static pricing index (for min prices, rounding, etc.)
    const mergedData: Record<string, {
      pppMultiplier: number;
      pppConversionFactor?: number;
      bigMacMultiplier?: number;
      minPrice: number;
      suggestedRounding: number;
      source: 'world-bank' | 'static';
    }> = {};

    // Start with static data
    for (const [regionCode, entry] of Object.entries(PRICING_INDEX)) {
      mergedData[regionCode] = {
        pppMultiplier: entry.pppMultiplier,
        bigMacMultiplier: BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER,
        minPrice: entry.minPrice,
        suggestedRounding: entry.suggestedRounding,
        source: 'static',
      };
    }

    // Override with World Bank data where available
    for (const [regionCode, multiplier] of Object.entries(pppData.multipliers)) {
      const conversionFactor = pppData.pppConversionFactors[regionCode];

      if (mergedData[regionCode]) {
        mergedData[regionCode].pppMultiplier = multiplier;
        mergedData[regionCode].pppConversionFactor = conversionFactor;
        mergedData[regionCode].source = 'world-bank';
      } else {
        // New region from World Bank not in our static data
        mergedData[regionCode] = {
          pppMultiplier: multiplier,
          pppConversionFactor: conversionFactor,
          bigMacMultiplier: BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER,
          minPrice: DEFAULT_PRICING_INDEX_ENTRY.minPrice,
          suggestedRounding: DEFAULT_PRICING_INDEX_ENTRY.suggestedRounding,
          source: 'world-bank',
        };
      }
    }

    return NextResponse.json({
      success: true,
      data: mergedData,
      metadata: {
        baseYear: pppData.baseYear,
        fetchedAt: pppData.fetchedAt.toISOString(),
        worldBankRegions: Object.keys(pppData.multipliers).length,
        totalRegions: Object.keys(mergedData).length,
      },
    });
  } catch (error) {
    console.error('PPP API error:', error);

    // Fallback to static data
    const staticData: Record<string, {
      pppMultiplier: number;
      bigMacMultiplier?: number;
      minPrice: number;
      suggestedRounding: number;
      source: 'static';
    }> = {};

    for (const [regionCode, entry] of Object.entries(PRICING_INDEX)) {
      staticData[regionCode] = {
        pppMultiplier: entry.pppMultiplier,
        bigMacMultiplier: BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER,
        minPrice: entry.minPrice,
        suggestedRounding: entry.suggestedRounding,
        source: 'static',
      };
    }

    return NextResponse.json({
      success: true,
      data: staticData,
      metadata: {
        baseYear: null,
        fetchedAt: new Date().toISOString(),
        worldBankRegions: 0,
        totalRegions: Object.keys(staticData).length,
        fallback: true,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
}
