// How old is the reference data a price was derived from?
//
// Strategy prices rest on static tables (PPP, Big Mac, Netflix indexes, the
// fallback exchange rates) and, in the web app, on the static Apple tier
// ladder. Each records the date it describes here; plans and the UI compare
// it with a maximum age and warn (or, if asked, refuse) when it is older.
//
// A stale PPP factor is the worst case: PPP conversion factors are annual
// and can be years old for some countries, while exchange rates are live, so
// for high-inflation currencies pppFactor / todayFX drifts badly. Two
// policies (pppStalenessAdjustment):
//   cap     (default) data older than maxAgeYears is not used: the territory
//           is skipped (plans) or falls back to the static index (web app)
//   inflate the factor is carried forward with consumer price inflation:
//           factor x (CPI_now / CPI_dataYear) in the territory, divided by
//           the same ratio in the base territory (US CPI cancels out once
//           multipliers are normalised to the base). The CPI ratios come from
//           the caller (a spec's `cpi` table, or the World Bank FP.CPI.TOTL
//           series in the web app); a territory without one is skipped.
// Framework-free: no network. Pure functions over dates passed in.

import { PRICE_TIER_DATA_GENERATED_AT } from '../apple-connect/price-tier-meta';

export const REFERENCE_DATA_IDS = ['ppp', 'bigmac', 'netflix', 'fallbackExchangeRates', 'exchangeRates', 'appleTiers'] as const;
export type ReferenceDataId = (typeof REFERENCE_DATA_IDS)[number];

export interface ReferenceDataInfo {
  id: ReferenceDataId;
  label: string;
  source: string;
  /** The date the data describes or was captured (YYYY-MM-DD) */
  asOf: string;
  /** PPP: the data year of the factors */
  dataYear?: number;
  /** Things about the date that aren't certain */
  caveat?: string;
}

/** Default maximum ages in days, per data set */
export const DEFAULT_MAX_AGE_DAYS: Record<ReferenceDataId, number> = {
  // PPP factors are annual and published with a lag of a year or more: warn after ~2.5 years
  ppp: 913,
  // The Economist publishes the Big Mac index twice a year
  bigmac: 400,
  netflix: 400,
  // Fallback rates are a snapshot; live rates move daily
  fallbackExchangeRates: 45,
  // Live rates (Open Exchange Rates or a spec's own table)
  exchangeRates: 7,
  // Apple re-prices territories for tax and currency changes several times a year
  appleTiers: 180,
};

/** The static tables built into PricingKit, and their dates */
export const REFERENCE_DATA: Record<Exclude<ReferenceDataId, 'exchangeRates'>, ReferenceDataInfo> = {
  ppp: {
    id: 'ppp',
    label: 'PPP index (World Bank PA.NUS.PPP, static)',
    source: 'src/lib/pricing/indexes/ppp.ts, synced from the World Bank API on 2026-02-01',
    asOf: '2024-12-31',
    dataYear: 2024,
    caveat: 'the snapshot did not record each country\'s data year; 2024 (the latest year the World Bank published at the sync date) is assumed',
  },
  bigmac: {
    id: 'bigmac',
    label: 'Big Mac index (static)',
    source: 'src/lib/pricing/indexes/big-mac.ts (The Economist, 2025 data)',
    asOf: '2025-01-01',
    caveat: 'the edition month was not recorded; the start of 2025 is assumed',
  },
  netflix: {
    id: 'netflix',
    label: 'Netflix price index (static)',
    source: 'src/lib/pricing/indexes/netflix.ts (tompec/netflix-prices at a46477c, 2026-04-09)',
    asOf: '2026-04-09',
  },
  fallbackExchangeRates: {
    id: 'fallbackExchangeRates',
    label: 'Fallback exchange rates (static)',
    source: 'src/lib/pricing/indexes/exchange-rates.ts (Open Exchange Rates, 2026-02-01)',
    asOf: '2026-02-01',
  },
  appleTiers: {
    id: 'appleTiers',
    label: 'Apple price tier ladder (static, web previews)',
    source: 'src/lib/apple-connect/price-tier-data.json (scripts/fetch-apple-price-tiers.ts)',
    asOf: PRICE_TIER_DATA_GENERATED_AT,
  },
};

export interface FreshnessEntry {
  id: ReferenceDataId;
  label: string;
  /** YYYY-MM-DD, or undefined when the date isn't known */
  asOf?: string;
  ageDays?: number;
  maxAgeDays: number;
  /** Older than maxAgeDays, or of unknown date */
  stale: boolean;
  message: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Whole days from `asOf` (YYYY-MM-DD or ISO timestamp) to `now`; undefined for an unreadable date */
export function ageInDays(asOf: string, now: Date): number | undefined {
  const time = Date.parse(DATE.test(asOf) ? `${asOf}T00:00:00Z` : asOf);
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, Math.floor((now.getTime() - time) / DAY_MS));
}

/** Judge one data set's age */
export function checkFreshness(
  info: { id: ReferenceDataId; label: string; asOf?: string; caveat?: string },
  now: Date,
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS[info.id]
): FreshnessEntry {
  const ageDays = info.asOf ? ageInDays(info.asOf, now) : undefined;
  if (ageDays === undefined) {
    return { id: info.id, label: info.label, maxAgeDays, stale: true, message: `${info.label}: date unknown, so its age can't be checked` };
  }
  const stale = ageDays > maxAgeDays;
  const asOf = info.asOf!.slice(0, 10);
  const message = `${info.label}: as of ${asOf}, ${ageDays} days old${stale ? ` (older than ${maxAgeDays} days; refresh it)` : ''}${info.caveat ? `; ${info.caveat}` : ''}`;
  return { id: info.id, label: info.label, asOf, ageDays, maxAgeDays, stale, message };
}

/** The reference data a strategy reads, besides exchange rates */
export function strategyReferenceData(strategy: string): Array<Exclude<ReferenceDataId, 'exchangeRates' | 'fallbackExchangeRates' | 'appleTiers'>> {
  if (strategy === 'ppp') return ['ppp'];
  if (strategy === 'bigmac') return ['bigmac'];
  if (strategy === 'netflix') return ['netflix'];
  return [];
}

// ---------------------------------------------------------------------------
// Stale PPP factors

export type PppStalenessMode = 'cap' | 'inflate';

export interface PppStalenessPolicy {
  /** cap (default): don't use data older than maxAgeYears; inflate: carry it forward by CPI */
  mode?: PppStalenessMode;
  /** Data older than this many years (current year - data year) is stale. Default 3. */
  maxAgeYears?: number;
}

export const DEFAULT_PPP_MAX_AGE_YEARS = 3;

export type PppStalenessResult =
  /** Fresh enough: use the factor as it is */
  | { ok: true; factorRatio: 1; stale: false; ageYears: number }
  /** Stale, inflated: multiply the factor (or a base-normalised multiplier) by factorRatio */
  | { ok: true; factorRatio: number; stale: true; ageYears: number; note: string }
  /** Stale and not usable */
  | { ok: false; stale: true; ageYears: number; reason: string };

/**
 * What to do with a PPP factor from `dataYear`, judged in `currentYear`.
 * For inflate, `cpiRatio` is CPI(now) / CPI(dataYear) in the territory and
 * `baseCpiRatio` the same in the base territory (or the US, for raw factors).
 */
export function pppStalenessAdjustment(
  dataYear: number,
  currentYear: number,
  policy: PppStalenessPolicy = {},
  cpi: { cpiRatio?: number; baseCpiRatio?: number } = {}
): PppStalenessResult {
  const maxAgeYears = policy.maxAgeYears ?? DEFAULT_PPP_MAX_AGE_YEARS;
  const ageYears = Math.max(0, currentYear - dataYear);
  if (ageYears <= maxAgeYears) return { ok: true, factorRatio: 1, stale: false, ageYears };
  if ((policy.mode ?? 'cap') === 'cap') {
    return { ok: false, stale: true, ageYears, reason: `PPP data from ${dataYear} is ${ageYears} years old (more than ${maxAgeYears}); refresh it or use the inflate policy with CPI ratios` };
  }
  const { cpiRatio, baseCpiRatio } = cpi;
  const usable = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0;
  if (!usable(cpiRatio) || !usable(baseCpiRatio)) {
    return { ok: false, stale: true, ageYears, reason: `PPP data from ${dataYear} is ${ageYears} years old and no CPI ratio was given to inflate it` };
  }
  const factorRatio = cpiRatio / baseCpiRatio;
  return { ok: true, factorRatio, stale: true, ageYears, note: `PPP data from ${dataYear} inflated by relative CPI x${factorRatio.toFixed(4)}` };
}
