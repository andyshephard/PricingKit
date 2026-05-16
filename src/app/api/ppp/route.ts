import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getPPPMultipliers } from '@/lib/world-bank/ppp';
import { PRICING_INDEX, DEFAULT_PRICING_INDEX_ENTRY, LOCAL_CURRENCIES } from '@/lib/conversion-indexes/ppp';
import { BIG_MAC_INDEX, DEFAULT_BIG_MAC_MULTIPLIER } from '@/lib/conversion-indexes/big-mac';
import { NETFLIX_PRICE_INDEX, DEFAULT_NETFLIX_MULTIPLIER } from '@/lib/conversion-indexes/netflix';
import { getExchangeRates } from '@/lib/exchange-rates/client';
import { FALLBACK_EXCHANGE_RATES } from '@/lib/conversion-indexes/exchange-rates';

const EXCHANGE_RATES_COOKIE = 'exchange_rates_api_key';
const FALLBACK_RATES_SNAPSHOT_DATE = '2026-02-01';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';

  // Pull user-supplied key from cookie (Settings page) so prod works without a
  // Cloudflare secret. Falls back to env var inside getExchangeRates().
  const cookieStore = await cookies();
  const userApiKey = cookieStore.get(EXCHANGE_RATES_COOKIE)?.value;

  // Run both fetches independently so a missing/failed exchange-rates key does
  // not nuke the entire response with static fallback.
  const [pppResult, ratesResult] = await Promise.allSettled([
    getPPPMultipliers(forceRefresh),
    getExchangeRates(forceRefresh, userApiKey),
  ]);

  if (pppResult.status === 'rejected') {
    const error = pppResult.reason;
    console.error('PPP API error:', error);

    const staticData: Record<string, {
      pppMultiplier: number;
      bigMacMultiplier?: number;
      netflixMultiplier?: number;
      minPrice: number;
      suggestedRounding: number;
      source: 'static';
    }> = {};

    for (const [regionCode, entry] of Object.entries(PRICING_INDEX)) {
      staticData[regionCode] = {
        pppMultiplier: entry.pppMultiplier,
        bigMacMultiplier: BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER,
        netflixMultiplier: NETFLIX_PRICE_INDEX[regionCode]?.multiplier ?? DEFAULT_NETFLIX_MULTIPLIER,
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

  const pppData = pppResult.value;
  const exchangeRatesError = ratesResult.status === 'rejected'
    ? (ratesResult.reason instanceof Error ? ratesResult.reason.message : 'Unknown error')
    : null;

  // Three-tier FX chain:
  //   1. Live (openexchangerates.org) — handled inside getExchangeRates.
  //   2. Stale memory/disk cache — also handled inside getExchangeRates.
  //   3. Static snapshot — applied here when the helper still rejects.
  // This keeps realPPPMultiplier = pppFactor / marketRate working even with
  // no live key, instead of falling back to the World Bank US-relative ratio.
  const exchangeRatesSource: 'live' | 'fallback' =
    ratesResult.status === 'fulfilled' ? 'live' : 'fallback';
  const exchangeRates =
    ratesResult.status === 'fulfilled'
      ? ratesResult.value
      : { base: 'USD', rates: FALLBACK_EXCHANGE_RATES };

  if (exchangeRatesError) {
    console.warn(
      `Exchange rates unavailable, falling back to ${FALLBACK_RATES_SNAPSHOT_DATE} snapshot:`,
      exchangeRatesError
    );
  }

  try {
    // Merge World Bank data with our static pricing index (for min prices, rounding, etc.)
    const mergedData: Record<string, {
      pppMultiplier: number;
      pppConversionFactor?: number;
      marketExchangeRate?: number;
      bigMacMultiplier?: number;
      netflixMultiplier?: number;
      minPrice: number;
      suggestedRounding: number;
      source: 'world-bank' | 'static';
    }> = {};

    // Start with static data
    for (const [regionCode, entry] of Object.entries(PRICING_INDEX)) {
      mergedData[regionCode] = {
        pppMultiplier: entry.pppMultiplier,
        bigMacMultiplier: BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER,
        netflixMultiplier: NETFLIX_PRICE_INDEX[regionCode]?.multiplier ?? DEFAULT_NETFLIX_MULTIPLIER,
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
        if (marketRate) mergedData[regionCode].marketExchangeRate = marketRate;
        mergedData[regionCode].source = 'world-bank';
      } else {
        // New region from World Bank not in our static data
        mergedData[regionCode] = {
          pppMultiplier: realPPPMultiplier,
          pppConversionFactor: conversionFactor,
          ...(marketRate ? { marketExchangeRate: marketRate } : {}),
          bigMacMultiplier: BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER,
          netflixMultiplier: NETFLIX_PRICE_INDEX[regionCode]?.multiplier ?? DEFAULT_NETFLIX_MULTIPLIER,
          minPrice: DEFAULT_PRICING_INDEX_ENTRY.minPrice,
          suggestedRounding: DEFAULT_PRICING_INDEX_ENTRY.suggestedRounding,
          source: 'world-bank',
        };
      }
    }

    const warning =
      exchangeRatesSource === 'fallback'
        ? `Using static exchange rates from ${FALLBACK_RATES_SNAPSHOT_DATE} (live source unavailable).`
        : undefined;

    return NextResponse.json({
      success: true,
      data: mergedData,
      metadata: {
        baseYear: pppData.baseYear,
        fetchedAt: pppData.fetchedAt.toISOString(),
        worldBankRegions: Object.keys(pppData.multipliers).length,
        totalRegions: Object.keys(mergedData).length,
        exchangeRatesSource,
        exchangeRatesSnapshotDate:
          exchangeRatesSource === 'fallback' ? FALLBACK_RATES_SNAPSHOT_DATE : undefined,
        ...(warning ? { warning } : {}),
        ...(exchangeRatesError ? { exchangeRatesError } : {}),
      },
    });
  } catch (error) {
    console.error('PPP API error:', error);

    // Fallback to static data
    const staticData: Record<string, {
      pppMultiplier: number;
      bigMacMultiplier?: number;
      netflixMultiplier?: number;
      minPrice: number;
      suggestedRounding: number;
      source: 'static';
    }> = {};

    for (const [regionCode, entry] of Object.entries(PRICING_INDEX)) {
      staticData[regionCode] = {
        pppMultiplier: entry.pppMultiplier,
        bigMacMultiplier: BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER,
        netflixMultiplier: NETFLIX_PRICE_INDEX[regionCode]?.multiplier ?? DEFAULT_NETFLIX_MULTIPLIER,
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
