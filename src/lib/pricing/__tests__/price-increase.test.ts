// Existing-subscriber classification of price changes (price-increase.ts):
// App Store consent rules and thresholds, Google Play legacy cohorts and
// opt-out limits. The rules and their sources are in price-increase.ts.
import { describe, it, expect } from 'vitest';
import {
  APPLE_PRICE_INCREASE_THRESHOLDS,
  classifyPriceChange,
  periodDays,
  priceChangeNotes,
  type BasePriceOp,
  type PriceChangeInput,
  type ProductPriceState,
} from '@/lib/pricing';
import { APPLE_TERRITORIES } from '@/lib/apple-connect/territories';

const usd = (amount: string) => ({ currency: 'USD', amount });
const apple = (current: string | null, after: string, extra: Partial<PriceChangeInput> = {}): PriceChangeInput => ({
  platform: 'apple',
  productType: 'subscription',
  territory: 'US',
  current: current === null ? null : usd(current),
  after: usd(after),
  effectiveDate: '2030-06-01',
  preserveCurrentPrice: false,
  ...extra,
});

describe('App Store threshold table', () => {
  it('has the 175 storefronts of Apple\'s table, all known territories, four always needing consent', () => {
    const entries = Object.entries(APPLE_PRICE_INCREASE_THRESHOLDS);
    expect(entries).toHaveLength(175);
    const known = new Set(APPLE_TERRITORIES.map((t) => t.alpha3));
    expect(entries.filter(([alpha3]) => !known.has(alpha3))).toEqual([]);
    expect(entries.filter(([, v]) => v === 'consent').map(([k]) => k).sort()).toEqual(['AUT', 'DEU', 'KOR', 'POL']);
    expect(APPLE_PRICE_INCREASE_THRESHOLDS.USA).toEqual(['USD', '5', '50']);
    expect(APPLE_PRICE_INCREASE_THRESHOLDS.JPN).toEqual(['JPY', '800', '8000']);
    // Apple's table names a different currency than PricingKit's territory list for four storefronts
    // (Bulgaria moved to the euro; territories.ts is hand-maintained). There the price currency won't
    // match the threshold's, and the classification falls back to "needs consent".
    const differ = entries.filter(([alpha3, v]) => v !== 'consent' && v[0] !== APPLE_TERRITORIES.find((t) => t.alpha3 === alpha3)!.currency).map(([k]) => k);
    expect(differ.sort()).toEqual(['BGR', 'BIH', 'ISL', 'SRB']);
  });
});

describe('classifyPriceChange: App Store', () => {
  it('decreases reach existing subscribers; preserveCurrentPrice makes an increase new-subscribers-only', () => {
    expect(classifyPriceChange(apple('9.99', '7.99')).classification).toBe('decrease');
    const preserved = classifyPriceChange(apple('9.99', '19.99', { preserveCurrentPrice: true }));
    expect(preserved).toMatchObject({ classification: 'increase-to-new-subscribers-only', direction: 'increase', percent: '100.10' });
    expect(classifyPriceChange(apple('9.99', '19.99', { preserveCurrentPrice: undefined })).classification).toBe('increase-to-new-subscribers-only');
    expect(classifyPriceChange(apple(null, '9.99')).classification).toBe('new-price');
    expect(classifyPriceChange(apple('9.99', '9.99')).classification).toBe('unchanged');
  });

  it('needs consent only when the increase is over 50% AND over the storefront threshold', () => {
    // +50% exactly, +5: within
    expect(classifyPriceChange(apple('10.00', '15.00')).classification).toBe('increase-within-no-consent-threshold');
    // +100% but only +2 (under US$5): within
    expect(classifyPriceChange(apple('1.99', '3.99')).classification).toBe('increase-within-no-consent-threshold');
    // +10 but only +20%: within
    expect(classifyPriceChange(apple('49.99', '59.99')).classification).toBe('increase-within-no-consent-threshold');
    // +60% and +6: consent
    const c = classifyPriceChange(apple('9.99', '15.99'));
    expect(c.classification).toBe('increase-needs-consent');
    expect(c.reasons.join(' ')).toMatch(/over both limits/);
    // Unknown billing period: the lower (non-annual) threshold, and it says so
    expect(c.assumptions.join(' ')).toMatch(/billing period unknown/);
  });

  it('uses the annual threshold for P1Y and the storefront currency', () => {
    expect(classifyPriceChange(apple('29.99', '59.99', { context: { billingPeriod: 'P1Y' } })).classification).toBe('increase-within-no-consent-threshold');
    expect(classifyPriceChange(apple('29.99', '89.99', { context: { billingPeriod: 'P1Y' } })).classification).toBe('increase-needs-consent');
    const jp = { territory: 'JP', current: { currency: 'JPY', amount: '1000' }, after: { currency: 'JPY', amount: '1700' } };
    expect(classifyPriceChange(apple('0', '0', jp)).classification).toBe('increase-within-no-consent-threshold');
    expect(classifyPriceChange(apple('0', '0', { ...jp, after: { currency: 'JPY', amount: '1900' } })).classification).toBe('increase-needs-consent');
  });

  it('Austria, Germany, Poland and Korea always need consent; so does a recent increase', () => {
    for (const territory of ['AT', 'DE', 'PL', 'KR']) {
      expect(classifyPriceChange(apple('0', '0', { territory, current: { currency: 'EUR', amount: '9.99' }, after: { currency: 'EUR', amount: '10.49' } })).classification).toBe('increase-needs-consent');
    }
    expect(classifyPriceChange(apple('9.99', '10.99', { context: { lastIncreaseAt: '2029-09-01' } })).classification).toBe('increase-needs-consent');
    expect(classifyPriceChange(apple('9.99', '10.99', { context: { lastIncreaseAt: { US: '2029-05-31' } } })).classification).toBe('increase-within-no-consent-threshold');
    // Unknown history is assumed clean, and said so
    expect(classifyPriceChange(apple('9.99', '10.99')).assumptions.join(' ')).toMatch(/no price increase in the last 12 months/);
  });

  it('is conservative where it can\'t check: storefronts outside the table, a currency other than the table\'s', () => {
    expect(classifyPriceChange(apple('0', '0', { territory: 'BD', current: { currency: 'BDT', amount: '100' }, after: { currency: 'BDT', amount: '101' } })).classification).toBe('increase-needs-consent');
    expect(classifyPriceChange(apple('0', '0', { territory: 'GB', current: { currency: 'USD', amount: '1' }, after: { currency: 'USD', amount: '1.10' } })).reasons.join(' ')).toMatch(/threshold for GB is in GBP/);
  });
});

describe('classifyPriceChange: Google Play', () => {
  const play = (current: string, after: string, context?: PriceChangeInput['context']): PriceChangeInput => ({ ...apple(current, after), platform: 'google', ...(context ? { context } : {}) });

  it('every base plan change is for new purchases; ifMigrated says what moving the cohort needs', () => {
    expect(classifyPriceChange(play('9.99', '7.99'))).toMatchObject({ classification: 'decrease', ifMigrated: 'no-consent' });
    expect(classifyPriceChange(play('9.99', '13.99'))).toMatchObject({ classification: 'increase-to-new-subscribers-only', ifMigrated: 'opt-out-possible' });
    // 50% of 9.99 is 4.995: +5.00 is over it
    expect(classifyPriceChange(play('9.99', '14.99')).ifMigrated).toBe('opt-in-required');
    // Over 50%, no billing period: only the 50% limit applies
    expect(classifyPriceChange(play('9.99', '15.99'))).toMatchObject({ ifMigrated: 'opt-in-required' });
  });

  it('the opt-out limit is the greater of 50% and 17 US cents a day', () => {
    // Monthly: 0.17 x 30 = US$5.10 beats 50% of 1.99
    expect(classifyPriceChange(play('1.99', '6.99', { billingPeriod: 'P1M' })).ifMigrated).toBe('opt-out-possible');
    expect(classifyPriceChange(play('1.99', '7.19', { billingPeriod: 'P1M' })).ifMigrated).toBe('opt-in-required');
    // In GBP at a given rate: 0.17 x 30 x 0.8 = 4.08
    const gb = { territory: 'GB', current: { currency: 'GBP', amount: '1.00' }, after: { currency: 'GBP', amount: '5.08' } };
    expect(classifyPriceChange({ ...play('0', '0', { billingPeriod: 'P1M', exchangeRates: { GBP: '0.8' } }), ...gb }).ifMigrated).toBe('opt-out-possible');
    expect(classifyPriceChange({ ...play('0', '0', { billingPeriod: 'P1M', exchangeRates: { GBP: '0.8' } }), ...gb, after: { currency: 'GBP', amount: '5.09' } }).ifMigrated).toBe('opt-in-required');
    // An increase within 365 days rules opt-out out
    expect(classifyPriceChange(play('9.99', '10.99', { lastIncreaseAt: '2030-01-01' })).ifMigrated).toBe('opt-in-required');
  });

  it('one-time products have no subscribers', () => {
    expect(classifyPriceChange({ ...play('1.99', '2.99'), productType: 'inapp' }).classification).toBe('one-time-product');
  });

  it('periodDays counts 7 a week, 30 a month, 365 a year', () => {
    expect([periodDays('P1W'), periodDays('P1M'), periodDays('P3M'), periodDays('P1Y'), periodDays('P'), periodDays('1M'), periodDays(undefined)]).toEqual([7, 30, 90, 365, undefined, undefined, undefined]);
  });
});

describe('priceChangeNotes', () => {
  const product = { platform: 'apple', type: 'subscription', id: '1' } as const;
  const state: ProductPriceState = {
    product,
    capturedAt: '2030-01-01T00:00:00Z',
    territories: { US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '9.99', pricePointId: 'a', proceeds: '6.99' } } },
  };
  const op = (after: string, extra: Partial<BasePriceOp> = {}): BasePriceOp => ({
    id: 'op-0001',
    kind: 'setPrice',
    platform: 'apple',
    target: { product, territory: 'US' },
    before: state.territories.US.current,
    after: { currency: 'USD', amount: after, pricePointId: 'b', proceeds: '11.19' },
    options: { preserveCurrentPrice: false },
    idempotencyKey: 'k',
    ...extra,
  });

  it('classifies each op against the current price and carries proceeds', () => {
    const [note] = priceChangeNotes([op('15.99')], [{ state, consent: { billingPeriod: 'P1M' } }], '2030-01-01T00:00:00Z');
    expect(note).toMatchObject({ opId: 'op-0001', territory: 'US', classification: 'increase-needs-consent', percent: '60.06', proceeds: { before: '6.99', after: '11.19' } });
    // A scheduled op is judged on its own date against what subscribers pay now
    const [scheduled] = priceChangeNotes([op('15.99', { kind: 'schedulePrice', before: null, after: { currency: 'USD', amount: '15.99', pricePointId: 'b', startDate: '2030-03-01' } })], [{ state, consent: { lastIncreaseAt: '2029-04-01' } }], '2030-01-01T00:00:00Z');
    expect(scheduled.classification).toBe('increase-needs-consent');
  });

  it('Play: estimated proceeds and tax from the resolve result, with the commission used', () => {
    const playProduct = { platform: 'google', type: 'subscription', productId: 'p', basePlanId: 'b' } as const;
    const playState: ProductPriceState = { product: playProduct, capturedAt: '', territories: { GB: { territory: 'GB', currency: 'GBP', current: { currency: 'GBP', amount: '4.99' } } } };
    const playOp: BasePriceOp = { id: 'op-0001', kind: 'setPrice', platform: 'google', target: { product: playProduct, territory: 'GB' }, before: playState.territories.GB.current, after: { currency: 'GBP', amount: '5.99' }, idempotencyKey: 'k' };
    const [note] = priceChangeNotes(
      [playOp],
      [{ state: playState, measure: 'proceeds', resolved: { GB: { currency: 'GBP', amount: '5.99', tax: '1', proceeds: '4.24', proceedsEstimated: true, measure: 'proceeds', target: '4.25', deviation: '-0.01', deviationRatio: '0.0024' } } }],
      '2030-01-01T00:00:00Z'
    );
    expect(note).toMatchObject({ classification: 'increase-to-new-subscribers-only', ifMigrated: 'opt-out-possible', tax: '1', proceeds: { after: '4.24', estimated: true, commission: '0.15' }, target: { measure: 'proceeds', amount: '4.25' } });
  });
});
