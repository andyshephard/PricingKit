import { describe, it, expect } from 'vitest';
import {
  checkOfferDrift,
  defaultOfferBasis,
  deriveOfferPrices,
  offerMultiplier,
  OfferRuleError,
  type OfferDerivationInput,
  type PercentOfCurrentRule,
  type PriceLadder,
  type ProductPriceState,
  type StoreOffer,
  type TerritoryPriceState,
} from '@/lib/pricing';

const product = { platform: 'apple', type: 'subscription', id: '9000000001' } as const;

function territory(code: string, currency: string, amount: string | null, extra: Partial<TerritoryPriceState> = {}): TerritoryPriceState {
  return {
    territory: code,
    currency,
    current: amount === null ? null : { currency, amount, pricePointId: `cur-${code}` },
    ...extra,
  };
}

function base(...territories: TerritoryPriceState[]): ProductPriceState {
  return { product, capturedAt: '2030-01-01T00:00:00.000Z', territories: Object.fromEntries(territories.map((t) => [t.territory, t])) };
}

function ladder(code: string, currency: string | undefined, prices: string[]): PriceLadder {
  return {
    ...(currency ? { currency } : {}),
    points: prices.map((p) => ({ id: `pp-${code}-${p}`, customerPrice: p, proceeds: (Number(p) * 0.85).toFixed(2) })),
  };
}

const half: PercentOfCurrentRule = { type: 'percentOfCurrent', percent: '50', basis: 'perPeriod', snap: 'nearest' };

function input(overrides: Partial<OfferDerivationInput> = {}): OfferDerivationInput {
  return {
    rule: half,
    offer: { mode: 'PAY_UP_FRONT', duration: 'P1Y' },
    billingPeriod: 'P1Y',
    base: base(territory('US', 'USD', '59.99'), territory('JP', 'JPY', '4490')),
    ladders: {
      US: ladder('US', 'USD', ['29.49', '29.95', '29.99', '30', '30.99']),
      JP: ladder('JP', 'JPY', ['2200', '2230', '2240', '2250', '2300']),
    },
    ...overrides,
  };
}

describe('deriveOfferPrices maths', () => {
  it('annual subscription, 1-year offer: 50% of each territory own price (multiplier 1)', () => {
    const result = deriveOfferPrices(input());
    expect(result.multiplier).toEqual({ percent: '50', numerator: 1, denominator: 1 });
    const us = result.rows.find((r) => r.territory === 'US')!;
    expect(us).toMatchObject({
      currency: 'USD',
      currentPrice: '59.99',
      exactTarget: '29.995',
      snappedPrice: '29.99',
      pricePointId: 'pp-US-29.99',
      deviation: '-0.005',
      proceeds: '25.49',
      ok: true,
    });
    const jp = result.rows.find((r) => r.territory === 'JP')!;
    expect(jp).toMatchObject({ currency: 'JPY', exactTarget: '2245', snappedPrice: '2240' }); // tie goes lower
  });

  it('annual subscription with basis totalOverDuration gives the same result (1 year / 1 year)', () => {
    const result = deriveOfferPrices(input({ rule: { ...half, basis: 'totalOverDuration' } }));
    expect(result.rows.find((r) => r.territory === 'US')!.exactTarget).toBe('29.995');
  });

  it('monthly subscription, 1-year pay-up-front offer, totalOverDuration: 12 x P x percent', () => {
    const result = deriveOfferPrices(
      input({
        rule: { ...half, basis: 'totalOverDuration' },
        billingPeriod: 'P1M',
        base: base(territory('US', 'USD', '4.99')),
        ladders: { US: ladder('US', 'USD', ['28.99', '29.99', '30.99', '59.99']) },
      })
    );
    expect(result.multiplier).toEqual({ percent: '50', numerator: 12, denominator: 1 });
    const us = result.rows[0];
    expect(us.exactTarget).toBe('29.94'); // 12 x 4.99 x 0.5
    expect(us.fullPriceEquivalent).toBe('59.88');
    expect(us.snappedPrice).toBe('29.99');
    expect(us.ok).toBe(true);
  });

  it('monthly subscription, same offer with basis perPeriod: P x percent only', () => {
    const result = deriveOfferPrices(
      input({ billingPeriod: 'P1M', base: base(territory('US', 'USD', '4.99')), ladders: { US: ladder('US', 'USD', ['2.49', '2.99']) } })
    );
    expect(result.rows[0].exactTarget).toBe('2.495');
    expect(result.rows[0].snappedPrice).toBe('2.49'); // tie goes lower
  });

  it('keeps fractions exact to 6 places when the ratio does not terminate', () => {
    const result = deriveOfferPrices(
      input({
        rule: { ...half, basis: 'totalOverDuration' },
        offer: { mode: 'PAY_AS_YOU_GO', duration: 'P1M' },
        billingPeriod: 'P1Y',
        base: base(territory('US', 'USD', '59.99')),
        ladders: { US: ladder('US', 'USD', ['1.99', '2.49', '2.99']) },
      })
    );
    expect(result.multiplier).toMatchObject({ numerator: 1, denominator: 12 });
    expect(result.rows[0].exactTarget).toBe('2.499583'); // 59.99 x 0.5 / 12, half-up at 6 places
    expect(result.rows[0].snappedPrice).toBe('2.49');
  });

  it('refuses weeks against months, free trials and bad percents', () => {
    expect(() => offerMultiplier({ ...half, basis: 'totalOverDuration' }, 'P1W', 'P1M')).toThrow(OfferRuleError);
    expect(offerMultiplier(half, 'P1W', 'P1M')).toEqual({ numerator: 1, denominator: 1 });
    expect(() => deriveOfferPrices(input({ offer: { mode: 'FREE_TRIAL', duration: 'P1W' } }))).toThrow(/free trial/);
    expect(() => deriveOfferPrices(input({ rule: { ...half, percent: '100' } }))).toThrow(OfferRuleError);
    expect(() => deriveOfferPrices(input({ rule: { ...half, percent: '0.5e2' } }))).toThrow(OfferRuleError);
  });
});

describe('deriveOfferPrices snapping', () => {
  const tie = () => input({ base: base(territory('US', 'USD', '17.99')), ladders: { US: ladder('US', 'USD', ['8.95', '8.99', '9']) } });

  it('nearest: an exact tie goes to the lower price', () => {
    // target 8.995 is 0.005 from both 8.99 and 9
    expect(deriveOfferPrices(tie()).rows[0].snappedPrice).toBe('8.99');
  });

  it('floor and ceil', () => {
    expect(deriveOfferPrices({ ...tie(), rule: { ...half, snap: 'floor' } }).rows[0].snappedPrice).toBe('8.99');
    expect(deriveOfferPrices({ ...tie(), rule: { ...half, snap: 'ceil' } }).rows[0].snappedPrice).toBe('9');
  });

  it('nearest picks a higher point when it is strictly closer; floor does not', () => {
    const near = input({ base: base(territory('ZA', 'ZAR', '529.99')), ladders: { ZA: ladder('ZA', 'ZAR', ['259.99', '265', '269.99']) } });
    expect(deriveOfferPrices(near).rows[0].snappedPrice).toBe('265');
    expect(deriveOfferPrices({ ...near, rule: { ...half, snap: 'floor' } }).rows[0].snappedPrice).toBe('259.99');
  });

  it('ignores unreadable ladder entries', () => {
    const result = deriveOfferPrices(
      input({ base: base(territory('US', 'USD', '17.99')), ladders: { US: { currency: 'USD', points: [{ id: 'bad', customerPrice: 'n/a' }, { id: 'ok', customerPrice: '8.99' }] } } })
    );
    expect(result.rows[0].pricePointId).toBe('ok');
  });
});

describe('deriveOfferPrices exactness and spans', () => {
  it('snaps against the exact fraction, not a target rounded onto a midpoint', () => {
    // 1 x 0.04% / 12 = 0.0000333... rounds to 0.000033, the midpoint of the two points;
    // the exact target is above it, so nearest is the upper point
    const result = deriveOfferPrices(
      input({
        rule: { ...half, percent: '0.04', basis: 'totalOverDuration' },
        offer: { mode: 'PAY_AS_YOU_GO', duration: 'P1M' },
        billingPeriod: 'P1Y',
        base: base(territory('US', 'USD', '1')),
        ladders: { US: ladder('US', 'USD', ['0.000032', '0.000034']) },
        deviationThreshold: '1',
      })
    );
    expect(result.rows[0]).toMatchObject({ exactTarget: '0.000033', snappedPrice: '0.000034', deviation: '0.000001' });
  });

  it('refuses a percent with more than 4 decimal places', () => {
    expect(() => deriveOfferPrices(input({ rule: { ...half, percent: '33.33333' } }))).toThrow(/at most 4 decimals/);
    expect(deriveOfferPrices(input({ rule: { ...half, percent: '33.3333' } })).rows).toHaveLength(2);
  });

  it('weekly subscription, 1-month pay-up-front offer: skips the below-current check with a warning instead of assuming 1:1', () => {
    const result = deriveOfferPrices(
      input({
        offer: { mode: 'PAY_UP_FRONT', duration: 'P1M' },
        billingPeriod: 'P1W',
        base: base(territory('US', 'USD', '2.99')),
        // 50% of a weekly price for a whole month; a 1:1 comparison would wrongly pass or fail it
        ladders: { US: ladder('US', 'USD', ['1.49', '1.99']) },
      })
    );
    const row = result.rows[0];
    expect(row).toMatchObject({ snappedPrice: '1.49', fullPriceEquivalent: null, ok: true });
    expect(row.flags).toEqual([expect.objectContaining({ code: 'SPAN_NOT_COMPARABLE', severity: 'warning' })]);
    expect(row.flags.map((f) => f.code)).not.toContain('NOT_BELOW_CURRENT');
  });

  it('defaults the basis to totalOverDuration for pay up front only', () => {
    expect(defaultOfferBasis('PAY_UP_FRONT')).toBe('totalOverDuration');
    expect(defaultOfferBasis('PAY_AS_YOU_GO')).toBe('perPeriod');
    expect(defaultOfferBasis(null)).toBe('perPeriod');
  });
});

describe('deriveOfferPrices validity flags', () => {
  it('flags a territory without a base price, an unreadable one and one missing from the base', () => {
    const result = deriveOfferPrices(
      input({
        base: base(territory('US', 'USD', null), territory('GB', 'GBP', null, { problems: { current: '2 prices share the latest start date' } })),
        territories: ['US', 'GB', 'FR'],
      })
    );
    const codes = Object.fromEntries(result.rows.map((r) => [r.territory, r.flags.map((f) => f.code)]));
    expect(codes).toEqual({ FR: ['NO_CURRENT_PRICE'], GB: ['CURRENT_PRICE_UNREADABLE'], US: ['NO_CURRENT_PRICE'] });
    expect(result.summary).toMatchObject({ territories: 3, ok: 0, errors: 3 });
  });

  it('flags a missing ladder, a currency mismatch and no point on the snap side', () => {
    const result = deriveOfferPrices(
      input({
        rule: { ...half, snap: 'floor' },
        base: base(territory('US', 'USD', '59.99'), territory('DE', 'EUR', '29.99'), territory('GB', 'GBP', '27.99')),
        ladders: { DE: ladder('DE', 'USD', ['14.99']), GB: ladder('GB', 'GBP', ['14.49', '15.99']) },
      })
    );
    const codes = Object.fromEntries(result.rows.map((r) => [r.territory, r.flags.map((f) => f.code)]));
    expect(codes).toEqual({ DE: ['CURRENCY_MISMATCH'], GB: ['NO_PRICE_POINT'], US: ['NO_PRICE_LADDER'] });
    // The exact target is still shown for review
    expect(result.rows.find((r) => r.territory === 'GB')!.exactTarget).toBe('13.995');
  });

  it('flags an offer that is not below the current price', () => {
    const result = deriveOfferPrices(
      input({ rule: { ...half, percent: '99', snap: 'ceil' }, base: base(territory('US', 'USD', '9.99')), ladders: { US: ladder('US', 'USD', ['9.49', '9.99']) } })
    );
    expect(result.rows[0].snappedPrice).toBe('9.99');
    expect(result.rows[0].flags.map((f) => f.code)).toEqual(['NOT_BELOW_CURRENT']);
    expect(result.rows[0].ok).toBe(false);
  });

  it('warns, without blocking, when snapping moves the price more than the threshold (default 5%)', () => {
    const coarse = input({ base: base(territory('US', 'USD', '20')), ladders: { US: ladder('US', 'USD', ['8.99', '11.99']) } });
    const result = deriveOfferPrices(coarse);
    expect(result.deviationThreshold).toBe('0.05');
    expect(result.rows[0]).toMatchObject({ snappedPrice: '8.99', deviationRatio: '0.101', ok: true });
    expect(result.rows[0].flags).toEqual([expect.objectContaining({ code: 'DEVIATION_ABOVE_THRESHOLD', severity: 'warning' })]);
    expect(result.summary.warnings).toBe(1);
    expect(deriveOfferPrices({ ...coarse, deviationThreshold: '0.2' }).rows[0].flags).toEqual([]);
  });

  it('produces plain JSON', () => {
    const result = deriveOfferPrices(input());
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe('checkOfferDrift', () => {
  const offer = (prices: StoreOffer['prices'], extra: Partial<StoreOffer> = {}): StoreOffer => ({
    kind: 'apple.promo',
    storeId: 'promo-1',
    key: 'example_half',
    mode: 'PAY_UP_FRONT',
    duration: 'P1Y',
    periods: 1,
    prices,
    ...extra,
  });
  const state = base(territory('US', 'USD', '59.99'), territory('GB', 'GBP', '27.99'), territory('DE', 'EUR', '29.99'), territory('FR', 'EUR', '41.99'));
  const ladders = {
    US: ladder('US', 'USD', ['29.95', '29.99', '30']),
    GB: ladder('GB', 'GBP', ['13.95', '13.99', '14']),
    DE: ladder('DE', 'EUR', ['14.99', '15.49']),
    FR: ladder('FR', 'EUR', ['20.99', '21.49']),
  };

  it('reports matching, mismatched, missing and extra territories', () => {
    const report = checkOfferDrift({
      rule: half,
      billingPeriod: 'P1Y',
      base: state,
      ladders,
      now: '2030-01-01T00:00:00.000Z',
      offer: offer({
        US: { currency: 'USD', amount: '29.99', pricePointId: 'pp-US-29.99' },
        GB: { currency: 'GBP', amount: '12.99', pricePointId: 'old-GB' },
        // FR missing
        DE: { currency: 'EUR', amount: '14.99', pricePointId: 'pp-DE-14.99' },
        CA: { currency: 'CAD', amount: '22.99', pricePointId: 'pp-CA' },
      }),
    });
    const status = Object.fromEntries(report.territories.map((t) => [t.territory, t.status]));
    expect(status).toEqual({ CA: 'extra', DE: 'match', FR: 'missing', GB: 'mismatch', US: 'match' });
    expect(report.summary).toEqual({ match: 2, mismatch: 1, missing: 1, extra: 1, unresolved: 0, unreadable: 0 });
    expect(report.inSync).toBe(false);
    const gb = report.territories.find((t) => t.territory === 'GB')!;
    expect(gb.expected).toMatchObject({ amount: '13.99', pricePointId: 'pp-GB-13.99', exactTarget: '13.995', currentPrice: '27.99' });
    expect(gb.actual).toMatchObject({ amount: '12.99' });
    expect(report.territories.find((t) => t.territory === 'FR')!.expected).toMatchObject({ amount: '20.99' });
    expect(report).toMatchObject({ kind: 'pricingkit.offerDrift', schemaVersion: 1, checkedAt: '2030-01-01T00:00:00.000Z' });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('compares amounts when either side has no price point ID', () => {
    const report = checkOfferDrift({
      rule: half,
      billingPeriod: 'P1Y',
      base: base(territory('US', 'USD', '59.99')),
      ladders: { US: ladder('US', 'USD', ['29.99']) },
      offer: offer({ US: { currency: 'USD', amount: '29.990' } }),
    });
    expect(report.territories[0].status).toBe('match');
    expect(report.inSync).toBe(true);
  });

  it('reports territories it cannot derive or read instead of guessing', () => {
    const report = checkOfferDrift({
      rule: half,
      billingPeriod: 'P1Y',
      base: base(territory('US', 'USD', '59.99'), territory('GB', 'GBP', null), territory('DE', 'EUR', '29.99')),
      ladders: { US: ladder('US', 'USD', ['29.99']), DE: ladder('DE', 'EUR', ['14.99']) },
      offer: offer(
        { US: { currency: 'USD', amount: '29.99', pricePointId: 'pp-US-29.99' }, GB: { currency: 'GBP', amount: '13.99' } },
        { territoryProblems: { DE: 'price p9 in DE has no price point' }, problems: ['price p7 has no territory'] }
      ),
    });
    const status = Object.fromEntries(report.territories.map((t) => [t.territory, t.status]));
    expect(status).toEqual({ DE: 'unreadable', GB: 'unresolved', US: 'match' });
    expect(report.territories.find((t) => t.territory === 'GB')!.reason).toMatch(/no current price/);
    expect(report.problems).toEqual(['price p7 has no territory']);
    expect(report.inSync).toBe(false);
  });

  it('limits the check to the listed territories; the rest of the offer is out of scope and can still be in sync', () => {
    const report = checkOfferDrift({
      rule: half,
      billingPeriod: 'P1Y',
      base: state,
      ladders,
      territories: ['US'],
      offer: offer({ US: { currency: 'USD', amount: '29.99', pricePointId: 'pp-US-29.99' }, GB: { currency: 'GBP', amount: '13.99', pricePointId: 'pp-GB-13.99' } }),
    });
    expect(report.territories.map((t) => [t.territory, t.status])).toEqual([['US', 'match']]);
    expect(report.outOfScope).toEqual(['GB']);
    expect(report.summary.extra).toBe(0);
    expect(report.inSync).toBe(true);
  });

  it('without a territory list, offer territories the base has no price for are extra', () => {
    const report = checkOfferDrift({
      rule: half,
      billingPeriod: 'P1Y',
      base: base(territory('US', 'USD', '59.99')),
      ladders: { US: ladder('US', 'USD', ['29.99']) },
      offer: offer({ US: { currency: 'USD', amount: '29.99', pricePointId: 'pp-US-29.99' }, GB: { currency: 'GBP', amount: '13.99' } }),
    });
    expect(report.territories.map((t) => [t.territory, t.status])).toEqual([
      ['GB', 'extra'],
      ['US', 'match'],
    ]);
    expect(report.outOfScope).toBeUndefined();
    expect(report.inSync).toBe(false);
  });

  it('is never in sync when nothing was compared', () => {
    const report = checkOfferDrift({ rule: half, billingPeriod: 'P1Y', base: base(), ladders: {}, offer: offer({}) });
    expect(report.territories).toEqual([]);
    expect(report.inSync).toBe(false);
  });

  it('reports an unreadable price outside the rule territories as unreadable, not extra', () => {
    const report = checkOfferDrift({
      rule: half,
      billingPeriod: 'P1Y',
      base: base(territory('US', 'USD', '59.99')),
      ladders: { US: ladder('US', 'USD', ['29.99']) },
      offer: offer({ US: { currency: 'USD', amount: '29.99', pricePointId: 'pp-US-29.99' } }, { territoryProblems: { CA: 'price p3 in CA has no currency' } }),
    });
    expect(report.territories.find((t) => t.territory === 'CA')).toEqual({
      territory: 'CA',
      status: 'unreadable',
      reason: 'price p3 in CA has no currency (a territory the rule does not cover)',
    });
    expect(report.summary.extra).toBe(0);
  });

  it('lists an unreadable price outside a territory list as out of scope', () => {
    const report = checkOfferDrift({
      rule: half,
      billingPeriod: 'P1Y',
      base: state,
      ladders,
      territories: ['US'],
      offer: offer({ US: { currency: 'USD', amount: '29.99', pricePointId: 'pp-US-29.99' } }, { territoryProblems: { CA: 'price p3 in CA has no currency' } }),
    });
    expect(report.territories.map((t) => t.territory)).toEqual(['US']);
    expect(report.outOfScope).toEqual(['CA']);
    expect(report.inSync).toBe(true);
  });

  it('refuses an offer whose mode or duration was unreadable', () => {
    expect(() => checkOfferDrift({ rule: half, billingPeriod: 'P1Y', base: state, ladders, offer: offer({}, { duration: null }) })).toThrow(OfferRuleError);
  });
});
