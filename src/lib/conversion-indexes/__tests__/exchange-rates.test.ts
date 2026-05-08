import { describe, it, expect } from 'vitest';
import { FALLBACK_EXCHANGE_RATES } from '../exchange-rates';
import { LOCAL_CURRENCIES } from '../ppp';

const ISO_CURRENCY = /^[A-Z]{3}$/;

describe('FALLBACK_EXCHANGE_RATES', () => {
  it('has at least one entry', () => {
    expect(Object.keys(FALLBACK_EXCHANGE_RATES).length).toBeGreaterThan(0);
  });

  it('every key is a 3-letter ISO currency code', () => {
    for (const code of Object.keys(FALLBACK_EXCHANGE_RATES)) {
      expect(code).toMatch(ISO_CURRENCY);
    }
  });

  it('every value is a positive finite number', () => {
    for (const [code, rate] of Object.entries(FALLBACK_EXCHANGE_RATES)) {
      expect(typeof rate, code).toBe('number');
      expect(Number.isFinite(rate), code).toBe(true);
      expect(rate, code).toBeGreaterThan(0);
    }
  });

  it('USD maps to 1.0 (base currency)', () => {
    // FALLBACK_EXCHANGE_RATES is keyed USD->X. USD itself may or may not be present.
    // If present, must be 1; if absent, that's also acceptable.
    if ('USD' in FALLBACK_EXCHANGE_RATES) {
      expect(FALLBACK_EXCHANGE_RATES.USD).toBe(1);
    }
  });
});

describe('cross-index: LOCAL_CURRENCIES coverage by FALLBACK_EXCHANGE_RATES', () => {
  it('every currency referenced by LOCAL_CURRENCIES has a FALLBACK_EXCHANGE_RATES entry (or is USD)', () => {
    const referenced = new Set(Object.values(LOCAL_CURRENCIES));
    const missing = [...referenced].filter(
      (currency) => currency !== 'USD' && !(currency in FALLBACK_EXCHANGE_RATES)
    );
    expect(
      missing,
      `currencies missing fallback rate: ${missing.join(', ')}`
    ).toEqual([]);
  });
});
