import { describe, it, expect } from 'vitest';
import {
  BIG_MAC_INDEX,
  DEFAULT_BIG_MAC_MULTIPLIER,
  getBigMacMultiplier,
  getAllBigMacData,
} from '../big-mac';

const ALPHA2 = /^[A-Z]{2}$/;

describe('BIG_MAC_INDEX', () => {
  it('has at least one entry', () => {
    expect(Object.keys(BIG_MAC_INDEX).length).toBeGreaterThan(0);
  });

  it('every key is alpha-2', () => {
    for (const code of Object.keys(BIG_MAC_INDEX)) {
      expect(code).toMatch(ALPHA2);
    }
  });

  it('every multiplier is a positive finite number in [0.1, 2.0]', () => {
    for (const [code, value] of Object.entries(BIG_MAC_INDEX)) {
      expect(typeof value, code).toBe('number');
      expect(Number.isFinite(value), code).toBe(true);
      expect(value, code).toBeGreaterThan(0);
      expect(value, code).toBeGreaterThanOrEqual(0.1);
      expect(value, code).toBeLessThanOrEqual(2.0);
    }
  });
});

describe('DEFAULT_BIG_MAC_MULTIPLIER', () => {
  it('is in valid range', () => {
    expect(DEFAULT_BIG_MAC_MULTIPLIER).toBeGreaterThanOrEqual(0.1);
    expect(DEFAULT_BIG_MAC_MULTIPLIER).toBeLessThanOrEqual(2.0);
  });
});

describe('getBigMacMultiplier', () => {
  it('returns the matching value for a known region', () => {
    const someKnown = Object.keys(BIG_MAC_INDEX)[0];
    expect(getBigMacMultiplier(someKnown)).toBe(BIG_MAC_INDEX[someKnown]);
  });

  it('returns the default for an unknown region', () => {
    expect(getBigMacMultiplier('XX')).toBe(DEFAULT_BIG_MAC_MULTIPLIER);
  });
});

describe('getAllBigMacData', () => {
  it('exposes every BIG_MAC_INDEX entry with source = big-mac-index', () => {
    const data = getAllBigMacData();
    for (const [code, value] of Object.entries(BIG_MAC_INDEX)) {
      expect(data[code]).toEqual({ multiplier: value, source: 'big-mac-index' });
    }
  });
});
