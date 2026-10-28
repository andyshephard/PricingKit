// Open Exchange Rates API client with caching
// API Documentation: https://docs.openexchangerates.org/

import { AttemptLimiter } from '../utils/attempt-limiter';

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

// Caches, from cheapest to slowest: this isolate's memory, the platform's
// shared cache (Cloudflare's Cache API, when there is one), and on Node a
// file in the working directory. Requests that miss share one in-flight
// upstream request, and a failed one is remembered for 5 minutes, so a burst
// of requests or an upstream outage costs the operator's key one request,
// not one per visitor.
let memoryCache: ExchangeRatesData | null = null;
let inFlight: Promise<ExchangeRatesData> | null = null;
let lastFailure: { at: number; error: unknown } | null = null;

/** How long a failed upstream request is remembered (no new request meanwhile) */
export const FAILURE_CACHE_MS = 5 * 60 * 1000;
/** Upstream request timeout */
export const FETCH_TIMEOUT_MS = 10_000;
const SHARED_CACHE_URL = 'https://pricingkit.invalid/cache/exchange-rates/v1';

/**
 * Upstream requests with users' own keys, per isolate: a user key can be any
 * caller's (the header isn't authenticated), so this server can't be used as
 * an unlimited Open Exchange Rates proxy. Over the limit, cached operator
 * data is served instead (or the request fails when there is none).
 */
export const USER_KEY_FETCHES_PER_MINUTE = 20;
function userKeyLimiter(): AttemptLimiter {
  return new AttemptLimiter({ limit: USER_KEY_FETCHES_PER_MINUTE, globalLimit: USER_KEY_FETCHES_PER_MINUTE, windowMs: 60_000 });
}
let userKeyFetches = userKeyLimiter();

export class UserKeyRateLimitedError extends Error {
  constructor() {
    super('Too many exchange-rate requests with a personal key. Try again in a minute.');
    this.name = 'UserKeyRateLimitedError';
  }
}

/** Test-only: forget every cached result, failure and in-flight request, and the user-key limit */
export function resetExchangeRatesCacheForTests(): void {
  memoryCache = null;
  inFlight = null;
  lastFailure = null;
  userKeyFetches = userKeyLimiter();
}

/**
 * Get the API key from provided value or environment variables
 */
function getApiKey(providedKey?: string): string | null {
  return providedKey || process.env.OPEN_EXCHANGE_RATES_APP_ID || null;
}

function isRatesData(value: unknown): value is ExchangeRatesData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.base === 'string' && typeof v.fetchedAt === 'string' && typeof v.timestamp === 'number' && typeof v.rates === 'object' && v.rates !== null;
}

/**
 * Load cached exchange rates from disk
 */
async function loadFromDisk(): Promise<ExchangeRatesData | null> {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const cacheFile = path.join(process.cwd(), '.exchange-rates.json');
    const data = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
    return isRatesData(data) ? data : null;
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

/** Cloudflare's shared cache (caches.default), or null on Node and in tests */
function sharedCache(): Cache | null {
  try {
    const store = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    return store && typeof store.match === 'function' && typeof store.put === 'function' ? store : null;
  } catch {
    return null;
  }
}

async function loadShared(): Promise<ExchangeRatesData | null> {
  const cache = sharedCache();
  if (!cache) return null;
  try {
    const response = await cache.match(SHARED_CACHE_URL);
    if (!response) return null;
    const data = await response.json();
    return isRatesData(data) ? data : null;
  } catch {
    return null;
  }
}

async function saveShared(data: ExchangeRatesData): Promise<void> {
  const cache = sharedCache();
  if (!cache) return;
  try {
    await cache.put(
      SHARED_CACHE_URL,
      new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_DURATION_MS / 1000}` } })
    );
  } catch {
    // best effort
  }
}

/**
 * Check if cached data is still valid
 */
function isCacheValid(data: ExchangeRatesData): boolean {
  const age = Date.now() - new Date(data.fetchedAt).getTime();
  return age < CACHE_DURATION_MS;
}

/** Fresh data from memory, the shared cache or disk, or null */
async function freshCached(): Promise<ExchangeRatesData | null> {
  if (memoryCache && isCacheValid(memoryCache)) return memoryCache;
  for (const load of [loadShared, loadFromDisk]) {
    const data = await load();
    if (data && isCacheValid(data)) {
      memoryCache = data;
      return data;
    }
  }
  return null;
}

/** The newest data we have, however old */
async function staleCached(): Promise<ExchangeRatesData | null> {
  return memoryCache ?? (await loadShared()) ?? (await loadFromDisk());
}

/**
 * Fetch latest exchange rates from Open Exchange Rates API
 */
async function fetchFromApi(providedApiKey?: string): Promise<ExchangeRatesData> {
  const apiKey = getApiKey(providedApiKey);

  if (!apiKey) {
    throw new NoApiKeyError();
  }

  const url = `${API_BASE_URL}/latest.json?app_id=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    // The body may echo request details; it is not passed on
    await response.body?.cancel().catch(() => {});
    throw new Error(`Open Exchange Rates API error: ${response.status}`);
  }

  const data: OpenExchangeRatesResponse = await response.json();

  return {
    base: data.base,
    rates: data.rates,
    timestamp: data.timestamp,
    fetchedAt: new Date().toISOString(),
  };
}

async function store(fresh: ExchangeRatesData): Promise<void> {
  memoryCache = fresh;
  await saveShared(fresh);
  await saveToDisk(fresh);
}

/**
 * One upstream request with the operator's key (OPEN_EXCHANGE_RATES_APP_ID).
 * The only fetch whose failure is remembered and whose promise is shared:
 * both describe the operator key, so nothing a visitor sends can affect them.
 */
async function fetchWithOperatorKey(): Promise<ExchangeRatesData> {
  try {
    const fresh = await fetchFromApi();
    lastFailure = null;
    await store(fresh);
    return fresh;
  } catch (error) {
    if (!(error instanceof NoApiKeyError)) lastFailure = { at: Date.now(), error };
    const stale = await staleCached();
    if (stale) {
      console.warn('Using stale exchange rates cache due to API error:', error instanceof Error ? error.message : error);
      return stale;
    }
    throw error;
  }
}

/**
 * One upstream request with a user's own key (kept in their browser, sent in
 * X-PK-OER-Key). Its result goes to that caller only: it never fills the
 * memory, platform or disk caches, so data fetched with a key anyone can
 * send never reaches other visitors. It never shares a promise with other
 * requests or touches the operator key's failure memory either. Limited per
 * isolate (USER_KEY_FETCHES_PER_MINUTE); over the limit, cached operator
 * data is served.
 */
async function fetchWithUserKey(apiKey: string): Promise<ExchangeRatesData> {
  if (!userKeyFetches.attempt(undefined).allowed) {
    const stale = await staleCached();
    if (stale) return stale;
    throw new UserKeyRateLimitedError();
  }
  try {
    return await fetchFromApi(apiKey);
  } catch (error) {
    const stale = await staleCached();
    if (stale) return stale;
    throw error;
  }
}

/**
 * Exchange rates, from a cache when one is fresh (6 hours).
 *
 * With the user's own key (`apiKey`, from X-PK-OER-Key) a miss, or a
 * `forceRefresh`, goes upstream with that key, on its own and rate limited,
 * and the result is returned to that caller without being cached. Otherwise the
 * operator's key (OPEN_EXCHANGE_RATES_APP_ID) is used: concurrent misses
 * share one upstream request, and after a failure no request is sent for 5
 * minutes (stale data, if any, is served meanwhile; else the same error).
 * `forceRefresh` never spends the operator key: without a user key it is
 * served from the caches like any other request.
 */
export async function getExchangeRates(forceRefresh = false, apiKey?: string): Promise<ExchangeRatesData> {
  if (!(forceRefresh && apiKey)) {
    const cached = await freshCached();
    if (cached) return cached;
  }
  if (apiKey) return fetchWithUserKey(apiKey);

  // A missing key fails without contacting anyone; it isn't cached (a key may be added any moment)
  if (!getApiKey()) {
    const stale = await staleCached();
    if (stale) return stale;
    throw new NoApiKeyError();
  }
  if (lastFailure && Date.now() - lastFailure.at < FAILURE_CACHE_MS) {
    const stale = await staleCached();
    if (stale) return stale;
    throw lastFailure.error;
  }
  if (!inFlight) {
    inFlight = fetchWithOperatorKey().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
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
  const cachedData = await staleCached();

  return {
    hasApiKey: !!apiKey,
    hasCachedData: !!cachedData,
    cacheAge: cachedData ? Date.now() - new Date(cachedData.fetchedAt).getTime() : null,
    isValid: cachedData ? isCacheValid(cachedData) : false,
    currencyCount: cachedData ? Object.keys(cachedData.rates).length : 0,
  };
}
