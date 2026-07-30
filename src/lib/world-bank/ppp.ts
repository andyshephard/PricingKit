// World Bank API integration for GDP and household-consumption PPP data
// API documentation: https://datahelpdesk.worldbank.org/knowledgebase/articles/889392

import { alpha3ToAlpha2 } from '@/lib/apple-connect/territories';
import { GOOGLE_PLAY_REGIONS } from '@/lib/google-play/types';

export const GDP_PPP_INDICATOR = 'PA.NUS.PPP';
export const HOUSEHOLD_PPP_INDICATOR = 'PA.NUS.PRVT.PP';
export type PPPIndicator =
  | typeof GDP_PPP_INDICATOR
  | typeof HOUSEHOLD_PPP_INDICATOR;

export interface PPPData {
  regionCode: string;
  pppConversionFactor: number;
  year: number;
}

export interface PPPMultipliers {
  multipliers: Record<string, number>;
  pppConversionFactors: Record<string, number>;
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

const cachedPPPData = new Map<PPPIndicator, PPPMultipliers>();
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;

function buildWorldBankUrls(indicator: PPPIndicator): string[] {
  const indicatorPath = `indicator/${indicator}`;

  return [
    `https://api.worldbank.org/v2/country/all/${indicatorPath}?format=json&per_page=300&mrv=1`,
    `https://api.worldbank.org/v2/en/country/all/${indicatorPath}?format=json&per_page=300&mrv=1`,
    `http://api.worldbank.org/v2/country/all/${indicatorPath}?format=json&per_page=300&mrv=1`,
    `https://api.worldbank.org/v2/country/WLD;USA;DEU;FRA;GBR;JPN;CHN;IND;BRA;RUS;TUR;ARG;MEX/${indicatorPath}?format=json&per_page=300&mrv=1`,
  ];
}

/**
 * Fetch GDP or household and NPISH final-consumption PPP conversion factors.
 *
 * Both indicators are expressed as local-currency units per international dollar.
 * mrv=1 asks the World Bank API for the most recent observation.
 */
export async function fetchPPPData(
  indicator: PPPIndicator = HOUSEHOLD_PPP_INDICATOR
): Promise<PPPData[]> {
  const urls = buildWorldBankUrls(indicator);
  let lastError: Error | null = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        next: { revalidate: 86400 },
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const data = await response.json();
        try {
          return processWorldBankResponse(data, indicator);
        } catch (error) {
          console.warn(`World Bank API: Failed to process response from ${url}:`, error);
          continue;
        }
      }

      const errorText = await response.text();
      console.warn(`World Bank API error (${response.status}) for ${url}: ${errorText}`);
    } catch (error) {
      console.warn(`World Bank API: Request failed for ${url}:`, error);
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError || new Error(`All World Bank ${indicator} API URL variations failed`);
}

function processWorldBankResponse(
  data: unknown,
  indicator: PPPIndicator
): PPPData[] {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error('Invalid World Bank API response format');
  }

  const [, records] = data as [WorldBankResponse, WorldBankDataPoint[]];
  if (!Array.isArray(records)) {
    throw new Error('Invalid World Bank API data format');
  }

  const supportedGoogleRegions: ReadonlySet<string> = new Set<string>(GOOGLE_PLAY_REGIONS.map(({ code }) => code));
  const pppData: PPPData[] = [];

  for (const record of records) {
    if (record.value === null || record.indicator.id !== indicator) {
      continue;
    }

    const regionCode = alpha3ToAlpha2(record.countryiso3code);
    if (!regionCode || !supportedGoogleRegions.has(regionCode)) {
      continue;
    }

    pppData.push({
      regionCode,
      pppConversionFactor: record.value,
      year: Number.parseInt(record.date, 10),
    });
  }

  return pppData;
}

/** Calculate PPP multipliers relative to the United States. */
export async function getPPPMultipliers(
  indicator: PPPIndicator = HOUSEHOLD_PPP_INDICATOR,
  forceRefresh = false
): Promise<PPPMultipliers> {
  const cached = cachedPPPData.get(indicator);
  if (!forceRefresh && cached) {
    const age = Date.now() - cached.fetchedAt.getTime();
    if (age < CACHE_DURATION_MS) {
      return cached;
    }
  }

  try {
    const pppData = await fetchPPPData(indicator);
    const usPPP = pppData.find((entry) => entry.regionCode === 'US');
    if (!usPPP) {
      throw new Error(`US ${indicator} data not found`);
    }

    const multipliers: Record<string, number> = {};
    const pppConversionFactors: Record<string, number> = {};

    for (const entry of pppData) {
      pppConversionFactors[entry.regionCode] = entry.pppConversionFactor;

      // Backward-compatible US-relative multiplier. The pricing API later combines
      // the raw conversion factor with market exchange rates and normalizes it to
      // the user-selected base region.
      const multiplier = usPPP.pppConversionFactor / entry.pppConversionFactor;
      multipliers[entry.regionCode] = Math.max(0.1, Math.min(2.0, multiplier));
    }

    multipliers.US = 1;
    pppConversionFactors.US = usPPP.pppConversionFactor;

    const nextData = {
      multipliers,
      pppConversionFactors,
      baseYear: usPPP.year,
      fetchedAt: new Date(),
    };

    cachedPPPData.set(indicator, nextData);
    return nextData;
  } catch (error) {
    console.error(`Failed to fetch ${indicator} data from World Bank:`, error);

    if (cached) {
      return cached;
    }

    throw error;
  }
}

export async function getPPPMultiplier(
  regionCode: string,
  indicator: PPPIndicator = HOUSEHOLD_PPP_INDICATOR
): Promise<number> {
  try {
    const { multipliers } = await getPPPMultipliers(indicator);
    return multipliers[regionCode] ?? 0.5;
  } catch {
    return 0.5;
  }
}
