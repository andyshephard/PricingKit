// Open Exchange Rates API client with caching
// API Documentation: https://docs.openexchangerates.org/

const API_BASE_URL = 'https://openexchangerates.org/api';
const CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours (free tier updates hourly)

export class NoApiKeyError extends Error {
  constructor() {
    super('No API key available. Please add your Open Exchange Rates API key in Settings.');
    this.name = 'NoApiKeyError';
  }
}

export interface ExchangeRatesData {
  base: string;
  rates: Record<string, number>;
  timestamp: number;
  fetchedAt: string;
}

interface OpenExchangeRatesResponse {
  disclaimer: string;
  license: string;
  timestamp: number;
  base: string;
  rates: Record<string, number>;
}

// In-memory cache
let memoryCache: ExchangeRatesData | null = null;

/**
 * Get the API key from provided value or environment variables
 */
function getApiKey(providedKey?: string): string | null {
  return providedKey || process.env.OPEN_EXCHANGE_RATES_APP_ID || null;
}

/**
 * Load cached exchange rates from disk
 */
async function loadFromDisk(): Promise<ExchangeRatesData | null> {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const cacheFile = path.join(process.cwd(), '.exchange-rates.json');
    const data = await fs.readFile(cacheFile, 'utf-8');
    return JSON.parse(data) as ExchangeRatesData;
  } catch {
    return null;
  }
}

/**
 * Save exchange rates to disk cache
 */
async function saveToDisk(data: ExchangeRatesData): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const cacheFile = path.join(process.cwd(), '.exchange-rates.json');
    await fs.writeFile(cacheFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Silently ignore - disk caching not available (e.g. Cloudflare Workers)
  }
}

/**
 * Check if cached data is still valid
 */
function isCacheValid(data: ExchangeRatesData): boolean {
  const age = Date.now() - new Date(data.fetchedAt).getTime();
  return age < CACHE_DURATION_MS;
}

/**
 * Fetch latest exchange rates from Open Exchange Rates API
 */
async function fetchFromApi(providedApiKey?: string): Promise<ExchangeRatesData> {
  const apiKey = getApiKey(providedApiKey);

  if (!apiKey) {
    throw new NoApiKeyError();
  }

  const url = `${API_BASE_URL}/latest.json?app_id=${apiKey}`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Open Exchange Rates API error: ${response.status} - ${errorText}`);
  }

  const data: OpenExchangeRatesResponse = await response.json();

  return {
    base: data.base,
    rates: data.rates,
    timestamp: data.timestamp,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Get exchange rates with caching
 * Returns cached data if available and valid, otherwise fetches fresh data
 * @param forceRefresh - Force a fresh fetch from the API
 * @param apiKey - Optional API key (uses env var if not provided)
 */
export async function getExchangeRates(forceRefresh = false, apiKey?: string): Promise<ExchangeRatesData> {
  // Check memory cache first
  if (!forceRefresh && memoryCache && isCacheValid(memoryCache)) {
    return memoryCache;
  }

  // Check disk cache
  if (!forceRefresh) {
    const diskCache = await loadFromDisk();
    if (diskCache && isCacheValid(diskCache)) {
      memoryCache = diskCache;
      return diskCache;
    }
  }

  // Fetch fresh data from API
  try {
    const freshData = await fetchFromApi(apiKey);
    memoryCache = freshData;
    await saveToDisk(freshData);
    return freshData;
  } catch (error) {
    // If API call fails, try to use stale cache
    const staleCache = memoryCache || await loadFromDisk();
    if (staleCache) {
      console.warn('Using stale exchange rates cache due to API error:', error);
      return staleCache;
    }
    throw error;
  }
}

/**
 * Get exchange rate for a specific currency (USD to target)
 * Returns null if the currency is not found
 */
export async function getExchangeRateForCurrency(currencyCode: string): Promise<number | null> {
  try {
    const data = await getExchangeRates();
    return data.rates[currencyCode] ?? null;
  } catch {
    return null;
  }
}

/**
 * Get all available currency codes
 */
export async function getAvailableCurrencies(): Promise<string[]> {
  try {
    const data = await getExchangeRates();
    return Object.keys(data.rates).sort();
  } catch {
    return [];
  }
}

/**
 * Check if exchange rates are available (API key is set and we have data)
 */
export async function isExchangeRatesAvailable(): Promise<boolean> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return false;
  }

  try {
    await getExchangeRates();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get cache status information
 */
export async function getCacheStatus(): Promise<{
  hasApiKey: boolean;
  hasCachedData: boolean;
  cacheAge: number | null;
  isValid: boolean;
  currencyCount: number;
}> {
  const apiKey = getApiKey();
  const cachedData = memoryCache || await loadFromDisk();

  return {
    hasApiKey: !!apiKey,
    hasCachedData: !!cachedData,
    cacheAge: cachedData ? Date.now() - new Date(cachedData.fetchedAt).getTime() : null,
    isValid: cachedData ? isCacheValid(cachedData) : false,
    currencyCount: cachedData ? Object.keys(cachedData.rates).length : 0,
  };
}
