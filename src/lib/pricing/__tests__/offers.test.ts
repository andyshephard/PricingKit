import { describe, it, expect } from 'vitest';
import {
  appleDurationToIso,
  appleSubscriptionPeriodToIso,
  durationRatio,
  InvalidOfferSpecError,
  parseOfferSpec,
  parsePercentOfCurrentRule,
  type OfferSpec,
} from '@/lib/pricing';

const promo: OfferSpec = {
  id: 'example_half',
  productRef: { platform: 'apple', type: 'subscription', id: '9000000001', productId: 'com.example.app.pro.annual' },
  kind: 'apple.promo',
  mode: 'PAY_UP_FRONT',
  duration: 'P1Y',
  periods: 1,
  pricing: { type: 'percentOfCurrent', percent: '50', basis: 'perPeriod', snap: 'nearest' },
  eligibility: { type: 'apple.developerDetermined' },
  territories: 'all',
  syncWithBase: true,
};

function problems(input: unknown): string[] {
  try {
    parseOfferSpec(input);
    return [];
  } catch (error) {
    if (error instanceof InvalidOfferSpecError) return error.problems;
    throw error;
  }
}

describe('Apple duration mapping', () => {
  it('maps every Apple offer duration to an ISO duration', () => {
    expect(appleDurationToIso('THREE_DAYS')).toBe('P3D');
    expect(appleDurationToIso('TWO_WEEKS')).toBe('P2W');
    expect(appleDurationToIso('SIX_MONTHS')).toBe('P6M');
    expect(appleDurationToIso('ONE_YEAR')).toBe('P1Y');
    expect(appleDurationToIso('FOREVER')).toBeUndefined();
  });

  it('maps subscription periods, refusing durations that are not billing periods', () => {
    expect(appleSubscriptionPeriodToIso('ONE_MONTH')).toBe('P1M');
    expect(appleSubscriptionPeriodToIso('ONE_YEAR')).toBe('P1Y');
    expect(appleSubscriptionPeriodToIso('THREE_DAYS')).toBeUndefined();
  });
});

describe('durationRatio', () => {
  it('is exact within months and within days', () => {
    expect(durationRatio('P1Y', 'P1M')).toEqual({ numerator: 12, denominator: 1 });
    expect(durationRatio('P1Y', 'P1Y')).toEqual({ numerator: 1, denominator: 1 });
    expect(durationRatio('P3M', 'P6M')).toEqual({ numerator: 1, denominator: 2 });
    expect(durationRatio('P2W', 'P1W')).toEqual({ numerator: 2, denominator: 1 });
    expect(durationRatio('P3D', 'P1W')).toEqual({ numerator: 3, denominator: 7 });
  });

  it('has no answer between weeks and months', () => {
    expect(durationRatio('P1W', 'P1M')).toBeUndefined();
    expect(durationRatio('P1M', 'P1W')).toBeUndefined();
  });
});

describe('parseOfferSpec', () => {
  it('accepts a promotional offer and normalises the percent', () => {
    const spec = parseOfferSpec({ ...promo, pricing: { ...promo.pricing, percent: '50.0' } });
    expect(spec.pricing).toEqual({ type: 'percentOfCurrent', percent: '50', basis: 'perPeriod', snap: 'nearest' });
  });

  it('accepts each Apple kind with its own eligibility', () => {
    expect(problems({ ...promo, kind: 'apple.intro', eligibility: { type: 'apple.intro' } })).toEqual([]);
    expect(
      problems({
        ...promo,
        kind: 'apple.offerCode',
        eligibility: { type: 'apple.offerCode', customerEligibilities: ['NEW', 'EXPIRED'], offerEligibility: 'STACK_WITH_INTRO_OFFERS' },
      })
    ).toEqual([]);
    expect(
      problems({
        ...promo,
        kind: 'apple.winBack',
        eligibility: { type: 'apple.winBack', paidSubscriptionDurationInMonths: 3, timeSinceLastSubscribedInMonths: { minimum: 1, maximum: 12 } },
      })
    ).toEqual([]);
  });

  it('keeps room for Play offers', () => {
    expect(
      problems({
        ...promo,
        kind: 'play.offer',
        productRef: { platform: 'google', type: 'subscription', productId: 'com.example.pro', basePlanId: 'annual' },
        pricing: { type: 'play.relativeDiscount', fraction: '0.5' },
        eligibility: { type: 'play.targeting', rule: {} },
        tags: ['example-tag'],
      })
    ).toEqual([]);
  });

  it('refuses a free trial with a price and a price with a free trial', () => {
    expect(problems({ ...promo, mode: 'FREE_TRIAL' })).toContain('a FREE_TRIAL offer must use pricing { type: "free" }');
    expect(problems({ ...promo, pricing: { type: 'free' } })).toContain('pricing "free" needs mode FREE_TRIAL (mode is PAY_UP_FRONT)');
  });

  it('refuses mismatched kinds, eligibility and Play-only fields on Apple offers', () => {
    expect(problems({ ...promo, eligibility: { type: 'apple.intro' } })).toContain('eligibility apple.intro does not fit a apple.promo offer');
    expect(problems({ ...promo, tags: ['x'] })).toContain('tags are Play-only (offerTags)');
    expect(problems({ ...promo, pricing: { type: 'play.relativeDiscount', fraction: '0.5' } })).toContain('play.relativeDiscount pricing is Play-only');
    expect(problems({ ...promo, productRef: { platform: 'google', type: 'subscription', productId: 'p', basePlanId: 'b' } })).toContain(
      'apple.promo needs an Apple subscription productRef'
    );
    expect(problems({ ...promo, periods: 3 })).toContain('periods must be 1 for PAY_UP_FRONT (only pay-as-you-go offers repeat)');
  });

  it('refuses percents outside (0, 100), float amounts and unknown durations', () => {
    expect(problems({ ...promo, pricing: { ...promo.pricing, percent: '100' } })[0]).toMatch(/percent/);
    expect(problems({ ...promo, pricing: { ...promo.pricing, percent: '0' } })[0]).toMatch(/percent/);
    expect(problems({ ...promo, pricing: { ...promo.pricing, percent: 50 } })[0]).toMatch(/percent/);
    expect(problems({ ...promo, duration: 'ONE_YEAR' })[0]).toMatch(/duration/);
  });
});

describe('parsePercentOfCurrentRule', () => {
  it('validates a rule on its own', () => {
    expect(parsePercentOfCurrentRule({ type: 'percentOfCurrent', percent: '33.5', basis: 'totalOverDuration', snap: 'floor' }).percent).toBe('33.5');
    expect(() => parsePercentOfCurrentRule({ type: 'percentOfCurrent', percent: '-5', basis: 'perPeriod', snap: 'floor' })).toThrow(InvalidOfferSpecError);
    expect(() => parsePercentOfCurrentRule({ type: 'percentOfCurrent', percent: '12.34567', basis: 'perPeriod', snap: 'floor' })).toThrow(/at most 4 decimal places/);
    expect(parsePercentOfCurrentRule({ type: 'percentOfCurrent', percent: '12.34560', basis: 'perPeriod', snap: 'floor' }).percent).toBe('12.3456');
  });
});
