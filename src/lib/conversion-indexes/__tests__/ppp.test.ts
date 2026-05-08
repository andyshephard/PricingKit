import { describe, it, expect } from 'vitest';
import {
  PRICING_INDEX,
  DEFAULT_PRICING_INDEX_ENTRY,
  LOCAL_CURRENCIES,
  getPricingIndexEntry,
} from '../ppp';

const ALPHA2 = /^[A-Z]{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

describe('PRICING_INDEX', () => {
  it('has at least one entry', () => {
    expect(Object.keys(PRICING_INDEX).length).toBeGreaterThan(0);
  });

  it('every key is an ISO 3166-1 alpha-2 region code', () => {
    for (const code of Object.keys(PRICING_INDEX)) {
      expect(code).toMatch(ALPHA2);
    }
  });

  it('every entry has the required shape', () => {
    for (const [code, entry] of Object.entries(PRICING_INDEX)) {
      expect(entry, code).toEqual(
        expect.objectContaining({
          regionCode: expect.any(String),
          pppMultiplier: expect.any(Number),
          minPrice: expect.any(Number),
          suggestedRounding: expect.any(Number),
        })
      );
      expect(entry.regionCode, code).toBe(code);
    }
  });

  it('every pppMultiplier is in the documented [0.1, 2.0] range', () => {
    for (const [code, entry] of Object.entries(PRICING_INDEX)) {
      expect(entry.pppMultiplier, code).toBeGreaterThanOrEqual(0.1);
      expect(entry.pppMultiplier, code).toBeLessThanOrEqual(2.0);
    }
  });

  it('every minPrice is non-negative', () => {
    for (const [code, entry] of Object.entries(PRICING_INDEX)) {
      expect(entry.minPrice, code).toBeGreaterThanOrEqual(0);
    }
  });

  it('US is the reference at multiplier 1.0', () => {
    expect(PRICING_INDEX.US).toBeDefined();
    expect(PRICING_INDEX.US.pppMultiplier).toBe(1.0);
  });
});

describe('DEFAULT_PRICING_INDEX_ENTRY', () => {
  it('has the same shape as a regular entry', () => {
    expect(DEFAULT_PRICING_INDEX_ENTRY).toEqual(
      expect.objectContaining({
        regionCode: expect.any(String),
        pppMultiplier: expect.any(Number),
        minPrice: expect.any(Number),
        suggestedRounding: expect.any(Number),
      })
    );
  });

  it('multiplier in valid range', () => {
    expect(DEFAULT_PRICING_INDEX_ENTRY.pppMultiplier).toBeGreaterThanOrEqual(0.1);
    expect(DEFAULT_PRICING_INDEX_ENTRY.pppMultiplier).toBeLessThanOrEqual(2.0);
  });
});

describe('getPricingIndexEntry', () => {
  it('returns the matching entry for a known region', () => {
    expect(getPricingIndexEntry('US')).toEqual(PRICING_INDEX.US);
    expect(getPricingIndexEntry('GB')).toEqual(PRICING_INDEX.GB);
  });

  it('returns the default entry for an unknown region', () => {
    const result = getPricingIndexEntry('XX');
    expect(result.pppMultiplier).toBe(DEFAULT_PRICING_INDEX_ENTRY.pppMultiplier);
    expect(result.minPrice).toBe(DEFAULT_PRICING_INDEX_ENTRY.minPrice);
    expect(result.regionCode).toBe('XX');
  });
});

describe('LOCAL_CURRENCIES', () => {
  it('has at least one entry', () => {
    expect(Object.keys(LOCAL_CURRENCIES).length).toBeGreaterThan(0);
  });

  it('every key is alpha-2', () => {
    for (const code of Object.keys(LOCAL_CURRENCIES)) {
      expect(code).toMatch(ALPHA2);
    }
  });

  it('every value is a 3-letter ISO currency code', () => {
    for (const [code, currency] of Object.entries(LOCAL_CURRENCIES)) {
      expect(currency, code).toMatch(ISO_CURRENCY);
    }
  });

  it('US maps to USD', () => {
    expect(LOCAL_CURRENCIES.US).toBe('USD');
  });
});

describe('cross-index consistency', () => {
  it('every PRICING_INDEX region has a LOCAL_CURRENCIES entry', () => {
    const missing = Object.keys(PRICING_INDEX).filter(
      (code) => !(code in LOCAL_CURRENCIES)
    );
    expect(missing, `regions missing currency: ${missing.join(', ')}`).toEqual([]);
  });
});
