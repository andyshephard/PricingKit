import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/google-play/client', () => ({ googlePlayFetch: vi.fn() }));

import { googlePlayFetch } from '@/lib/google-play/client';
import { listSubscriptionOffers, parsePlayOffer, playOfferResource } from '../offers';
import type { ServiceAccountCredentials } from '../types';
import { RequestBudget } from '@/lib/utils/request-budget';
import { FakePlayOffers, PKG, PRODUCT, retentionOfferResource, trialOfferResource, twoPhaseOfferResource } from '@/lib/adapters/__tests__/fake-play-offers';

const fetchMock = vi.mocked(googlePlayFetch);
const credentials = {} as ServiceAccountCredentials;
const id = { packageName: PKG, productId: PRODUCT, basePlanId: 'annual' };

describe('parsePlayOffer', () => {
  it('reads a developer-determined relative-discount offer with tags', () => {
    const offer = parsePlayOffer(retentionOfferResource(), { productId: PRODUCT, basePlanId: 'annual' });
    expect(offer.problems).toBeUndefined();
    expect(offer.territoryProblems).toBeUndefined();
    expect(offer).toMatchObject({ kind: 'play.offer', key: 'annual-half-off', storeId: `${PRODUCT}/annual/annual-half-off`, mode: null, duration: null, prices: {} });
    expect(offer.play!.offer).toEqual({
      kind: 'play.offer',
      key: 'annual-half-off',
      state: 'ACTIVE',
      phases: [{ duration: 'P1Y', recurrenceCount: 1, regions: { GB: { type: 'relativeDiscount', fraction: '0.5' }, JP: { type: 'relativeDiscount', fraction: '0.5' }, US: { type: 'relativeDiscount', fraction: '0.5' } } }],
      targeting: { type: 'developerDetermined' },
      tags: ['rc-customer-center', 'rc-ignore-offer'],
      regions: { GB: { newSubscriberAvailability: true }, JP: { newSubscriberAvailability: true }, US: { newSubscriberAvailability: true } },
    });
    expect(offer.eligibility).toEqual({ type: 'play.targeting', rule: { type: 'developerDetermined' } });
  });

  it('reads a free trial for customers who never had any subscription', () => {
    const offer = parsePlayOffer(trialOfferResource(), { productId: PRODUCT });
    expect(offer.problems).toBeUndefined();
    expect(offer.play!.offer.targeting).toEqual({ type: 'acquisition', scope: 'anySubscriptionInApp' });
    expect(offer.play!.offer.phases[0]).toEqual({ duration: 'P1W', recurrenceCount: 1, regions: { GB: { type: 'free' }, JP: { type: 'free' }, US: { type: 'free' } } });
  });

  it('reads two phases, every price type, other-regions pricing and an upgrade rule', () => {
    const offer = parsePlayOffer(twoPhaseOfferResource());
    expect(offer.problems).toBeUndefined();
    const o = offer.play!.offer;
    expect(o.phases).toEqual([
      { duration: 'P7D', recurrenceCount: 1, regions: { US: { type: 'free' }, GB: { type: 'free' } }, otherRegions: { type: 'free' } },
      {
        duration: 'P1M',
        recurrenceCount: 3,
        regions: { US: { type: 'price', currency: 'USD', amount: '2.99' }, GB: { type: 'absoluteDiscount', currency: 'GBP', amount: '1' } },
        otherRegions: { type: 'price', usd: '2.99', eur: '2.99' },
      },
    ]);
    expect(o.targeting).toEqual({ type: 'upgrade', scope: { specificSubscriptionInApp: 'com.example.basic' }, billingPeriodDuration: 'P1M', oncePerUser: true });
    // A region without newSubscriberAvailability is false (Play's documented default; proto3 JSON omits false)
    expect(o.regions).toEqual({ US: { newSubscriberAvailability: true }, GB: { newSubscriberAvailability: false } });
    expect(o.otherRegionsNewSubscriberAvailability).toBe(true);
  });

  it('reads the other targeting shapes: this subscription, and an empty targeting as developer-determined', () => {
    const thisSub = parsePlayOffer({ ...trialOfferResource(), targeting: { acquisitionRule: { scope: { thisSubscription: {} } } } });
    expect(thisSub.play!.offer.targeting).toEqual({ type: 'acquisition', scope: 'thisSubscription' });
    const upgrade = parsePlayOffer({ ...trialOfferResource(), targeting: { upgradeRule: { scope: { thisSubscription: {} } } } });
    expect(upgrade.play!.offer.targeting).toEqual({ type: 'upgrade', scope: 'thisSubscription' });
    expect(parsePlayOffer({ ...trialOfferResource(), targeting: {} }).play!.offer.targeting).toEqual({ type: 'developerDetermined' });
    // Another state
    expect(parsePlayOffer(retentionOfferResource('INACTIVE')).play!.offer.state).toBe('INACTIVE');
  });

  it('reports what it cannot read instead of guessing', () => {
    const base = retentionOfferResource();
    type Phases = Array<{ regionalConfigs: Array<Record<string, unknown>> }>;
    const twice = structuredClone(base);
    (twice.phases as Phases)[0].regionalConfigs[0] = { regionCode: 'GB', relativeDiscount: 0.5, price: { currencyCode: 'GBP', units: '1' } };
    expect(parsePlayOffer(twice).territoryProblems?.GB).toMatch(/priced 2 ways/);

    const missing = structuredClone(base);
    (missing.phases as Phases)[0].regionalConfigs.pop();
    expect(parsePlayOffer(missing).territoryProblems?.US).toMatch(/no price for this region/);

    const badFraction = structuredClone(base);
    (badFraction.phases as Phases)[0].regionalConfigs[1] = { regionCode: 'JP', relativeDiscount: 1.2 };
    expect(parsePlayOffer(badFraction).territoryProblems?.JP).toMatch(/not between 0 and 1/);

    const mixedSigns = structuredClone(base);
    (mixedSigns.phases as Phases)[0].regionalConfigs[0] = { regionCode: 'GB', price: { currencyCode: 'GBP', units: '-1', nanos: 500000000 } };
    expect(parsePlayOffer(mixedSigns).territoryProblems?.GB).toMatch(/unreadable amount/);

    expect(parsePlayOffer({ ...base, somethingNew: true }).problems?.join()).toMatch(/unknown field somethingNew/);
    expect(parsePlayOffer({ ...base, state: 'STATE_UNSPECIFIED' }).problems?.join()).toMatch(/unknown state/);
    expect(parsePlayOffer({ ...base, phases: [] }).problems?.join()).toMatch(/1 or 2 phases/);
    expect(parsePlayOffer({ ...base, phases: [{ ...(base.phases as object[])[0], duration: 'P1Y6M' }] }).problems?.join()).toMatch(/single-unit ISO 8601/);
    expect(parsePlayOffer({ ...base, targeting: { acquisitionRule: { scope: { specificSubscriptionInApp: 'x' } } } }).problems?.join()).toMatch(/not allowed for acquisition/);
    expect(parsePlayOffer({ ...base, targeting: { acquisitionRule: { scope: {} }, upgradeRule: { scope: {} } } }).problems?.join()).toMatch(/both an acquisition and an upgrade rule/);
    expect(parsePlayOffer({ ...base, offerTags: [{ tag: 'a' }, { tag: 'a' }] }).problems?.join()).toMatch(/listed twice/);
    expect(parsePlayOffer({ ...base, regionalConfigs: [...(base.regionalConfigs as object[]), { regionCode: 'US' }] }).territoryProblems?.US).toMatch(/listed twice/);
    expect(parsePlayOffer(base, { productId: 'com.example.other' }).problems?.join()).toMatch(/belongs to subscription/);
    const two = twoPhaseOfferResource();
    (two.phases as Array<Record<string, unknown>>)[0].otherRegionsConfig = { free: { unexpected: true } };
    expect(parsePlayOffer(two).problems?.join()).toMatch(/otherRegionsConfig\.free is not an empty object/);
  });

  it('builds the resource Play takes from the model, and reads it back unchanged', () => {
    for (const raw of [retentionOfferResource(), trialOfferResource(), twoPhaseOfferResource()]) {
      const offer = parsePlayOffer(raw).play!.offer;
      const body = playOfferResource({ ...id, basePlanId: raw.basePlanId as string }, offer);
      // state is output only: never sent
      expect(body).not.toHaveProperty('state');
      expect(parsePlayOffer({ ...body, state: offer.state }).play!.offer).toEqual(offer);
    }
    const dev = playOfferResource(id, parsePlayOffer(retentionOfferResource()).play!.offer);
    expect(dev).not.toHaveProperty('targeting');
    expect(dev.offerTags).toEqual([{ tag: 'rc-customer-center' }, { tag: 'rc-ignore-offer' }]);
    expect((dev.phases as Array<{ regionalConfigs: unknown[] }>)[0].regionalConfigs[0]).toEqual({ regionCode: 'GB', relativeDiscount: 0.5 });
    const trial = playOfferResource(id, parsePlayOffer(trialOfferResource()).play!.offer);
    expect(trial.targeting).toEqual({ acquisitionRule: { scope: { anySubscriptionInApp: {} } } });
  });
});

describe('listSubscriptionOffers', () => {
  let store: FakePlayOffers;
  beforeEach(() => {
    store = new FakePlayOffers();
    fetchMock.mockReset();
    fetchMock.mockImplementation(store.handle as never);
  });

  it('follows page tokens, charges every page to the budget, and reads every base plan with "-"', async () => {
    store.pageSize = 2;
    store.seed('annual', retentionOfferResource());
    store.seed('annual', trialOfferResource());
    store.seed('monthly', { ...trialOfferResource(), offerId: 'monthly-trial', basePlanId: 'monthly' });
    const budget = new RequestBudget({ limit: 10 });
    const all = await listSubscriptionOffers(credentials, PKG, PRODUCT, '-', { budget });
    expect(all.map((o) => o.offerId)).toEqual(['annual-half-off', 'new-customer-trial', 'monthly-trial']);
    expect(store.calls.map((c) => c.path.endsWith(`/subscriptions/${PRODUCT}/basePlans/-/offers`))).toEqual([true, true]);
    expect(store.calls[1].query).toMatchObject({ pageToken: 'page-2' });
    expect(budget.used).toBe(2);
    const annual = await listSubscriptionOffers(credentials, PKG, PRODUCT, 'annual');
    expect(annual).toHaveLength(2);
  });

  it('stops when the budget is spent, before sending', async () => {
    store.pageSize = 1;
    store.seed('annual', retentionOfferResource());
    store.seed('annual', trialOfferResource());
    const budget = new RequestBudget({ limit: 1 });
    await expect(listSubscriptionOffers(credentials, PKG, PRODUCT, '-', { budget })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(store.calls).toHaveLength(1);
  });
});
