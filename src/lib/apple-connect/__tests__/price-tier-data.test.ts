import { describe, it, expect } from 'vitest';
import {
  findClosestTierForCurrency,
  getAvailableCurrencies,
  getUsdPriceTiers,
  getPriceTiersForCurrency,
  hasTierData,
} from '../price-tier-data';
import { APPLE_TERRITORIES, UNSUPPORTED_IAP_TERRITORIES } from '../territories';

describe('hasTierData', () => {
  it('returns true (data is loaded)', () => {
    expect(hasTierData()).toBe(true);
  });
});

describe('getAvailableCurrencies', () => {
  it('is non-empty', () => {
    expect(getAvailableCurrencies().length).toBeGreaterThan(0);
  });

  it('includes the major currencies', () => {
    const currencies = getAvailableCurrencies();
    for (const c of ['USD', 'GBP', 'EUR', 'JPY']) {
      expect(currencies, c).toContain(c);
    }
  });
});

describe('getPriceTiersForCurrency', () => {
  it('returns USD tiers via getUsdPriceTiers (same data)', () => {
    expect(getPriceTiersForCurrency('USD')).toEqual(getUsdPriceTiers());
  });

  it('returns an empty array for unknown currencies', () => {
    expect(getPriceTiersForCurrency('XYZ')).toEqual([]);
  });

  // Thousands of tiers: checked in plain loops with one assertion at the end (one expect per
  // tier made this slow enough to time out under load), with a generous timeout as well
  it('every currency returns sorted-ascending tiers with no duplicates', { timeout: 30_000 }, () => {
    const problems: string[] = [];
    for (const currency of getAvailableCurrencies()) {
      const tiers = getPriceTiersForCurrency(currency);

      // Some currencies in the dataset have no tiers (e.g. BDT). Allow empty.
      if (tiers.length === 0) continue;

      for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i];
        // Every entry has the required shape
        if (typeof t.price !== 'number' || !Number.isFinite(t.price) || t.price <= 0) problems.push(`${currency} tier ${i}: bad price ${String(t.price)}`);
        if (typeof t.tier !== 'string') problems.push(`${currency} tier ${i}: tier is not a string`);
        // Sorted ascending by price
        if (i > 0 && t.price < tiers[i - 1].price) problems.push(`${currency} tier ${i}: ${t.price} below ${tiers[i - 1].price}`);
      }

      // Tier IDs unique
      const ids = tiers.map((t) => t.tier);
      if (new Set(ids).size !== ids.length) problems.push(`${currency}: duplicate tier IDs`);
    }
    expect(problems).toEqual([]);
  });

  it('major currencies (USD, GBP, EUR, JPY) have tiers', () => {
    for (const c of ['USD', 'GBP', 'EUR', 'JPY']) {
      expect(getPriceTiersForCurrency(c).length, c).toBeGreaterThan(0);
    }
  });
});

describe('findClosestTierForCurrency', () => {
  it('returns null for unknown currency', () => {
    expect(findClosestTierForCurrency(10, 'XYZ')).toBeNull();
  });

  it('returns the lowest tier for a sub-minimum price', () => {
    const usdTiers = getUsdPriceTiers();
    const lowest = usdTiers[0];
    const result = findClosestTierForCurrency(0.001, 'USD');
    expect(result).not.toBeNull();
    expect(result!.price).toBe(lowest.price);
  });

  it('returns the highest tier for an above-maximum price', () => {
    const usdTiers = getUsdPriceTiers();
    const highest = usdTiers[usdTiers.length - 1];
    const result = findClosestTierForCurrency(10_000_000, 'USD');
    expect(result).not.toBeNull();
    expect(result!.price).toBe(highest.price);
  });

  it('returns the exact tier when price matches', () => {
    const usdTiers = getUsdPriceTiers();
    const target = usdTiers[Math.floor(usdTiers.length / 2)];
    const result = findClosestTierForCurrency(target.price, 'USD');
    expect(result).not.toBeNull();
    expect(result!.price).toBe(target.price);
    expect(result!.tier).toBe(target.tier);
  });
});

describe('cross-data: Apple territories ↔ tier data', () => {
  it('every supported Apple territory currency has tier data', () => {
    const tierCurrencies = new Set(getAvailableCurrencies());
    const supported = APPLE_TERRITORIES.filter(
      (t) => !UNSUPPORTED_IAP_TERRITORIES.includes(t.alpha3)
    );
    const missing = supported.filter((t) => !tierCurrencies.has(t.currency));
    expect(
      missing.map((t) => `${t.alpha3} (${t.currency})`),
      'territories whose currency has no Apple tier data'
    ).toEqual([]);
  });
});
