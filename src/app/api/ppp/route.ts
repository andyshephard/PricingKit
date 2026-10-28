import { NextResponse } from 'next/server';
import { getCpiSeries, getPPPMultipliers } from '@/lib/world-bank/ppp';
import {
  checkFreshness,
  cpiRatioSince,
  latestCpiYear,
  DEFAULT_PPP_MAX_AGE_YEARS,
  pppStalenessAdjustment,
  REFERENCE_DATA,
  type FreshnessEntry,
  type PppStalenessPolicy,
} from '@/lib/pricing';
import { PRICING_INDEX, DEFAULT_PRICING_INDEX_ENTRY, LOCAL_CURRENCIES } from '@/lib/pricing/indexes/ppp';
import { BIG_MAC_INDEX, DEFAULT_BIG_MAC_MULTIPLIER } from '@/lib/pricing/indexes/big-mac';
import { NETFLIX_PRICE_INDEX, DEFAULT_NETFLIX_MULTIPLIER } from '@/lib/pricing/indexes/netflix';
import { getExchangeRates } from '@/lib/exchange-rates/client';
import { FALLBACK_EXCHANGE_RATES } from '@/lib/pricing/indexes/exchange-rates';
import { hasStoreTokenHeader, readUserOerKey } from '@/middleware/auth';

const FALLBACK_RATES_SNAPSHOT_DATE = REFERENCE_DATA.fallbackExchangeRates.asOf;

/**
 * How old each data set behind the index is (freshness badges in the UI).
 * `ppp` is the live World Bank set (its base year) or the static snapshot;
 * `rates` the live Open Exchange Rates timestamp or the fallback snapshot.
 */
function referenceFreshness(now: Date, ppp: { baseYear?: number }, rates: { asOf?: string }): FreshnessEntry[] {
  return [
    ppp.baseYear !== undefined
      ? checkFreshness({ id: 'ppp', label: `PPP (World Bank, live, ${ppp.baseYear} data)`, asOf: `${ppp.baseYear}-12-31` }, now)
      : checkFreshness(REFERENCE_DATA.ppp, now),
    checkFreshness(REFERENCE_DATA.bigmac, now),
    checkFreshness(REFERENCE_DATA.netflix, now),
    rates.asOf !== undefined
      ? checkFreshness({ id: 'exchangeRates', label: 'Exchange rates (Open Exchange Rates)', asOf: rates.asOf }, now)
      : checkFreshness(REFERENCE_DATA.fallbackExchangeRates, now),
    checkFreshness(REFERENCE_DATA.appleTiers, now),
  ];
}

/** ?pppStale=cap|inflate&pppMaxAge=<years>: what to do with countries whose PPP factor is old */
function stalenessPolicy(searchParams: URLSearchParams): PppStalenessPolicy | undefined {
  const mode = searchParams.get('pppStale') ?? 'cap';
  const maxAge = searchParams.get('pppMaxAge');
  if (mode !== 'cap' && mode !== 'inflate') return undefined;
  if (maxAge !== null && !/^\d{1,2}$/.test(maxAge)) return undefined;
  return { mode, maxAgeYears: maxAge === null ? DEFAULT_PPP_MAX_AGE_YEARS : Number(maxAge) };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';
  const policy = stalenessPolicy(searchParams);
  if (!policy) {
    return NextResponse.json({ success: false, error: 'pppStale must be cap or inflate, and pppMaxAge a number of years' }, { status: 400 });
  }
  const now = new Date();

  // The user's own Open Exchange Rates key (Settings), sent by the browser in
  // X-PK-OER-Key and never stored here. It is used only on a request that
  // also carries a store token header (the app's own requests do), so
  // anonymous callers can't spend the per-isolate user-key budget. Rates
  // fetched with it go back to this caller only: getExchangeRates never puts
  // them in the memory, platform or disk caches, and limits such fetches per
  // key and per isolate. Without it the operator key is used.
  const userApiKey = hasStoreTokenHeader(request) ? readUserOerKey(request) : undefined;

  // This endpoint is public (index checker), but ?refresh=true bypasses the
  // caches. It needs a store token header that passes the shape checks: a
  // speed bump, not authentication (the token isn't verified). The real
  // limits are below: a refresh never spends the operator's Open Exchange
  // Rates key, and World Bank refreshes run at most every 10 minutes.
  if (forceRefresh && !hasStoreTokenHeader(request)) {
    return NextResponse.json(
      { success: false, error: 'Connect a store to force a refresh of PPP data.', code: 'REFRESH_NEEDS_STORE' },
      { status: 403 }
    );
  }

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
        error: 'Live PPP data unavailable',
        freshness: referenceFreshness(now, {}, {}),
      },
    });
  }

  const pppData = pppResult.value;
  // Raw upstream error is logged below; clients only get a generic message.
  const exchangeRatesError = ratesResult.status === 'rejected'
    ? 'Live exchange rates unavailable'
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
  const exchangeRatesAsOf =
    ratesResult.status === 'fulfilled' && Number.isFinite(ratesResult.value.timestamp) ? new Date(ratesResult.value.timestamp * 1000).toISOString() : undefined;

  // Stale PPP factors: cap (use the static index instead) or inflate by CPI relative to the US
  const currentYear = now.getUTCFullYear();
  const staleYears = Object.values(pppData.years ?? {}).filter((y) => currentYear - y > (policy.maxAgeYears ?? DEFAULT_PPP_MAX_AGE_YEARS));
  let cpi: Awaited<ReturnType<typeof getCpiSeries>> | undefined;
  let cpiError: string | undefined;
  if (policy.mode === 'inflate' && staleYears.length > 0) {
    try {
      cpi = await getCpiSeries(Math.min(...staleYears), now);
    } catch (error) {
      console.error('World Bank CPI error:', error);
      cpiError = 'CPI data unavailable: stale PPP factors fall back to the static index';
    }
  }
  const staleRegions: Array<{ region: string; year: number; action: 'static' | 'inflated'; factorRatio?: number }> = [];

  if (exchangeRatesError) {
    console.warn(
      `Exchange rates unavailable, falling back to ${FALLBACK_RATES_SNAPSHOT_DATE} snapshot:`,
      ratesResult.status === 'rejected' ? ratesResult.reason : undefined
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
      /** World Bank data year of this region's PPP factor */
      pppYear?: number;
      /** Older than the staleness policy allows: static index used, or the factor inflated by CPI */
      pppStale?: boolean;
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
      let conversionFactor = pppData.pppConversionFactors[regionCode];
      const currencyCode = LOCAL_CURRENCIES[regionCode];
      const marketRate = exchangeRates.rates[currencyCode];
      const year = pppData.years?.[regionCode];
      if (year !== undefined && regionCode !== 'US') {
        // The region and the US over the same years: up to the earlier of their latest CPI years
        const endYear = cpi ? Math.min(latestCpiYear(cpi[regionCode], year) ?? -Infinity, latestCpiYear(cpi.US, year) ?? -Infinity) : undefined;
        const adjustment = pppStalenessAdjustment(year, currentYear, policy, {
          ...(cpi && endYear !== undefined && Number.isFinite(endYear)
            ? { cpiRatio: cpiRatioSince(cpi[regionCode], year, endYear), baseCpiRatio: cpiRatioSince(cpi.US, year, endYear) }
            : {}),
        });
        if (!adjustment.ok) {
          // Too old to use: keep the static index entry for this region, flagged
          staleRegions.push({ region: regionCode, year, action: 'static' });
          const entry = PRICING_INDEX[regionCode] ?? { ...DEFAULT_PRICING_INDEX_ENTRY, regionCode };
          mergedData[regionCode] = {
            pppMultiplier: entry.pppMultiplier,
            bigMacMultiplier: BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER,
            netflixMultiplier: NETFLIX_PRICE_INDEX[regionCode]?.multiplier ?? DEFAULT_NETFLIX_MULTIPLIER,
            minPrice: entry.minPrice,
            suggestedRounding: entry.suggestedRounding,
            source: 'static',
            pppYear: year,
            pppStale: true,
          };
          continue;
        }
        if (adjustment.stale) {
          conversionFactor = conversionFactor * adjustment.factorRatio;
          staleRegions.push({ region: regionCode, year, action: 'inflated', factorRatio: adjustment.factorRatio });
        }
      }

      // Calculate the real PPP multiplier: PPP_Factor / Market_Rate
      // This tells us how much to adjust the market-converted price
      let realPPPMultiplier = multiplier; // Fallback to US-relative
      if (marketRate && conversionFactor) {
        realPPPMultiplier = conversionFactor / marketRate;
        // Clamp to reasonable bounds
        realPPPMultiplier = Math.max(0.1, Math.min(2.0, realPPPMultiplier));
      }

      const yearFields = year !== undefined ? { pppYear: year, ...(staleRegions.some((r) => r.region === regionCode) ? { pppStale: true } : {}) } : {};
      if (mergedData[regionCode]) {
        mergedData[regionCode].pppMultiplier = realPPPMultiplier;
        mergedData[regionCode].pppConversionFactor = conversionFactor;
        if (marketRate) mergedData[regionCode].marketExchangeRate = marketRate;
        mergedData[regionCode].source = 'world-bank';
        Object.assign(mergedData[regionCode], yearFields);
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
          ...yearFields,
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
        ...(exchangeRatesAsOf ? { exchangeRatesAsOf } : {}),
        pppStaleness: { ...policy, regions: staleRegions, ...(cpiError ? { error: cpiError } : {}) },
        freshness: referenceFreshness(now, { baseYear: pppData.baseYear }, { ...(exchangeRatesAsOf ? { asOf: exchangeRatesAsOf } : {}) }),
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
        error: 'Live PPP data unavailable',
        freshness: referenceFreshness(now, {}, {}),
      },
    });
  }
}
