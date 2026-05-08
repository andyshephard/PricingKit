import { describe, it, expect } from 'vitest';
import { GOOGLE_PLAY_REGIONS } from '../types';

const ALPHA2 = /^[A-Z]{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

describe('GOOGLE_PLAY_REGIONS', () => {
  it('has at least one entry', () => {
    expect(GOOGLE_PLAY_REGIONS.length).toBeGreaterThan(0);
  });

  it('every entry has the required shape', () => {
    for (const r of GOOGLE_PLAY_REGIONS) {
      expect(r.code).toMatch(ALPHA2);
      expect(r.name, r.code).toBeTruthy();
      expect(r.currency, r.code).toMatch(ISO_CURRENCY);
    }
  });

  it('region codes are unique', () => {
    const codes = GOOGLE_PLAY_REGIONS.map((r) => r.code);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it('includes US', () => {
    expect(GOOGLE_PLAY_REGIONS.some((r) => r.code === 'US')).toBe(true);
  });
});
