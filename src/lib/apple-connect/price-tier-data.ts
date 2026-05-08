// Auto-generated Apple price tier data
// Generated: 2026-02-02T14:47:17.218Z
// Source: Apple App Store Connect API
//
// DO NOT EDIT MANUALLY - regenerate using: npx ts-node scripts/fetch-apple-price-tiers.ts

import rawData from './price-tier-data.json';

export interface TierData {
  price: number;
  tier: string;
}

/**
 * Map of currency code to array of { price, tier } sorted by price.
 * Used to find the closest Apple tier for a given local currency amount.
 *
 * Lazily transformed from compact JSON tuples [price, tier] on first access.
 */
let _cache: Record<string, TierData[]> | null = null;

function getTiers(): Record<string, TierData[]> {
  if (!_cache) {
    const result: Record<string, TierData[]> = {};
    for (const [currency, tuples] of Object.entries(rawData)) {
      result[currency] = (tuples as [number, string][]).map(([price, tier]) => ({ price, tier }));
    }
    _cache = result;
  }
  return _cache;
}

export const CURRENCY_PRICE_TIERS: Record<string, TierData[]> = new Proxy(
  {} as Record<string, TierData[]>,
  {
    get(_target, prop: string) {
      return getTiers()[prop];
    },
    has(_target, prop: string) {
      return prop in getTiers();
    },
    ownKeys() {
      return Object.keys(getTiers());
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      const tiers = getTiers();
      if (prop in tiers) {
        return { configurable: true, enumerable: true, value: tiers[prop] };
      }
      return undefined;
    },
  }
);

/**
 * Find the closest tier for a given amount in a specific currency.
 */
export function findClosestTierForCurrency(
  amount: number,
  currencyCode: string
): { tier: string; price: number } | null {
  const tiers = getTiers()[currencyCode];
  if (!tiers || tiers.length === 0) {
    return null;
  }

  let closest = tiers[0];
  let minDiff = Math.abs(closest.price - amount);

  for (const tier of tiers) {
    const diff = Math.abs(tier.price - amount);
    if (diff < minDiff) {
      minDiff = diff;
      closest = tier;
    }
  }

  return { tier: closest.tier, price: closest.price };
}

/**
 * Get all available currencies that have tier data.
 */
export function getAvailableCurrencies(): string[] {
  return Object.keys(getTiers());
}

/**
 * Check if tier data has been loaded.
 */
export function hasTierData(): boolean {
  return Object.keys(getTiers()).length > 0;
}

/**
 * Get all USD price tiers sorted by price.
 * Useful for displaying a tier selector in the UI.
 */
export function getUsdPriceTiers(): TierData[] {
  return getTiers()['USD'] || [];
}

/**
 * Get all Apple price tiers for a given currency, sorted by price.
 * Returns an empty array if Apple has no tier data for the currency.
 */
export function getPriceTiersForCurrency(currency: string): TierData[] {
  return getTiers()[currency] || [];
}
