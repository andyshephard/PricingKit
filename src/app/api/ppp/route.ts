import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  GDP_PPP_INDICATOR,
  HOUSEHOLD_PPP_INDICATOR,
  getPPPMultipliers,
  type PPPMultipliers,
} from "@/lib/world-bank/ppp";
import {
  PRICING_INDEX,
  DEFAULT_PRICING_INDEX_ENTRY,
  LOCAL_CURRENCIES,
} from "@/lib/conversion-indexes/ppp";
import {
  BIG_MAC_INDEX,
  DEFAULT_BIG_MAC_MULTIPLIER,
} from "@/lib/conversion-indexes/big-mac";
import {
  NETFLIX_PRICE_INDEX,
  DEFAULT_NETFLIX_MULTIPLIER,
} from "@/lib/conversion-indexes/netflix";
import { getExchangeRates } from "@/lib/exchange-rates/client";
import { FALLBACK_EXCHANGE_RATES } from "@/lib/conversion-indexes/exchange-rates";

const EXCHANGE_RATES_COOKIE = "exchange_rates_api_key";
const FALLBACK_RATES_SNAPSHOT_DATE = "2026-02-01";

interface PricingDatasetEntry {
  pppMultiplier: number;
  pppConversionFactor?: number;
  marketExchangeRate?: number;
  bigMacMultiplier?: number;
  netflixMultiplier?: number;
  minPrice: number;
  suggestedRounding: number;
  source: "world-bank" | "static";
}

interface DatasetMetadata {
  indicator: string;
  baseYear: number | null;
  fetchedAt: string;
  worldBankRegions: number;
  totalRegions: number;
  fallback?: boolean;
  error?: string;
}

function createStaticDataset(): Record<string, PricingDatasetEntry> {
  const data: Record<string, PricingDatasetEntry> = {};

  for (const [regionCode, entry] of Object.entries(PRICING_INDEX)) {
    data[regionCode] = {
      pppMultiplier: entry.pppMultiplier,
      bigMacMultiplier: BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER,
      netflixMultiplier:
        NETFLIX_PRICE_INDEX[regionCode]?.multiplier ??
        DEFAULT_NETFLIX_MULTIPLIER,
      minPrice: entry.minPrice,
      suggestedRounding: entry.suggestedRounding,
      source: "static",
    };
  }

  return data;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Unknown error";
}

function buildDataset(
  result: PromiseSettledResult<PPPMultipliers>,
  indicator: string,
  exchangeRates: { rates: Record<string, number> },
): {
  data: Record<string, PricingDatasetEntry>;
  metadata: DatasetMetadata;
} {
  const data = createStaticDataset();

  if (result.status === "rejected") {
    console.error(`${indicator} API error:`, result.reason);
    return {
      data,
      metadata: {
        indicator,
        baseYear: null,
        fetchedAt: new Date().toISOString(),
        worldBankRegions: 0,
        totalRegions: Object.keys(data).length,
        fallback: true,
        error: errorMessage(result.reason),
      },
    };
  }

  const pppData = result.value;

  for (const [regionCode, multiplier] of Object.entries(pppData.multipliers)) {
    const conversionFactor = pppData.pppConversionFactors[regionCode];
    const currencyCode = LOCAL_CURRENCIES[regionCode];
    const marketRate = exchangeRates.rates[currencyCode];

    let realPPPMultiplier = multiplier;
    if (marketRate && conversionFactor) {
      realPPPMultiplier = conversionFactor / marketRate;
      realPPPMultiplier = Math.max(0.1, Math.min(2, realPPPMultiplier));
    }

    const existing = data[regionCode];
    if (existing) {
      existing.pppMultiplier = realPPPMultiplier;
      existing.pppConversionFactor = conversionFactor;
      if (marketRate) existing.marketExchangeRate = marketRate;
      existing.source = "world-bank";
      continue;
    }

    data[regionCode] = {
      pppMultiplier: realPPPMultiplier,
      pppConversionFactor: conversionFactor,
      ...(marketRate ? { marketExchangeRate: marketRate } : {}),
      bigMacMultiplier: BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER,
      netflixMultiplier:
        NETFLIX_PRICE_INDEX[regionCode]?.multiplier ??
        DEFAULT_NETFLIX_MULTIPLIER,
      minPrice: DEFAULT_PRICING_INDEX_ENTRY.minPrice,
      suggestedRounding: DEFAULT_PRICING_INDEX_ENTRY.suggestedRounding,
      source: "world-bank",
    };
  }

  return {
    data,
    metadata: {
      indicator,
      baseYear: pppData.baseYear,
      fetchedAt: pppData.fetchedAt.toISOString(),
      worldBankRegions: Object.keys(pppData.multipliers).length,
      totalRegions: Object.keys(data).length,
    },
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get("refresh") === "true";

  const cookieStore = await cookies();
  const userApiKey = cookieStore.get(EXCHANGE_RATES_COOKIE)?.value;

  const [gdpResult, householdResult, ratesResult] = await Promise.allSettled([
    getPPPMultipliers(GDP_PPP_INDICATOR, forceRefresh),
    getPPPMultipliers(HOUSEHOLD_PPP_INDICATOR, forceRefresh),
    getExchangeRates(forceRefresh, userApiKey),
  ]);

  const exchangeRatesError =
    ratesResult.status === "rejected" ? errorMessage(ratesResult.reason) : null;
  const exchangeRatesSource: "live" | "fallback" =
    ratesResult.status === "fulfilled" ? "live" : "fallback";
  const exchangeRates =
    ratesResult.status === "fulfilled"
      ? ratesResult.value
      : { base: "USD", rates: FALLBACK_EXCHANGE_RATES };

  if (exchangeRatesError) {
    console.warn(
      `Exchange rates unavailable, falling back to ${FALLBACK_RATES_SNAPSHOT_DATE} snapshot:`,
      exchangeRatesError,
    );
  }

  const gdp = buildDataset(gdpResult, GDP_PPP_INDICATOR, exchangeRates);
  const household = buildDataset(
    householdResult,
    HOUSEHOLD_PPP_INDICATOR,
    exchangeRates,
  );
  const warning =
    exchangeRatesSource === "fallback"
      ? `Using static exchange rates from ${FALLBACK_RATES_SNAPSHOT_DATE} (live source unavailable).`
      : undefined;

  return NextResponse.json({
    success: true,
    // Preserve the existing field as household data for older clients.
    data: household.data,
    datasets: {
      gdp: gdp.data,
      household: household.data,
    },
    metadata: {
      // Preserve the existing metadata fields as household metadata.
      ...household.metadata,
      gdp: gdp.metadata,
      household: household.metadata,
      exchangeRatesSource,
      exchangeRatesSnapshotDate:
        exchangeRatesSource === "fallback"
          ? FALLBACK_RATES_SNAPSHOT_DATE
          : undefined,
      ...(warning ? { warning } : {}),
      ...(exchangeRatesError ? { exchangeRatesError } : {}),
    },
  });
}
