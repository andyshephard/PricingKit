import { NextResponse } from 'next/server';
import { getPPPMultipliers } from '@/lib/world-bank/ppp';
import { PRICING_INDEX, DEFAULT_PRICING_INDEX_ENTRY, LOCAL_CURRENCIES } from '@/lib/conversion-indexes/ppp';
import { BIG_MAC_INDEX, DEFAULT_BIG_MAC_MULTIPLIER } from '@/lib/conversion-indexes/big-mac';
import { getExchangeRates } from '@/lib/exchange-rates/client';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';

  try {
    // Fetch both PPP data and Market Exchange Rates in parallel
    const [pppData, exchangeRates] = await Promise.all([
      getPPPMultipliers(forceRefresh),
      getExchangeRates(forceRefresh)
    ]);

    // Merge World Bank data with our static pricing index (for min prices, rounding, etc.)
    const mergedData: Record<string, {
      pppMultiplier: number;
      pppConversionFactor?: number;
      marketExchangeRate?: number;
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

    // Override with World Bank data and calculate REAL PPP multipliers
    for (const [regionCode, multiplier] of Object.entries(pppData.multipliers)) {
      const conversionFactor = pppData.pppConversionFactors[regionCode];
      const currencyCode = LOCAL_CURRENCIES[regionCode];
      const marketRate = exchangeRates.rates[currencyCode];

      // Calculate the real PPP multiplier: PPP_Factor / Market_Rate
      // This tells us how much to adjust the market-converted price
      let realPPPMultiplier = multiplier; // Fallback to US-relative
      if (marketRate && conversionFactor) {
        realPPPMultiplier = conversionFactor / marketRate;
        // Clamp to reasonable bounds
        realPPPMultiplier = Math.max(0.1, Math.min(2.0, realPPPMultiplier));
      }

      if (mergedData[regionCode]) {
        mergedData[regionCode].pppMultiplier = realPPPMultiplier;
        mergedData[regionCode].pppConversionFactor = conversionFactor;
        mergedData[regionCode].marketExchangeRate = marketRate;
        mergedData[regionCode].source = 'world-bank';
      } else {
        // New region from World Bank not in our static data
        mergedData[regionCode] = {
          pppMultiplier: realPPPMultiplier,
          pppConversionFactor: conversionFactor,
          marketExchangeRate: marketRate,
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
