import { describe, it, expect } from 'vitest';
import {
  calculateRegionalPrice,
  calculateBulkPrices,
} from '../currency';
import { calculateNewPrice } from '../products';
import {
  TEST_PPP_DATA,
  TEST_EXCHANGE_RATES,
  APPLE_BILLED_IN_USD,
} from './fixtures/ppp-snapshot';
import type { Money } from '../types';
import { getNetflixMultiplier } from '../../conversion-indexes/netflix';

describe('calculateRegionalPrice — direct strategy', () => {
  it('US base: applies exchange rate only (multiplier 1.0)', () => {
    const result = calculateRegionalPrice(
      49.99,
      'DE',
      'direct',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.multiplier).toBeCloseTo(1.0, 6);
    expect(result.multiplierSource).toBe('direct');
    expect(result.currencyCode).toBe('EUR');
    expect(result.rawPrice).toBeCloseTo(49.99 * 0.851, 2);
  });

  it('TR same-currency: 49.99 USD → 49.99 × TRY rate', () => {
    const result = calculateRegionalPrice(
      49.99,
      'TR',
      'direct',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.rawPrice).toBeCloseTo(49.99 * 45.2557, 2);
    expect(result.multiplier).toBeCloseTo(1.0, 6);
  });
});

describe('calculateRegionalPrice — PPP strategy, US base', () => {
  it('DE: same-currency formula → baseUsdPrice × pppFactor', () => {
    const result = calculateRegionalPrice(
      49.99,
      'DE',
      'ppp',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    // PPP fair price in EUR: 49.99 × 0.7053 ≈ 35.25
    expect(result.rawPrice).toBeCloseTo(49.99 * 0.7053, 1);
    expect(result.multiplierSource).toBe('world-bank');
    expect(result.currencyCode).toBe('EUR');
  });

  it('TR: same-currency formula → 49.99 × 15.1551 TRY ≈ ₺757.6', () => {
    const result = calculateRegionalPrice(
      49.99,
      'TR',
      'ppp',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.rawPrice).toBeCloseTo(49.99 * 15.1551, 1);
  });

  it('IN: same-currency → 49.99 × 20.4220 INR ≈ ₹1020.9', () => {
    const result = calculateRegionalPrice(
      49.99,
      'IN',
      'ppp',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.rawPrice).toBeCloseTo(49.99 * 20.4220, 1);
  });

  it('US (base region itself): multiplier exactly 1.0 — guards against AFG-as-base inversion', () => {
    const result = calculateRegionalPrice(
      0.99,
      'US',
      'ppp',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.multiplier).toBeCloseTo(1.0, 6);
    expect(result.rawPrice).toBeCloseTo(0.99, 2);
  });
});

describe('calculateRegionalPrice — PPP strategy, mixed billing/local currency', () => {
  it('AR billed in USD: hyperinflation override → 0.25 affordability multiplier', () => {
    // AR pppFactor = 400, marketRate = 100 → pppPriceInUsd = 49.99 × 400 / 100 = $199.96
    // Exceeds baseUsdPrice ($49.99) → override fires
    const result = calculateRegionalPrice(
      49.99,
      'AR',
      'ppp',
      'none',
      undefined,
      TEST_PPP_DATA,
      APPLE_BILLED_IN_USD,
      TEST_EXCHANGE_RATES
    );
    expect(result.currencyCode).toBe('USD');
    // 49.99 × 0.25 × 1.0 (USD billing rate) = $12.4975
    expect(result.rawPrice).toBeCloseTo(49.99 * 0.25, 2);
    expect(result.multiplier).toBe(0.25);
    expect(result.multiplierSource).toBe('static');
  });
});

describe('calculateRegionalPrice — PPP, non-USD base region', () => {
  it('DE base €40 → TR target: normalises EUR→USD then PPP relative to DE', () => {
    const result = calculateRegionalPrice(
      40,
      'TR',
      'ppp',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES,
      'EUR',
      'DE'
    );
    // baseUsdPrice = 40 / 0.851 ≈ 47.0035
    const baseUsd = 40 / 0.851;
    // rawRealMultiplier (TR) = 15.1551 / 45.2557 ≈ 0.33488
    const trReal = 15.1551 / 45.2557;
    // baseRealMultiplier (DE) = 0.7053 / 0.851 ≈ 0.82879
    const deReal = 0.7053 / 0.851;
    const effective = trReal / deReal;
    // calculatedPrice = baseUsd × effective × TRY rate
    const expected = baseUsd * effective * 45.2557;
    expect(result.rawPrice).toBeCloseTo(expected, 1);
    expect(result.multiplier).toBeCloseTo(effective, 4);
  });

  it('US base, DE target: baseRealMultiplier = 1 cancels out — same as before', () => {
    const result = calculateRegionalPrice(
      49.99,
      'DE',
      'ppp',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    // multiplier = (0.7053 / 0.851) / (1/1) ≈ 0.82879
    expect(result.multiplier).toBeCloseTo(0.7053 / 0.851, 4);
  });
});

describe('calculateRegionalPrice — Big Mac strategy', () => {
  it('returns multiplier from BIG_MAC_INDEX normalised by base region', () => {
    const result = calculateRegionalPrice(
      49.99,
      'CH', // Switzerland — known higher than US
      'bigmac',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.multiplierSource).toBe('big-mac');
    // CH big-mac multiplier > 1 because Swiss prices are higher than US
    expect(result.multiplier).toBeGreaterThan(1);
  });
});

describe('calculateRegionalPrice — Netflix strategy', () => {
  it('returns multiplier from NETFLIX_PRICE_INDEX normalised by base region', () => {
    const result = calculateRegionalPrice(
      40,
      'BR',
      'netflix',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES,
      'EUR',
      'DE'
    );

    const baseUsd = 40 / 0.851;
    const effective = getNetflixMultiplier('BR') / getNetflixMultiplier('DE');
    const expected = baseUsd * effective * 4.917;

    expect(result.multiplierSource).toBe('netflix');
    expect(result.multiplier).toBeCloseTo(effective, 4);
    expect(result.rawPrice).toBeCloseTo(expected, 1);
  });
});

describe('calculateRegionalPrice — custom strategy', () => {
  it('applies the user-supplied custom multiplier verbatim', () => {
    const result = calculateRegionalPrice(
      49.99,
      'DE',
      'custom',
      'none',
      0.5,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.multiplier).toBe(0.5);
    expect(result.multiplierSource).toBe('custom');
    // 49.99 × 0.5 × 0.851 ≈ 21.27
    expect(result.rawPrice).toBeCloseTo(49.99 * 0.5 * 0.851, 1);
  });
});

describe('calculateRegionalPrice — free price', () => {
  it('basePrice = 0 returns rawPrice 0 (skips multiplier math)', () => {
    const result = calculateRegionalPrice(
      0,
      'DE',
      'ppp',
      'nearest-99',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.rawPrice).toBe(0);
    // Free path returns multiplier as the identity (1) — exits before any math
    expect(result.multiplier).toBe(1);
  });
});

describe('calculateRegionalPrice — rounding modes', () => {
  it('nearest-99: 12.34 → 11.99 (closest .99 ending)', () => {
    const result = calculateRegionalPrice(
      12.34,
      'US',
      'direct',
      'nearest-99',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.rawPrice).toBe(11.99);
  });

  it('nearest-99: 0.50 → 0.99 (floor-clamped)', () => {
    const result = calculateRegionalPrice(
      0.50,
      'US',
      'direct',
      'nearest-99',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.rawPrice).toBe(0.99);
  });

  it('round-up: 12.34 → 12.99 (next .99)', () => {
    const result = calculateRegionalPrice(
      12.34,
      'US',
      'direct',
      'round-up',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.rawPrice).toBe(12.99);
  });

  it('round-up: 0.50 → 0.99 (next .99)', () => {
    const result = calculateRegionalPrice(
      0.50,
      'US',
      'direct',
      'round-up',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.rawPrice).toBe(0.99);
  });

  it('round-up: 2.99 → 2.99 (already .99, no-op)', () => {
    const result = calculateRegionalPrice(
      2.99,
      'US',
      'direct',
      'round-up',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.rawPrice).toBe(2.99);
  });

  it('round-up: 1.46 → 1.99 (regression: was bugged in charm mode)', () => {
    // PPP-style: base 2.99 USD × 0.49 ≈ 1.46. Apple AL bug context.
    const result = calculateRegionalPrice(
      2.99,
      'US',
      'custom',
      'round-up',
      0.49,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    // 2.99 × 0.49 = 1.4651 → round-up → 1.99
    expect(result.rawPrice).toBe(1.99);
  });

  it('nearest-tier: 1.46 → 1.49 when tier list provided', () => {
    const result = calculateRegionalPrice(
      2.99,
      'US',
      'custom',
      'nearest-tier',
      0.49,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES,
      'USD',
      'US',
      () => [{ price: 0.99 }, { price: 1.49 }, { price: 1.99 }]
    );
    expect(result.rawPrice).toBe(1.49);
  });

  it('nearest-tier without tiers falls back to nearest-99', () => {
    const result = calculateRegionalPrice(
      2.99,
      'US',
      'custom',
      'nearest-tier',
      0.49,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    // No callback → falls back to nearest-99 (1.46 → 0.99)
    expect(result.rawPrice).toBe(0.99);
  });

  it('none: 12.34 → unchanged (after .01 epsilon round)', () => {
    const result = calculateRegionalPrice(
      12.34,
      'US',
      'direct',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result.rawPrice).toBeCloseTo(12.34, 2);
  });
});

describe('calculateRegionalPrice — unknown / fallback regions', () => {
  it('unknown region uses default static entry, returns USD billing fallback', () => {
    const result = calculateRegionalPrice(
      49.99,
      'XX',
      'ppp',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    // Unknown → no dynamic entry → static fallback: pppMultiplier 0.5 / basePppMultiplier 1.0 → 0.5
    expect(result.multiplier).toBeCloseTo(0.5, 6);
    expect(result.multiplierSource).toBe('static');
  });
});

describe('calculateBulkPrices', () => {
  it('returns one entry per region in order', () => {
    const regions = ['US', 'DE', 'TR', 'IN'];
    const result = calculateBulkPrices(
      49.99,
      regions,
      'ppp',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.regionCode)).toEqual(regions);
  });

  it('empty regionCodes returns empty array', () => {
    const result = calculateBulkPrices(
      49.99,
      [],
      'ppp',
      'none',
      undefined,
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result).toEqual([]);
  });

  it('customMultipliers map applied per-region (custom strategy)', () => {
    const result = calculateBulkPrices(
      100,
      ['DE', 'TR'],
      'custom',
      'none',
      { DE: 0.5, TR: 0.25 },
      TEST_PPP_DATA,
      undefined,
      TEST_EXCHANGE_RATES
    );
    expect(result[0].multiplier).toBe(0.5);
    expect(result[1].multiplier).toBe(0.25);
  });
});

describe('calculateNewPrice', () => {
  const baseMoney = (value: number, currency = 'USD'): Money => {
    const units = Math.floor(value);
    const nanos = Math.round((value - units) * 1_000_000_000);
    return {
      currencyCode: currency,
      units: units.toString(),
      nanos: nanos > 0 ? nanos : undefined,
    };
  };

  it('fixed: replaces with the specified value', () => {
    const result = calculateNewPrice(baseMoney(50), { type: 'fixed', value: 9.99 });
    expect(result.currencyCode).toBe('USD');
    expect(result.units).toBe('9');
    expect(result.nanos).toBe(990_000_000);
  });

  it('percentage +10 on $50 → $55', () => {
    const result = calculateNewPrice(baseMoney(50), { type: 'percentage', value: 10 });
    expect(result.units).toBe('55');
  });

  it('percentage -50 on $50 → $25', () => {
    const result = calculateNewPrice(baseMoney(50), { type: 'percentage', value: -50 });
    expect(result.units).toBe('25');
  });

  it('round 0.99 on 12.34 → 12.99', () => {
    const result = calculateNewPrice(baseMoney(12.34), { type: 'round', roundTo: 0.99 });
    expect(result.units).toBe('12');
    expect(result.nanos).toBe(990_000_000);
  });

  it('percentage -200 on $50 → clamped to $0', () => {
    const result = calculateNewPrice(baseMoney(50), { type: 'percentage', value: -200 });
    expect(result.units).toBe('0');
    expect(result.nanos).toBeUndefined();
  });

  it('invalid units string throws', () => {
    expect(() =>
      calculateNewPrice(
        { currencyCode: 'USD', units: 'not-a-number' },
        { type: 'fixed', value: 9.99 }
      )
    ).toThrow();
  });

  it('preserves currency code through transformation', () => {
    const result = calculateNewPrice(
      { currencyCode: 'GBP', units: '20' },
      { type: 'percentage', value: 10 }
    );
    expect(result.currencyCode).toBe('GBP');
  });
});
