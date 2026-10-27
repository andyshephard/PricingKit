// Phase 8 core: reference data freshness, stale PPP policies, the custom
// multiplier strategy (inline and CSV), proceeds and consent spec options.
import { describe, it, expect } from 'vitest';
import {
  ageInDays,
  calculateRegionalPrice,
  checkFreshness,
  DEFAULT_MAX_AGE_DAYS,
  MultiplierCsvError,
  parseMultiplierCsv,
  parseMultiplierText,
  relativeMultipliers,
  cpiRatioSince,
  latestCpiYear,
  parsePricingSpec,
  PricingSpecError,
  pppStalenessAdjustment,
  REFERENCE_DATA,
  specTargets,
  type PricingSpecProduct,
  type ProductPriceState,
} from '@/lib/pricing';
import { PRICE_TIER_DATA_GENERATED_AT } from '@/lib/apple-connect/price-tier-data';

const appleSub = { platform: 'apple', type: 'subscription', id: '1234567890' } as const;
const playPlan = { platform: 'google', type: 'subscription', productId: 'pro', basePlanId: 'annual' } as const;
const spec = (products: unknown[], extra: object = {}, app: unknown = { bundleId: 'com.example.app' }) => ({ kind: 'pricingkit.spec', schemaVersion: 1, app, products, ...extra });
function problems(input: unknown): string[] {
  try {
    parsePricingSpec(input);
  } catch (error) {
    if (error instanceof PricingSpecError) return error.issues;
    throw error;
  }
  return [];
}
const state = (product: ProductPriceState['product']): ProductPriceState => ({
  product,
  capturedAt: '2030-01-01T00:00:00Z',
  territories: {
    US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '9.99' } },
    GB: { territory: 'GB', currency: 'GBP', current: { currency: 'GBP', amount: '8.99' } },
    IN: { territory: 'IN', currency: 'INR', current: { currency: 'INR', amount: '799' } },
    TR: { territory: 'TR', currency: 'TRY', current: { currency: 'TRY', amount: '199.99' } },
  },
});

describe('reference data freshness', () => {
  it('records the date of each built-in data set', () => {
    expect(REFERENCE_DATA.ppp).toMatchObject({ dataYear: 2024, caveat: expect.stringMatching(/assumed/) });
    expect(REFERENCE_DATA.fallbackExchangeRates.asOf).toBe('2026-02-01');
    expect(REFERENCE_DATA.netflix.asOf).toBe('2026-04-09');
    expect(REFERENCE_DATA.bigmac.asOf).toBe('2025-01-01');
    expect(REFERENCE_DATA.appleTiers.asOf).toBe(PRICE_TIER_DATA_GENERATED_AT);
  });

  it('judges age against a maximum, and an unknown date as stale', () => {
    const now = new Date('2026-03-18T12:00:00Z');
    expect(ageInDays('2026-02-01', now)).toBe(45);
    expect(ageInDays('2026-02-01T00:00:00Z', now)).toBe(45);
    expect(ageInDays('soon', now)).toBeUndefined();
    expect(checkFreshness(REFERENCE_DATA.fallbackExchangeRates, now)).toMatchObject({ ageDays: 45, maxAgeDays: DEFAULT_MAX_AGE_DAYS.fallbackExchangeRates, stale: false });
    const later = checkFreshness(REFERENCE_DATA.fallbackExchangeRates, new Date('2026-03-19T00:00:00Z'));
    expect(later).toMatchObject({ stale: true, message: expect.stringMatching(/as of 2026-02-01, 46 days old \(older than 45 days; refresh it\)/) });
    expect(checkFreshness({ id: 'exchangeRates', label: 'Spec rates' }, now)).toMatchObject({ stale: true, message: 'Spec rates: date unknown, so its age can\'t be checked' });
    expect(checkFreshness(REFERENCE_DATA.bigmac, now, 10_000).stale).toBe(false);
  });
});

describe('stale PPP factors', () => {
  it('cap (default): data older than maxAgeYears is not used', () => {
    expect(pppStalenessAdjustment(2024, 2027)).toEqual({ ok: true, factorRatio: 1, stale: false, ageYears: 3 });
    expect(pppStalenessAdjustment(2024, 2028)).toMatchObject({ ok: false, stale: true, ageYears: 4, reason: expect.stringMatching(/more than 3/) });
    expect(pppStalenessAdjustment(2024, 2028, { maxAgeYears: 5 }).ok).toBe(true);
  });

  it('inflate: multiplies by the territory CPI ratio over the base territory one', () => {
    const r = pppStalenessAdjustment(2024, 2030, { mode: 'inflate' }, { cpiRatio: 2.4, baseCpiRatio: 1.2 });
    expect(r).toMatchObject({ ok: true, stale: true, factorRatio: 2 });
    expect(pppStalenessAdjustment(2024, 2030, { mode: 'inflate' }, { baseCpiRatio: 1.2 })).toMatchObject({ ok: false, reason: expect.stringMatching(/no CPI ratio/) });
  });

  it('a spec plan in 2030 skips PPP territories (cap), or inflates them with the spec CPI table', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const ppp = (extra: object = {}): PricingSpecProduct => ({ product: appleSub, targets: { type: 'strategy', strategy: 'ppp', base: { territory: 'US', amount: '9.99' }, ...extra } as PricingSpecProduct['targets'] });
    const capped = specTargets(ppp(), state(appleSub), { now });
    expect(capped.targets).toEqual({});
    expect(new Set(capped.skipped.map((s) => s.reason))).toEqual(new Set(['STALE_REFERENCE_DATA']));
    // Today (2026) the same spec prices every territory
    expect(Object.keys(specTargets(ppp(), state(appleSub), { now: new Date('2026-10-27T00:00:00Z') }).targets).sort()).toEqual(['GB', 'IN', 'TR', 'US']);

    const fresh = specTargets(ppp({ pppStaleness: { maxAgeYears: 10 } }), state(appleSub), { now });
    const inflated = specTargets(ppp({ pppStaleness: { mode: 'inflate', cpi: { US: '1.1', IN: '1.32' } } }), state(appleSub), { now });
    // IN: multiplier x 1.32 / 1.1 = x1.2; US unchanged; GB and TR have no CPI ratio, so they're skipped
    expect(Number(inflated.targets.IN.amount) / Number(fresh.targets.IN.amount)).toBeCloseTo(1.2, 2);
    expect(inflated.targets.US).toEqual(fresh.targets.US);
    expect(inflated.skipped.map((s) => `${s.territory}:${s.reason}`).sort()).toEqual(['GB:STALE_REFERENCE_DATA', 'TR:STALE_REFERENCE_DATA']);
    expect(inflated.warnings).toEqual(expect.arrayContaining([{ territory: 'IN', message: expect.stringMatching(/inflated by relative CPI x1\.2000/) }]));
  });
});

describe('custom strategy', () => {
  const custom = (extra: object): PricingSpecProduct => ({ product: appleSub, targets: { type: 'strategy', strategy: 'custom', base: { territory: 'US', amount: '10' }, ...extra } as PricingSpecProduct['targets'] });

  it('prices the territories in its table, relative to the base territory multiplier', () => {
    const result = specTargets(custom({ multipliers: { GB: '0.9', IN: '0.4' } }), state(appleSub));
    expect(Object.keys(result.targets).sort()).toEqual(['GB', 'IN']);
    const expected = (territory: string, currency: string, m: number) => calculateRegionalPrice(10, territory, 'custom', 'none', m, undefined, { [territory]: currency }, undefined, 'USD', 'US').rawPrice;
    expect(Number(result.targets.IN.amount)).toBeCloseTo(expected('IN', 'INR', 0.4), 1);
    // A base multiplier of 2 halves every ratio
    const halved = specTargets(custom({ multipliers: { US: '2', GB: '0.9', IN: '0.4' } }), state(appleSub));
    expect(Number(halved.targets.IN.amount)).toBeCloseTo(expected('IN', 'INR', 0.2), 1);
    expect(halved.targets.US).toEqual({ currency: 'USD', amount: '10' });
  });

  it('"all" or a list skips territories without a multiplier', () => {
    const result = specTargets(custom({ multipliers: { GB: '0.9' }, territories: 'all' }), state(appleSub));
    expect(Object.keys(result.targets).sort()).toEqual(['GB', 'US']);
    expect(result.skipped.map((s) => `${s.territory}:${s.reason}`).sort()).toEqual(['IN:NO_TARGET', 'TR:NO_TARGET']);
  });

  it('is validated: a table, in range, covering the listed territories, custom only', () => {
    const p = (targets: object) => problems(spec([{ product: appleSub, targets: { type: 'strategy', base: { territory: 'US', amount: '10' }, ...targets } }]));
    expect(p({ strategy: 'custom', multipliers: { GB: '0.9' } })).toEqual([]);
    expect(p({ strategy: 'custom', multipliers: {} })).toEqual([expect.stringMatching(/needs "multipliers"/)]);
    expect(p({ strategy: 'custom', multipliers: { GB: '0' } })).toEqual([expect.stringMatching(/multipliers\.GB: must be from 0\.01 to 10/)]);
    expect(p({ strategy: 'custom', multipliers: { GB: '11' } })).toHaveLength(1);
    expect(p({ strategy: 'custom', multipliers: { GB: 'x' } })).toHaveLength(1);
    expect(p({ strategy: 'custom', multipliers: { GBR: '1' } })).toEqual([expect.stringMatching(/multipliers\.GBR/)]);
    expect(p({ strategy: 'custom', multipliers: { GB: '0.9' }, territories: ['GB', 'IN', 'US'] })).toEqual([expect.stringMatching(/no multiplier for IN/)]);
    expect(p({ strategy: 'ppp', multipliers: { GB: '0.9' } })).toEqual([expect.stringMatching(/custom strategy only/)]);
  });
});

describe('multiplier CSV', () => {
  it('reads territory and multiplier columns, e.g. a price export with a multiplier column added', () => {
    const csv = [
      'schema_version,exported_at,platform,app_id,product_type,product_id,base_plan_id,territory,currency,amount,proceeds,availability,multiplier',
      '1,2030-01-01T00:00:00Z,apple,com.example.app,subscription,1,,GB,GBP,8.99,6.29,,0.9',
      '1,2030-01-01T00:00:00Z,apple,com.example.app,subscription,1,,IN,INR,799,559,,"0.40"',
      '1,2030-01-01T00:00:00Z,apple,com.example.app,subscription,1,,US,USD,9.99,6.99,,',
    ].join('\r\n');
    expect(parseMultiplierCsv(csv)).toEqual({ GB: '0.9', IN: '0.4' });
    expect(parseMultiplierCsv('﻿Territory,Multiplier\nGB,1.1\n')).toEqual({ GB: '1.1' });
  });

  it('reports problems by line and column name, never by cell contents', () => {
    const fail = (text: string) => {
      try {
        parseMultiplierCsv(text);
      } catch (error) {
        expect(error).toBeInstanceOf(MultiplierCsvError);
        return (error as MultiplierCsvError).issues;
      }
      throw new Error('expected an error');
    };
    expect(fail('country,multiplier\nGB,1')).toEqual(['the header has no "territory" column']);
    expect(fail('territory,multiplier\nsecret-value,1\nGB,=cmd()\nGB,1\nGB,2')).toEqual([
      'line 2: territory must be ISO 3166-1 alpha-2, e.g. "GB"',
      'line 3: multiplier for GB must be a plain decimal such as 0.8',
      'line 5: GB is listed twice',
    ]);
    expect(fail('territory,multiplier\nGB,')).toEqual(['no row has a multiplier']);
    expect(fail('territory,multiplier\n"GB,1')).toEqual(['a quoted field is not closed']);
    expect(fail('')).toEqual(['the file is empty']);
  });
});

describe('multiplier tables typed in the web app', () => {
  it('reads GB=0.9 lines or CSV, checks the range, and makes them relative to the base', () => {
    expect(parseMultiplierText('gb=0.9\n# comment\n\nIN, 0.40\nBR 0.55')).toEqual({ GB: '0.9', IN: '0.4', BR: '0.55' });
    expect(parseMultiplierText('territory,multiplier\nGB,0.9')).toEqual({ GB: '0.9' });
    expect(() => parseMultiplierText('GB=0.9\nGB=1')).toThrow(/listed twice/);
    expect(() => parseMultiplierText('GB=twelve')).toThrow(/line 1: expected a territory and a multiplier/);
    expect(() => parseMultiplierText('GB=0.001\nIN=20')).toThrow(MultiplierCsvError);
    expect(relativeMultipliers({ US: '2', IN: '0.5' }, 'US')).toEqual({ US: 1, IN: 0.25 });
    expect(relativeMultipliers({ IN: '0.5' }, 'US')).toEqual({ US: 1, IN: 0.5 });
  });

  it('cpiRatioSince: latest over the start year', () => {
    expect(cpiRatioSince({ 2020: 100, 2021: 110, 2023: 150 }, 2020)).toBe(1.5);
    expect(cpiRatioSince({ 2021: 110 }, 2020)).toBeUndefined();
    expect(cpiRatioSince(undefined, 2020)).toBeUndefined();
    // A common end year: the territory to 2021 when its base only has data to 2021
    expect(cpiRatioSince({ 2020: 100, 2021: 110, 2023: 150 }, 2020, 2021)).toBe(1.1);
    expect(cpiRatioSince({ 2020: 100, 2023: 150 }, 2020, 2021)).toBeUndefined();
    expect(latestCpiYear({ 2019: 90, 2020: 100, 2022: 120 }, 2020)).toBe(2022);
    expect(latestCpiYear({ 2019: 90 }, 2020)).toBeUndefined();
  });
});

describe('proceeds and consent spec options', () => {
  it('accepts measure, commission (Play) and consent; refuses what does not fit', () => {
    const fixed = { type: 'fixed', prices: { GB: '5' } };
    const ok = parsePricingSpec(
      spec([{ product: playPlan, targets: fixed, measure: 'proceeds', commission: '0.30', consent: { maxIncreaseWithoutConsent: true, billingPeriod: 'P1M', lastIncreaseAt: { GB: '2029-01-01' } } }], {}, { packageName: 'com.example.app' })
    );
    expect(ok.products[0]).toMatchObject({ measure: 'proceeds', commission: '0.3', consent: { billingPeriod: 'P1M' } });
    expect(problems(spec([{ product: appleSub, targets: fixed, commission: '0.15' }]))).toEqual([expect.stringMatching(/commission is Google Play only/)]);
    expect(problems(spec([{ product: appleSub, targets: { type: 'percentOfCurrent', percent: '110' }, measure: 'proceeds' }]))).toEqual([expect.stringMatching(/fixed and strategy targets/)]);
    expect(problems(spec([{ product: playPlan, targets: fixed, commission: '1' }], {}, { packageName: 'com.example.app' }))).toEqual([expect.stringMatching(/fraction/)]);
    expect(problems(spec([{ product: appleSub, targets: fixed, consent: { billingPeriod: 'monthly' } }]))).toEqual([expect.stringMatching(/ISO 8601 period/)]);
    expect(problems(spec([{ product: appleSub, targets: fixed, consent: { lastIncreaseAt: 'yesterday' } }]))).toHaveLength(1);
    // Dates must exist: no month 13, no 30 February (in every date field)
    for (const date of ['2026-13-01', '2026-02-30', '2026-04-31']) {
      expect(problems(spec([{ product: appleSub, targets: fixed, consent: { lastIncreaseAt: date } }]))).toEqual([expect.stringMatching(/must be a real date/)]);
      expect(problems(spec([{ product: appleSub, targets: fixed, consent: { lastIncreaseAt: { GB: date } } }]))).toHaveLength(1);
      expect(problems(spec([{ product: appleSub, targets: fixed, startDate: date }]))).toEqual([expect.stringMatching(/startDate must be a real date/)]);
    }
    expect(problems(spec([{ product: appleSub, targets: fixed, consent: { lastIncreaseAt: '2028-02-29' } }]))).toEqual([]);
  });

  it('accepts freshness limits and the PPP staleness policy', () => {
    const ppp = { type: 'strategy', strategy: 'ppp', base: { territory: 'US', amount: '9.99' } };
    expect(problems(spec([{ product: appleSub, targets: ppp }], { freshness: { maxAgeDays: { ppp: 400, fallbackExchangeRates: 30 }, refuseStale: true } }))).toEqual([]);
    expect(problems(spec([{ product: appleSub, targets: ppp }], { freshness: { maxAgeDays: { nope: 1 } } }))).toHaveLength(1);
    expect(problems(spec([{ product: appleSub, targets: { ...ppp, pppStaleness: { mode: 'inflate', cpi: { IN: '1.2' } } } }]))).toEqual([expect.stringMatching(/needs cpi for the base territory US/)]);
    expect(problems(spec([{ product: appleSub, targets: { ...ppp, strategy: 'direct', pppStaleness: { maxAgeYears: 2 } } }]))).toEqual([expect.stringMatching(/ppp strategy only/)]);
    expect(problems(spec([{ product: appleSub, targets: { ...ppp, exchangeRatesAsOf: '2030-01-01' } }]))).toEqual([expect.stringMatching(/goes with exchangeRates/)]);
  });
});
