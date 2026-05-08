import { describe, it, expect } from 'vitest';
import {
  APPLE_TERRITORIES,
  UNSUPPORTED_IAP_TERRITORIES,
  getSupportedAppleTerritories,
  alpha2ToAlpha3,
  alpha3ToAlpha2,
  getTerritoryByAlpha2,
  getTerritoryByAlpha3,
  getCurrencyForTerritory,
} from '../territories';

const ALPHA2 = /^[A-Z]{2}$/;
const ALPHA3 = /^[A-Z]{3}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

describe('APPLE_TERRITORIES', () => {
  it('has at least one entry', () => {
    expect(APPLE_TERRITORIES.length).toBeGreaterThan(0);
  });

  it('every entry has the required shape', () => {
    for (const t of APPLE_TERRITORIES) {
      expect(t.alpha3, t.alpha3).toMatch(ALPHA3);
      expect(t.alpha2, t.alpha3).toMatch(ALPHA2);
      expect(t.name, t.alpha3).toBeTruthy();
      expect(t.currency, t.alpha3).toMatch(ISO_CURRENCY);
    }
  });

  it('alpha-3 codes are unique', () => {
    const codes = APPLE_TERRITORIES.map((t) => t.alpha3);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it('alpha-2 codes are unique', () => {
    const codes = APPLE_TERRITORIES.map((t) => t.alpha2);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it('includes USA', () => {
    expect(APPLE_TERRITORIES.some((t) => t.alpha3 === 'USA')).toBe(true);
  });
});

describe('alpha2 ↔ alpha3 conversion', () => {
  it('alpha2ToAlpha3("US") returns "USA"', () => {
    expect(alpha2ToAlpha3('US')).toBe('USA');
  });

  it('alpha3ToAlpha2("USA") returns "US"', () => {
    expect(alpha3ToAlpha2('USA')).toBe('US');
  });

  it('round-trips every territory', () => {
    for (const t of APPLE_TERRITORIES) {
      expect(alpha2ToAlpha3(t.alpha2)).toBe(t.alpha3);
      expect(alpha3ToAlpha2(t.alpha3)).toBe(t.alpha2);
    }
  });

  it('returns null for unknown codes', () => {
    expect(alpha2ToAlpha3('XX')).toBeNull();
    expect(alpha3ToAlpha2('XXX')).toBeNull();
  });
});

describe('getTerritoryByAlpha2 / getTerritoryByAlpha3', () => {
  it('return the same territory for matching alpha-2 and alpha-3 inputs', () => {
    const usByAlpha2 = getTerritoryByAlpha2('US');
    const usByAlpha3 = getTerritoryByAlpha3('USA');
    expect(usByAlpha2).toEqual(usByAlpha3);
    expect(usByAlpha2?.alpha2).toBe('US');
    expect(usByAlpha2?.alpha3).toBe('USA');
  });

  it('return null for unknown codes', () => {
    expect(getTerritoryByAlpha2('XX')).toBeNull();
    expect(getTerritoryByAlpha3('XXX')).toBeNull();
  });
});

describe('getCurrencyForTerritory', () => {
  it('returns the matching currency for known territories', () => {
    expect(getCurrencyForTerritory('US')).toBe('USD');
  });

  it('returns null for unknown territories', () => {
    expect(getCurrencyForTerritory('XX')).toBeNull();
  });
});

describe('getSupportedAppleTerritories', () => {
  it('is non-empty', () => {
    expect(getSupportedAppleTerritories().length).toBeGreaterThan(0);
  });

  it('excludes UNSUPPORTED_IAP_TERRITORIES', () => {
    const supported = getSupportedAppleTerritories();
    for (const unsupported of UNSUPPORTED_IAP_TERRITORIES) {
      expect(supported.some((t) => t.alpha3 === unsupported)).toBe(false);
    }
  });

  it('is a subset of APPLE_TERRITORIES', () => {
    const supported = getSupportedAppleTerritories();
    const allCodes = new Set(APPLE_TERRITORIES.map((t) => t.alpha3));
    for (const t of supported) {
      expect(allCodes.has(t.alpha3)).toBe(true);
    }
  });
});
