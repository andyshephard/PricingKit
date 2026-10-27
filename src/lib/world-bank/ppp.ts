// World Bank API integration for PPP (Purchasing Power Parity) data
// API Documentation: https://datahelpdesk.worldbank.org/knowledgebase/articles/889392

import { GOOGLE_PLAY_REGIONS } from '@/lib/google-play/types';

// Map World Bank 3-letter codes back to 2-letter region codes
const WORLD_BANK_TO_REGION: Record<string, string> = {
  USA: 'US',
  GBR: 'GB',
  DEU: 'DE',
  FRA: 'FR',
  ITA: 'IT',
  ESP: 'ES',
  NLD: 'NL',
  BEL: 'BE',
  AUT: 'AT',
  CHE: 'CH',
  IRL: 'IE',
  PRT: 'PT',
  LUX: 'LU',
  SWE: 'SE',
  NOR: 'NO',
  DNK: 'DK',
  FIN: 'FI',
  ISL: 'IS',
  POL: 'PL',
  CZE: 'CZ',
  HUN: 'HU',
  ROU: 'RO',
  BGR: 'BG',
  SVK: 'SK',
  SVN: 'SI',
  HRV: 'HR',
  SRB: 'RS',
  BIH: 'BA',
  MKD: 'MK',
  ALB: 'AL',
  MDA: 'MD',
  EST: 'EE',
  LVA: 'LV',
  LTU: 'LT',
  RUS: 'RU',
  UKR: 'UA',
  BLR: 'BY',
  KAZ: 'KZ',
  UZB: 'UZ',
  KGZ: 'KG',
  TJK: 'TJ',
  TKM: 'TM',
  ARM: 'AM',
  AZE: 'AZ',
  GEO: 'GE',
  ISR: 'IL',
  ARE: 'AE',
  SAU: 'SA',
  QAT: 'QA',
  KWT: 'KW',
  BHR: 'BH',
  OMN: 'OM',
  JOR: 'JO',
  LBN: 'LB',
  IRQ: 'IQ',
  YEM: 'YE',
  JPN: 'JP',
  KOR: 'KR',
  AUS: 'AU',
  NZL: 'NZ',
  SGP: 'SG',
  HKG: 'HK',
  TWN: 'TW',
  MAC: 'MO',
  IND: 'IN',
  IDN: 'ID',
  MYS: 'MY',
  THA: 'TH',
  VNM: 'VN',
  PHL: 'PH',
  PAK: 'PK',
  BGD: 'BD',
  LKA: 'LK',
  NPL: 'NP',
  MMR: 'MM',
  KHM: 'KH',
  LAO: 'LA',
  MNG: 'MN',
  MDV: 'MV',
  BRA: 'BR',
  ARG: 'AR',
  CHL: 'CL',
  COL: 'CO',
  PER: 'PE',
  ECU: 'EC',
  VEN: 'VE',
  BOL: 'BO',
  PRY: 'PY',
  URY: 'UY',
  MEX: 'MX',
  GTM: 'GT',
  CRI: 'CR',
  PAN: 'PA',
  SLV: 'SV',
  HND: 'HN',
  NIC: 'NI',
  BLZ: 'BZ',
  DOM: 'DO',
  JAM: 'JM',
  TTO: 'TT',
  HTI: 'HT',
  BHS: 'BS',
  ATG: 'AG',
  DMA: 'DM',
  GRD: 'GD',
  KNA: 'KN',
  LCA: 'LC',
  SUR: 'SR',
  EGY: 'EG',
  MAR: 'MA',
  DZA: 'DZ',
  TUN: 'TN',
  LBY: 'LY',
  ZAF: 'ZA',
  NGA: 'NG',
  KEN: 'KE',
  GHA: 'GH',
  TZA: 'TZ',
  UGA: 'UG',
  RWA: 'RW',
  ETH: 'ET',
  SEN: 'SN',
  CIV: 'CI',
  CMR: 'CM',
  AGO: 'AO',
  MOZ: 'MZ',
  ZMB: 'ZM',
  ZWE: 'ZW',
  BWA: 'BW',
  NAM: 'NA',
  MUS: 'MU',
  SYC: 'SC',
  MLI: 'ML',
  BFA: 'BF',
  NER: 'NE',
  TCD: 'TD',
  CAF: 'CF',
  COD: 'CD',
  COG: 'CG',
  GAB: 'GA',
  BEN: 'BJ',
  TGO: 'TG',
  GIN: 'GN',
  GNB: 'GW',
  SLE: 'SL',
  LBR: 'LR',
  GMB: 'GM',
  CPV: 'CV',
  ERI: 'ER',
  DJI: 'DJ',
  SOM: 'SO',
  COM: 'KM',
  FJI: 'FJ',
  PNG: 'PG',
  WSM: 'WS',
  TON: 'TO',
  VUT: 'VU',
  SLB: 'SB',
  FSM: 'FM',
  TUR: 'TR',
  CYP: 'CY',
  MLT: 'MT',
  GRC: 'GR',
  CAN: 'CA',
};

export interface PPPData {
  regionCode: string;
  pppConversionFactor: number;
  year: number;
}

export interface PPPMultipliers {
  multipliers: Record<string, number>;
  pppConversionFactors: Record<string, number>;
  /** The year of each region's PPP factor (World Bank's most recent non-empty value) */
  years: Record<string, number>;
  baseYear: number;
  fetchedAt: Date;
}

interface WorldBankResponse {
  page: number;
  pages: number;
  per_page: number;
  total: number;
  sourceid: string;
  lastupdated: string;
}

interface WorldBankDataPoint {
  indicator: { id: string; value: string };
  country: { id: string; value: string };
  countryiso3code: string;
  date: string;
  value: number | null;
  unit: string;
  obs_status: string;
  decimal: number;
}

// Cache for PPP data (in-memory, will reset on server restart)
let cachedPPPData: PPPMultipliers | null = null;
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Fetch PPP conversion factors from World Bank API
export async function fetchPPPData(): Promise<PPPData[]> {
  // PA.NUS.PPP = PPP conversion factor, GDP (LCU per international $)
  // mrnev=1 = most recent non-empty value
  // Using a more robust URL format for World Bank API v2
  // We'll try multiple URL variations to handle API changes or regional restrictions
  const urls = [
    'https://api.worldbank.org/v2/country/all/indicator/PA.NUS.PPP?format=json&per_page=300&mrnev=1',
    'https://api.worldbank.org/v2/en/country/all/indicator/PA.NUS.PPP?format=json&per_page=300&mrnev=1',
    'https://api.worldbank.org/v2/country/WLD;USA;DEU;FRA;GBR;JPN;CHN;IND;BRA;RUS;TUR;ARG;MEX/indicator/PA.NUS.PPP?format=json&per_page=300&mrnev=1'
  ];

  let lastError: Error | null = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        next: { revalidate: 86400 }, // Cache for 24 hours in Next.js
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      if (response.ok) {
        const data = await response.json();
        try {
          return processWorldBankResponse(data);
        } catch (e) {
          console.warn(`World Bank API: Failed to process response from ${url}:`, e);
          continue;
        }
      } else {
        const errorText = await response.text();
        console.warn(`World Bank API error (${response.status}) for ${url}: ${errorText}`);
      }
    } catch (e) {
      console.warn(`World Bank API: Request failed for ${url}:`, e);
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastError || new Error('All World Bank API URL variations failed');
}

function processWorldBankResponse(data: unknown): PPPData[] {
  // World Bank API returns [metadata, data] array
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error('Invalid World Bank API response format');
  }

  const [, records] = data as [WorldBankResponse, WorldBankDataPoint[]];

  if (!Array.isArray(records)) {
    throw new Error('Invalid World Bank API data format');
  }

  const pppData: PPPData[] = [];

  for (const record of records) {
    if (record.value === null) continue;

    const regionCode = WORLD_BANK_TO_REGION[record.countryiso3code];
    if (!regionCode) continue;

    // Only include regions that Google Play supports
    if (!GOOGLE_PLAY_REGIONS.find(r => r.code === regionCode)) continue;

    pppData.push({
      regionCode,
      pppConversionFactor: record.value,
      year: parseInt(record.date, 10),
    });
  }

  return pppData;
}

// Calculate PPP multipliers relative to US
export async function getPPPMultipliers(forceRefresh = false): Promise<PPPMultipliers> {
  // Check cache
  if (!forceRefresh && cachedPPPData) {
    const age = Date.now() - cachedPPPData.fetchedAt.getTime();
    if (age < CACHE_DURATION_MS) {
      return cachedPPPData;
    }
  }

  try {
    const pppData = await fetchPPPData();

    // Find US PPP factor (should be close to 1, but let's normalize)
    const usPPP = pppData.find(d => d.regionCode === 'US');
    if (!usPPP) {
      throw new Error('US PPP data not found');
    }

    const multipliers: Record<string, number> = {};
    const pppConversionFactors: Record<string, number> = {};
    const years: Record<string, number> = {};
    const baseYear = usPPP.year;

    for (const data of pppData) {
      // Store the raw PPP conversion factor
      // PPP conversion factor = local currency units per international dollar
      // This IS the "fair" exchange rate based on purchasing power
      // For PPP pricing: price_local = price_USD * pppConversionFactor
      pppConversionFactors[data.regionCode] = data.pppConversionFactor;
      if (Number.isFinite(data.year)) years[data.regionCode] = data.year;

      // Calculate the multiplier relative to the MARKET exchange rate
      // multiplier = PPP_Factor / Market_Exchange_Rate
      // If PPP is 8 TRY/$ and Market is 32 TRY/$, multiplier is 0.25 (fair price is 25% of converted price)
      // We'll calculate this in the API route where we have access to exchange rates
      
      // For backward compatibility in this object, we still provide a US-relative multiplier
      const multiplier = usPPP.pppConversionFactor / data.pppConversionFactor;
      multipliers[data.regionCode] = Math.max(0.1, Math.min(2.0, multiplier));
    }

    // Ensure US is exactly 1.0
    multipliers['US'] = 1.0;
    pppConversionFactors['US'] = 1.0;

    cachedPPPData = {
      multipliers,
      pppConversionFactors,
      years,
      baseYear,
      fetchedAt: new Date(),
    };

    return cachedPPPData;
  } catch (error) {
    console.error('Failed to fetch PPP data from World Bank:', error);

    // Return cached data if available, even if stale
    if (cachedPPPData) {
      return cachedPPPData;
    }

    throw error;
  }
}

// Get multiplier for a specific region, with fallback
export async function getPPPMultiplier(regionCode: string): Promise<number> {
  try {
    const { multipliers } = await getPPPMultipliers();
    return multipliers[regionCode] ?? 0.5; // Default to 0.5 if not found
  } catch {
    // Fallback to hardcoded default
    return 0.5;
  }
}

// ---------------------------------------------------------------------------
// Consumer price inflation, for carrying stale PPP factors forward
// (src/lib/pricing/freshness.ts, the "inflate" policy).

/** Region -> year -> CPI (2010 = 100) */
export type CpiSeries = Record<string, Record<number, number>>;

/** How long a failed CPI fetch is remembered, so a World Bank outage isn't hit by every request */
export const CPI_FAILURE_CACHE_MS = 5 * 60 * 1000;

type CpiCacheEntry =
  | { key: string; state: 'pending'; promise: Promise<CpiSeries> }
  | { key: string; state: 'ok'; promise: Promise<CpiSeries>; at: number }
  | { key: string; state: 'failed'; promise: Promise<CpiSeries>; at: number };
let cpiCache: CpiCacheEntry | null = null;

/** Test-only: forget cached CPI data */
export function resetCpiCacheForTests(): void {
  cpiCache = null;
}

/**
 * Consumer price index series from the World Bank's FP.CPI.TOTL
 * (2010 = 100), every country from `fromYear` to this year, in one request.
 * Concurrent callers share one in-flight request; a result is cached 24
 * hours, a failure 5 minutes (callers get the same error meanwhile). Turn
 * the series into ratios with cpiRatioSince (pricing core).
 */
export function getCpiSeries(fromYear: number, now: Date = new Date()): Promise<CpiSeries> {
  const key = `${fromYear}:${now.getUTCFullYear()}`;
  const cached = cpiCache;
  if (cached && cached.key === key) {
    if (cached.state === 'pending') return cached.promise;
    const age = Date.now() - cached.at;
    if (cached.state === 'ok' && age < CACHE_DURATION_MS) return cached.promise;
    if (cached.state === 'failed' && age < CPI_FAILURE_CACHE_MS) return cached.promise;
  }
  const promise = fetchCpiSeries(fromYear, now.getUTCFullYear());
  const entry: CpiCacheEntry = { key, state: 'pending', promise };
  cpiCache = entry;
  promise.then(
    () => {
      if (cpiCache === entry) cpiCache = { key, state: 'ok', promise, at: Date.now() };
    },
    () => {
      if (cpiCache === entry) cpiCache = { key, state: 'failed', promise, at: Date.now() };
    }
  );
  return promise;
}

async function fetchCpiSeries(fromYear: number, currentYear: number): Promise<CpiSeries> {
  const url = `https://api.worldbank.org/v2/country/all/indicator/FP.CPI.TOTL?format=json&per_page=20000&date=${fromYear}:${currentYear}`;
  const response = await fetch(url, { next: { revalidate: 86400 }, signal: AbortSignal.timeout(10000) } as RequestInit);
  if (!response.ok) throw new Error(`World Bank CPI request failed (${response.status})`);
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data) || data.length < 2 || !Array.isArray(data[1])) throw new Error('Invalid World Bank CPI response format');
  const series: CpiSeries = {};
  for (const record of data[1] as WorldBankDataPoint[]) {
    const region = WORLD_BANK_TO_REGION[record.countryiso3code];
    if (!region || typeof record.value !== 'number' || !Number.isFinite(record.value) || record.value <= 0) continue;
    (series[region] ??= {})[parseInt(record.date, 10)] = record.value;
  }
  return series;
}
