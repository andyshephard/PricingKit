import { describe, it, expect } from 'vitest';
import { getSupportedAppleTerritories } from '../../apple-connect/territories';
import {
  NETFLIX_PRICE_INDEX,
  DEFAULT_NETFLIX_MULTIPLIER,
  getNetflixMultiplier,
  getAllNetflixData,
} from '../netflix';

const ALPHA2 = /^[A-Z]{2}$/;

describe('NETFLIX_PRICE_INDEX', () => {
  it('has at least one entry', () => {
    expect(Object.keys(NETFLIX_PRICE_INDEX).length).toBeGreaterThan(0);
  });

  it('every key is alpha-2', () => {
    for (const code of Object.keys(NETFLIX_PRICE_INDEX)) {
      expect(code).toMatch(ALPHA2);
    }
  });

  it('every multiplier is a finite number in [0.1, 2.0]', () => {
    for (const [code, entry] of Object.entries(NETFLIX_PRICE_INDEX)) {
      expect(typeof entry.multiplier, code).toBe('number');
      expect(Number.isFinite(entry.multiplier), code).toBe(true);
      expect(entry.multiplier, code).toBeGreaterThanOrEqual(0.1);
      expect(entry.multiplier, code).toBeLessThanOrEqual(2.0);
    }
  });

  it('covers every supported Apple territory alpha-2 code', () => {
    for (const territory of getSupportedAppleTerritories()) {
      expect(NETFLIX_PRICE_INDEX[territory.alpha2], territory.alpha2).toBeDefined();
    }
  });

  it('marks explicit inferred regions with their source region', () => {
    expect(NETFLIX_PRICE_INDEX.CN).toMatchObject({ source: 'inferred', inferredFrom: 'HK' });
    expect(NETFLIX_PRICE_INDEX.XK).toMatchObject({ source: 'inferred', inferredFrom: 'AL' });
    expect(NETFLIX_PRICE_INDEX.RU).toMatchObject({ source: 'inferred', inferredFrom: 'BY' });
  });
});

describe('DEFAULT_NETFLIX_MULTIPLIER', () => {
  it('is in valid range', () => {
    expect(DEFAULT_NETFLIX_MULTIPLIER).toBeGreaterThanOrEqual(0.1);
    expect(DEFAULT_NETFLIX_MULTIPLIER).toBeLessThanOrEqual(2.0);
  });
});

describe('getNetflixMultiplier', () => {
  it('returns the matching value for a known region', () => {
    expect(getNetflixMultiplier('BR')).toBe(NETFLIX_PRICE_INDEX.BR.multiplier);
  });

  it('returns the default for an unknown region', () => {
    expect(getNetflixMultiplier('XX')).toBe(DEFAULT_NETFLIX_MULTIPLIER);
  });
});

describe('getAllNetflixData', () => {
  it('exposes every NETFLIX_PRICE_INDEX entry with source metadata', () => {
    const data = getAllNetflixData();
    for (const [code, entry] of Object.entries(NETFLIX_PRICE_INDEX)) {
      expect(data[code]).toEqual({
        multiplier: entry.multiplier,
        source: entry.source,
        ...(entry.inferredFrom ? { inferredFrom: entry.inferredFrom } : {}),
      });
    }
  });
});
