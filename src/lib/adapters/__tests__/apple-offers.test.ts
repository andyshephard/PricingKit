import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return {
    ...actual,
    appleApiRequest: (...args: unknown[]) => appleApiRequest(...args),
    getAppIdForBundleId: vi.fn(async () => {
      throw new Error('not expected');
    }),
  };
});

import { AppleAdapter } from '../apple';
import { FakeOfferServer, OFFER_SUB_ID, page, pointResource, priceEntry, promoOffer, territoryResource } from './fake-apple-offers';
import { RequestBudget } from '@/lib/utils/request-budget';
import type { ProductRef } from '@/lib/pricing';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.app',
};
const product: ProductRef = { platform: 'apple', type: 'subscription', id: OFFER_SUB_ID, productId: 'com.example.app.pro.annual' };
const SUB = `/subscriptions/${OFFER_SUB_ID}`;

const PROMO_PRICE = 'subscriptionPromotionalOfferPrices';

let server: FakeOfferServer;

function seedIntro(s: FakeOfferServer) {
  s.on(
    `${SUB}/introductoryOffers`,
    page(
      [
        {
          type: 'subscriptionIntroductoryOffers',
          id: 'intro-usa',
          attributes: { duration: 'ONE_MONTH', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, startDate: '2030-01-01', endDate: null },
          relationships: {
            territory: { data: { type: 'territories', id: 'USA' } },
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'pp-i-usa' } },
          },
        },
        {
          type: 'subscriptionIntroductoryOffers',
          id: 'intro-gbr',
          attributes: { duration: 'ONE_MONTH', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, startDate: '2030-01-01', endDate: null },
          relationships: {
            territory: { data: { type: 'territories', id: 'GBR' } },
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'pp-i-gbr' } },
          },
        },
        {
          // Same terms, but Apple left out the territory: can't be placed
          type: 'subscriptionIntroductoryOffers',
          id: 'intro-lost',
          attributes: { duration: 'ONE_MONTH', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, startDate: '2030-01-01', endDate: null },
          relationships: { subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'pp-i-usa' } } },
        },
        {
          type: 'subscriptionIntroductoryOffers',
          id: 'intro-jpn-trial',
          attributes: { duration: 'ONE_WEEK', offerMode: 'FREE_TRIAL', numberOfPeriods: 1 },
          relationships: { territory: { data: { type: 'territories', id: 'JPN' } }, subscriptionPricePoint: { data: null } },
        },
      ],
      [
        pointResource('pp-i-usa', '0.99', '0.84', 'USA'),
        pointResource('pp-i-gbr', '0.99', '0.69', 'GBR'),
        territoryResource('USA'),
        territoryResource('GBR'),
        territoryResource('JPN'),
      ]
    )
  );
}

function seedPromo(s: FakeOfferServer) {
  // Offer list: two pages
  s.on(`${SUB}/promotionalOffers`, page([promoOffer('promo-1', 'example_half', 'Half price year')], [], `${SUB}/promotionalOffers?cursor=P2&limit=200`));
  s.on(`${SUB}/promotionalOffers?cursor=P2&limit=200`, page([promoOffer('promo-2', 'example_broken', 'Broken one', 'PAY_AS_YOU_GO', 'ONE_MONTH')]));
  // promo-1 prices: two pages
  s.on(
    '/subscriptionPromotionalOffers/promo-1/prices',
    page(
      [priceEntry(PROMO_PRICE, 'p1-usa', 'USA', 'pp-usa-2999'), priceEntry(PROMO_PRICE, 'p1-gbr', 'GBR', 'pp-gbr-1399')],
      [pointResource('pp-usa-2999', '29.99', '25.49', 'USA'), pointResource('pp-gbr-1399', '13.99', '9.79', 'GBR'), territoryResource('USA'), territoryResource('GBR')],
      '/subscriptionPromotionalOffers/promo-1/prices?cursor=Q2&limit=200'
    )
  );
  s.on(
    '/subscriptionPromotionalOffers/promo-1/prices?cursor=Q2&limit=200',
    page([priceEntry(PROMO_PRICE, 'p1-deu', 'DEU', 'pp-deu-1499')], [pointResource('pp-deu-1499', '14.99', '10.79', 'DEU'), territoryResource('DEU')])
  );
  // promo-2 prices: every kind of problem
  s.on(
    '/subscriptionPromotionalOffers/promo-2/prices',
    page(
      [
        priceEntry(PROMO_PRICE, 'p2-usa', 'USA', 'pp-usa-299'),
        priceEntry(PROMO_PRICE, 'p2-fra', 'FRA', null), // price point relationship empty
        priceEntry(PROMO_PRICE, 'p2-none', undefined, 'pp-usa-299'), // no territory relationship
        priceEntry(PROMO_PRICE, 'p2-jpn', 'JPN', 'pp-jpn-missing'), // price point not included
        priceEntry(PROMO_PRICE, 'p2-can-a', 'CAN', 'pp-can-399'),
        priceEntry(PROMO_PRICE, 'p2-can-b', 'CAN', 'pp-can-399'), // two prices for one territory
        priceEntry(PROMO_PRICE, 'p2-gbr', 'GBR', 'pp-gbr-199'), // GBR currency not included
      ],
      [
        pointResource('pp-usa-299', '2.99', '2.54', 'USA'),
        pointResource('pp-can-399', '3.99', '3.39', 'CAN'),
        pointResource('pp-gbr-199', '1.99', '1.39', 'GBR'),
        territoryResource('USA'),
        territoryResource('FRA'),
        territoryResource('JPN'),
        territoryResource('CAN'),
      ]
    )
  );
}

function seedOfferCodes(s: FakeOfferServer) {
  s.on(
    `${SUB}/offerCodes`,
    page([
      {
        type: 'subscriptionOfferCodes',
        id: 'code-1',
        attributes: {
          name: 'Example spring code',
          customerEligibilities: ['NEW', 'EXPIRED'],
          offerEligibility: 'STACK_WITH_INTRO_OFFERS',
          duration: 'THREE_MONTHS',
          offerMode: 'PAY_AS_YOU_GO',
          numberOfPeriods: 3,
          totalNumberOfCodes: 500,
          active: true,
        },
      },
    ])
  );
  s.on(
    '/subscriptionOfferCodes/code-1/prices',
    page([priceEntry('subscriptionOfferCodePrices', 'c1-usa', 'USA', 'pp-usa-199')], [pointResource('pp-usa-199', '1.99', '1.69', 'USA'), territoryResource('USA')])
  );
}

function seedWinBack(s: FakeOfferServer) {
  s.on(
    `${SUB}/winBackOffers`,
    page([
      {
        type: 'winBackOffers',
        id: 'wb-1',
        attributes: {
          referenceName: 'Example come back',
          offerId: 'example_winback',
          duration: 'SIX_MONTHS',
          offerMode: 'PAY_UP_FRONT',
          periodCount: 1,
          customerEligibilityPaidSubscriptionDurationInMonths: 3,
          customerEligibilityTimeSinceLastSubscribedInMonths: { minimum: 2, maximum: 24 },
          customerEligibilityWaitBetweenOffersInMonths: 6,
          startDate: '2030-02-01',
          priority: 'HIGH',
          promotionIntent: 'NOT_PROMOTED',
        },
      },
    ])
  );
  s.on(
    '/winBackOffers/wb-1/prices',
    page([priceEntry('winBackOfferPrices', 'w1-gbr', 'GBR', 'pp-gbr-999')], [pointResource('pp-gbr-999', '9.99', '6.99', 'GBR'), territoryResource('GBR')])
  );
}

beforeEach(() => {
  server = new FakeOfferServer();
  seedIntro(server);
  seedPromo(server);
  seedOfferCodes(server);
  seedWinBack(server);
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation(server.handle);
});

describe('AppleAdapter.fetchOffers', () => {
  it('reads all four offer kinds with GETs only', async () => {
    const offers = await new AppleAdapter({ credentials }).fetchOffers(product);
    expect(offers.map((o) => `${o.kind}:${o.key}`)).toEqual([
      'apple.intro:intro:PAY_UP_FRONT:ONE_MONTH:1:2030-01-01:',
      'apple.intro:intro:FREE_TRIAL:ONE_WEEK:1::',
      'apple.promo:example_half',
      'apple.promo:example_broken',
      'apple.offerCode:Example spring code',
      'apple.winBack:example_winback',
    ]);
    expect(server.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('groups introductory offers by terms and reports one without a territory', async () => {
    const [paid, trial] = await new AppleAdapter({ credentials }).fetchOffers(product);
    expect(paid).toMatchObject({
      mode: 'PAY_UP_FRONT',
      duration: 'P1M',
      periods: 1,
      schedule: { start: '2030-01-01' },
      eligibility: { type: 'apple.intro' },
      prices: {
        US: { currency: 'USD', amount: '0.99', pricePointId: 'pp-i-usa', proceeds: '0.84' },
        GB: { currency: 'GBP', amount: '0.99', pricePointId: 'pp-i-gbr', proceeds: '0.69' },
      },
      storeRefs: { US: 'intro-usa', GB: 'intro-gbr' },
      problems: ['price intro-lost has no territory'],
    });
    expect(trial).toMatchObject({ mode: 'FREE_TRIAL', duration: 'P1W', prices: { JP: { currency: 'JPY', amount: '0', free: true } } });
    expect(trial.problems).toBeUndefined();

    const introCall = server.calls.find((c) => c.endpoint === `${SUB}/introductoryOffers`)!;
    expect(introCall.query).toMatchObject({
      include: 'territory,subscriptionPricePoint',
      'fields[subscriptionPricePoints]': 'customerPrice,proceeds',
      'fields[territories]': 'currency',
      limit: '200',
    });
  });

  it('reads promotional offers across pages, and each offer price list across pages', async () => {
    const offers = await new AppleAdapter({ credentials }).fetchOffers(product);
    const promo = offers.find((o) => o.key === 'example_half')!;
    expect(promo).toMatchObject({
      kind: 'apple.promo',
      storeId: 'promo-1',
      name: 'Half price year',
      mode: 'PAY_UP_FRONT',
      duration: 'P1Y',
      periods: 1,
      eligibility: { type: 'apple.developerDetermined' },
    });
    expect(promo.prices).toEqual({
      US: { currency: 'USD', amount: '29.99', pricePointId: 'pp-usa-2999', proceeds: '25.49' },
      GB: { currency: 'GBP', amount: '13.99', pricePointId: 'pp-gbr-1399', proceeds: '9.79' },
      DE: { currency: 'EUR', amount: '14.99', pricePointId: 'pp-deu-1499', proceeds: '10.79' },
    });
    expect(promo.problems).toBeUndefined();

    const first = server.calls.find((c) => c.endpoint === '/subscriptionPromotionalOffers/promo-1/prices')!;
    expect(first.query).toMatchObject({
      include: 'territory,subscriptionPricePoint',
      'fields[subscriptionPromotionalOfferPrices]': 'territory,subscriptionPricePoint',
      limit: '200',
    });
    // The next page follows links.next exactly, without re-sending the first page's query
    const second = server.calls.find((c) => c.endpoint.startsWith('/subscriptionPromotionalOffers/promo-1/prices?cursor='))!;
    expect(second.query).toBeUndefined();
    // Prices are never read through the list's capped include
    expect(server.calls.find((c) => c.endpoint === `${SUB}/promotionalOffers`)!.query?.include).toBeUndefined();
  });

  it('reports every price it cannot read instead of guessing a territory, price or currency', async () => {
    const offers = await new AppleAdapter({ credentials }).fetchOffers(product);
    const broken = offers.find((o) => o.key === 'example_broken')!;
    expect(broken.mode).toBe('PAY_AS_YOU_GO');
    expect(broken.prices).toEqual({ US: { currency: 'USD', amount: '2.99', pricePointId: 'pp-usa-299', proceeds: '2.54' } });
    expect(broken.territoryProblems).toEqual({
      FR: 'price p2-fra in FR has no price point',
      JP: 'price p2-jpn in JP: price point pp-jpn-missing was not returned',
      CA: '2 prices for one territory',
      GB: 'price p2-gbr in GB has no currency',
    });
    expect(broken.problems).toEqual(['price p2-none has no territory']);
  });

  it('reads offer codes and win-back offers with their eligibility and prices', async () => {
    const offers = await new AppleAdapter({ credentials }).fetchOffers(product);
    expect(offers.find((o) => o.kind === 'apple.offerCode')).toMatchObject({
      storeId: 'code-1',
      mode: 'PAY_AS_YOU_GO',
      duration: 'P3M',
      periods: 3,
      eligibility: { type: 'apple.offerCode', customerEligibilities: ['NEW', 'EXPIRED'], offerEligibility: 'STACK_WITH_INTRO_OFFERS' },
      status: { active: true, totalNumberOfCodes: 500 },
      prices: { US: { currency: 'USD', amount: '1.99', pricePointId: 'pp-usa-199' } },
    });
    expect(offers.find((o) => o.kind === 'apple.winBack')).toMatchObject({
      storeId: 'wb-1',
      key: 'example_winback',
      name: 'Example come back',
      duration: 'P6M',
      periods: 1,
      eligibility: {
        type: 'apple.winBack',
        paidSubscriptionDurationInMonths: 3,
        timeSinceLastSubscribedInMonths: { minimum: 2, maximum: 24 },
        waitBetweenOffersInMonths: 6,
      },
      schedule: { start: '2030-02-01' },
      status: { priority: 'HIGH', promotionIntent: 'NOT_PROMOTED' },
      prices: { GB: { currency: 'GBP', amount: '9.99' } },
    });
  });

  it('reports an unknown mode or duration on the offer', async () => {
    server.on(`${SUB}/promotionalOffers`, page([promoOffer('promo-1', 'example_half', 'Half', 'PAY_LATER', 'FOREVER')]));
    const offers = await new AppleAdapter({ credentials }).fetchOffers(product);
    const promo = offers.find((o) => o.key === 'example_half')!;
    expect(promo).toMatchObject({ mode: null, duration: null });
    expect(promo.problems).toEqual(['unknown offer mode "PAY_LATER"', 'unknown offer duration "FOREVER"']);
  });

  it('refuses in-app purchases', async () => {
    await expect(new AppleAdapter({ credentials }).fetchOffers({ platform: 'apple', type: 'inapp', id: '1' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });
});

describe('Offer reads and the request budget', () => {
  it('charges every request, pagination included, to the run budget', async () => {
    const budget = new RequestBudget({ limit: 100 });
    await new AppleAdapter({ credentials, budget }).fetchOffers(product);
    // intro 1 + promo list 2 + promo-1 prices 2 + promo-2 prices 1 + codes 1 + code prices 1 + win-back 1 + win-back prices 1
    expect(server.calls).toHaveLength(10);
    expect(budget.used).toBe(10);
  });

  it('stops with BUDGET_EXCEEDED instead of returning a partial list', async () => {
    const budget = new RequestBudget({ limit: 4 });
    await expect(new AppleAdapter({ credentials, budget }).fetchOffers(product)).rejects.toMatchObject({ status: 429, code: 'BUDGET_EXCEEDED' });
    expect(server.calls).toHaveLength(4);
  });

  it('fetchOffer reads only the chosen offer prices', async () => {
    const offer = await new AppleAdapter({ credentials }).fetchOffer(product, 'apple.promo', 'example_half');
    expect(offer?.storeId).toBe('promo-1');
    expect(server.calls.some((c) => c.endpoint.startsWith('/subscriptionPromotionalOffers/promo-2'))).toBe(false);
    expect(await new AppleAdapter({ credentials }).fetchOffer(product, 'apple.promo', 'nope')).toBeNull();
  });
});

describe('AppleAdapter.checkOfferDrift', () => {
  function seedBase(s: FakeOfferServer) {
    s.on(SUB, {
      data: { type: 'subscriptions', id: OFFER_SUB_ID, attributes: { productId: 'com.example.app.pro.annual', name: 'Pro annual', state: 'APPROVED', subscriptionPeriod: 'ONE_YEAR' } },
    });
    const current = [
      ['USA', 'pp-usa-5999', '59.99'],
      ['GBR', 'pp-gbr-2799', '27.99'],
      ['DEU', 'pp-deu-2999', '29.99'],
      ['FRA', 'pp-fra-4199', '41.99'],
    ];
    s.on(
      `${SUB}/prices`,
      page(
        current.map(([t, pp]) => ({
          type: 'subscriptionPrices',
          id: `price-${t}`,
          attributes: { startDate: null },
          relationships: { territory: { data: { type: 'territories', id: t } }, subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: pp } } },
        })),
        [...current.map(([t, pp, price]) => pointResource(pp, price, '0', t)), ...current.map(([t]) => territoryResource(t))]
      )
    );
    const ladders: Record<string, string[]> = {
      USA: ['29.95', '29.99', '30'],
      GBR: ['12.99', '13.95', '13.99', '14'],
      DEU: ['13.99', '14.99', '15.49'],
      FRA: ['20.99', '21.49'],
    };
    s.on(`${SUB}/pricePoints`, (_e: string, query: Record<string, string> | undefined) => {
      const wanted = (query?.['filter[territory]'] ?? '').split(',');
      const data = wanted.flatMap((t) => (ladders[t] ?? []).map((p) => pointResource(`pp-${t.toLowerCase()}-${p.replace('.', '')}`, p, '0', t)));
      return page(data, wanted.filter((t) => ladders[t]).map(territoryResource));
    });
  }

  it('compares an offer with the rule against live base prices and ladders, reading only', async () => {
    seedBase(server);
    // promo-1: US 29.99 and GB 13.99 match; DE 13.99 is off (rule gives 14.99); FR missing; CA extra
    server.on(
      '/subscriptionPromotionalOffers/promo-1/prices?cursor=Q2&limit=200',
      page(
        [priceEntry(PROMO_PRICE, 'p1-deu', 'DEU', 'pp-deu-1399'), priceEntry(PROMO_PRICE, 'p1-can', 'CAN', 'pp-can-2299')],
        [pointResource('pp-deu-1399', '13.99', '10', 'DEU'), pointResource('pp-can-2299', '22.99', '16', 'CAN'), territoryResource('DEU'), territoryResource('CAN')]
      )
    );
    const budget = new RequestBudget({ limit: 100 });
    const report = await new AppleAdapter({ credentials, budget, now: () => new Date('2030-01-01T00:00:00Z') }).checkOfferDrift(product, {
      kind: 'apple.promo',
      offer: 'example_half',
      rule: { type: 'percentOfCurrent', percent: '50', basis: 'perPeriod', snap: 'nearest' },
    });
    expect(report).not.toBeNull();
    expect(Object.fromEntries(report!.territories.map((t) => [t.territory, t.status]))).toEqual({
      CA: 'extra',
      DE: 'mismatch',
      FR: 'missing',
      GB: 'match',
      US: 'match',
    });
    expect(report!.billingPeriod).toBe('P1Y');
    expect(report!.checkedAt).toBe('2030-01-01T00:00:00.000Z');
    expect(server.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(budget.used).toBe(server.calls.length);
  });

  it('returns null for an offer the subscription does not have', async () => {
    seedBase(server);
    const report = await new AppleAdapter({ credentials }).checkOfferDrift(product, {
      kind: 'apple.winBack',
      offer: 'nope',
      rule: { type: 'percentOfCurrent', percent: '50', basis: 'perPeriod', snap: 'nearest' },
    });
    expect(report).toBeNull();
  });
});
