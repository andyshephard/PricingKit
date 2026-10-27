import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clearTokenCache } from '../client';
import {
  createIntroductoryOffer,
  createOfferCode,
  createPromotionalOffer,
  createWinBackOffer,
  deleteIntroductoryOffer,
  deletePromotionalOffer,
  deleteWinBackOffer,
  introductoryOfferCreateBody,
  introductoryOfferEndDateBody,
  isoToAppleOfferDuration,
  offerCodeActiveBody,
  offerCodeCreateBody,
  promotionalOfferCreateBody,
  promotionalOfferPricesUpdateBody,
  replacePromotionalOfferPrices,
  setIntroductoryOfferEndDate,
  setOfferCodeActive,
  updateWinBackOffer,
  winBackOfferCreateBody,
  winBackOfferUpdateBody,
} from '../offer-writes';
import type { AppleConnectCredentials } from '../types';
import { RequestBudget } from '@/lib/utils/request-budget';

// ---------------------------------------------------------------------------
// Request bodies against App Store Connect's OpenAPI spec (4.5.1)

type Schema = {
  type?: string;
  enum?: string[];
  required?: string[];
  nullable?: boolean;
  format?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
};
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/offer-write-requests.schema.json'), 'utf8')) as {
  methods: Record<string, string[]>;
  schemas: Record<string, Schema>;
};

/**
 * Check a value against a schema excerpt: types, enums, required fields,
 * dates, and no property the spec doesn't define (except the listed paths).
 */
function validate(value: unknown, schema: Schema, path = '$', allowExtra: string[] = []): string[] {
  if (value === null) return schema.nullable ? [] : [`${path}: null is not allowed`];
  const problems: string[] = [];
  if (schema.enum && !schema.enum.includes(value as string)) problems.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected an object`];
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!(key in obj)) problems.push(`${path}.${key}: required`);
      for (const [key, v] of Object.entries(obj)) {
        const sub = schema.properties?.[key];
        if (!sub) {
          if (!allowExtra.some((p) => `${path}.${key}`.startsWith(p))) problems.push(`${path}.${key}: not in the spec`);
          continue;
        }
        problems.push(...validate(v, sub, `${path}.${key}`, allowExtra));
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) return [`${path}: expected an array`];
      value.forEach((item, i) => problems.push(...validate(item, schema.items ?? {}, `${path}[${i}]`, allowExtra)));
      break;
    case 'string':
      if (typeof value !== 'string') problems.push(`${path}: expected a string`);
      else if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) problems.push(`${path}: expected a date`);
      break;
    case 'integer':
      if (!Number.isInteger(value)) problems.push(`${path}: expected an integer`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${path}: expected a boolean`);
      break;
  }
  return problems;
}

const prices = [
  { territory: 'US', pricePointId: 'pp-usa' },
  { territory: 'GBR', pricePointId: 'pp-gbr' },
];

describe('offer write bodies match the OpenAPI spec', () => {
  it('promotional offer create: attributes, subscription and inline prices', () => {
    const body = promotionalOfferCreateBody({
      subscriptionId: '9000000002',
      name: 'Half off',
      offerCode: 'example_half',
      duration: 'ONE_YEAR',
      offerMode: 'PAY_UP_FRONT',
      numberOfPeriods: 1,
      prices,
    });
    expect(validate(body, fixture.schemas.SubscriptionPromotionalOfferCreateRequest)).toEqual([]);
    // Each relationship entry has a matching included inline price, territories as alpha-3
    expect(body.data.relationships.prices.data.map((p) => p.id)).toEqual(['${price-USA}', '${price-GBR}']);
    expect(body.included).toEqual([
      {
        type: 'subscriptionPromotionalOfferPrices',
        id: '${price-USA}',
        relationships: { territory: { data: { type: 'territories', id: 'USA' } }, subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'pp-usa' } } },
      },
      {
        type: 'subscriptionPromotionalOfferPrices',
        id: '${price-GBR}',
        relationships: { territory: { data: { type: 'territories', id: 'GBR' } }, subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'pp-gbr' } } },
      },
    ]);
  });

  it('promotional offer price replace: existing prices by ID plus new inline prices, no attributes', () => {
    const body = promotionalOfferPricesUpdateBody('promo-1', ['price-de'], prices);
    expect(validate(body, fixture.schemas.SubscriptionPromotionalOfferUpdateRequest)).toEqual([]);
    expect(body.data.relationships.prices.data).toEqual([
      { type: 'subscriptionPromotionalOfferPrices', id: 'price-de' },
      { type: 'subscriptionPromotionalOfferPrices', id: '${price-USA}' },
      { type: 'subscriptionPromotionalOfferPrices', id: '${price-GBR}' },
    ]);
    // The update request has no attributes: duration, mode and periods can't be edited
    expect(fixture.schemas.SubscriptionPromotionalOfferUpdateRequest.properties!.data.properties!.attributes).toBeUndefined();
  });

  it('introductory offer create: one territory, price point, optional dates', () => {
    const body = introductoryOfferCreateBody({
      subscriptionId: '9000000002',
      territory: 'GB',
      pricePointId: 'pp-gbr',
      duration: 'ONE_MONTH',
      offerMode: 'PAY_AS_YOU_GO',
      numberOfPeriods: 3,
      startDate: '2030-01-01',
      endDate: '2030-06-01',
    });
    expect(validate(body, fixture.schemas.SubscriptionIntroductoryOfferCreateRequest)).toEqual([]);
    expect(body.data.relationships.territory.data.id).toBe('GBR');
    const free = introductoryOfferCreateBody({ subscriptionId: '1', territory: 'US', duration: 'ONE_WEEK', offerMode: 'FREE_TRIAL', numberOfPeriods: 1 });
    expect(validate(free, fixture.schemas.SubscriptionIntroductoryOfferCreateRequest)).toEqual([]);
    expect(free.data.relationships).not.toHaveProperty('subscriptionPricePoint');
    expect(free.data.attributes).not.toHaveProperty('startDate');
  });

  it('introductory offer update: end date only, null clears it', () => {
    expect(validate(introductoryOfferEndDateBody('intro-1', '2030-06-01'), fixture.schemas.SubscriptionIntroductoryOfferUpdateRequest)).toEqual([]);
    expect(validate(introductoryOfferEndDateBody('intro-1', null), fixture.schemas.SubscriptionIntroductoryOfferUpdateRequest)).toEqual([]);
  });

  it('offer code create and active switch', () => {
    const body = offerCodeCreateBody({
      subscriptionId: '9000000002',
      name: 'EXAMPLE-SPRING',
      customerEligibilities: ['NEW', 'EXPIRED'],
      offerEligibility: 'STACK_WITH_INTRO_OFFERS',
      duration: 'THREE_MONTHS',
      offerMode: 'PAY_UP_FRONT',
      numberOfPeriods: 1,
      autoRenewEnabled: true,
      prices,
    });
    expect(validate(body, fixture.schemas.SubscriptionOfferCodeCreateRequest)).toEqual([]);
    expect(validate(offerCodeActiveBody('code-1', false), fixture.schemas.SubscriptionOfferCodeUpdateRequest)).toEqual([]);
  });

  it('win-back offer create and update (the spec lists no relationships on inline win-back prices)', () => {
    const body = winBackOfferCreateBody({
      subscriptionId: '9000000002',
      referenceName: 'Come back',
      offerId: 'example_winback',
      duration: 'THREE_MONTHS',
      offerMode: 'PAY_AS_YOU_GO',
      periodCount: 3,
      paidSubscriptionDurationInMonths: 6,
      timeSinceLastSubscribedInMonths: { minimum: 1, maximum: 12 },
      waitBetweenOffersInMonths: 6,
      startDate: '2030-01-01',
      priority: 'NORMAL',
      promotionIntent: 'NOT_PROMOTED',
      prices,
    });
    // UNCONFIRMED: WinBackOfferPriceInlineCreate in spec 4.5.1 has only type and id.
    // A price needs a territory and price point, so they are sent like the
    // other inline prices; this is the one deliberate deviation from the spec.
    expect(validate(body, fixture.schemas.WinBackOfferCreateRequest)).toEqual(['$.included[0].relationships: not in the spec', '$.included[1].relationships: not in the spec']);
    expect(validate(body, fixture.schemas.WinBackOfferCreateRequest, '$', ['$.included'])).toEqual([]);
    const update = winBackOfferUpdateBody('wb-1', { endDate: '2030-06-01', priority: 'HIGH' });
    expect(validate(update, fixture.schemas.WinBackOfferUpdateRequest)).toEqual([]);
    expect(fixture.schemas.WinBackOfferUpdateRequest.properties!.data.properties!.relationships).toBeUndefined();
  });

  it('refuses two prices for one territory and unknown territories', () => {
    expect(() => promotionalOfferCreateBody({ subscriptionId: '1', name: 'x', offerCode: 'x', duration: 'ONE_YEAR', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, prices: [prices[0], { territory: 'USA', pricePointId: 'x' }] })).toThrow(/Two prices for territory USA/);
    expect(() => promotionalOfferCreateBody({ subscriptionId: '1', name: 'x', offerCode: 'x', duration: 'ONE_YEAR', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, prices: [{ territory: 'XX' }] })).toThrow(/Unknown Apple territory/);
  });

  it('maps ISO durations to Apple enums', () => {
    expect(isoToAppleOfferDuration('P1Y')).toBe('ONE_YEAR');
    expect(isoToAppleOfferDuration('P3D')).toBe('THREE_DAYS');
    expect(() => isoToAppleOfferDuration('P5D')).toThrow();
  });

  it('only calls methods the spec defines (offer codes have no DELETE)', () => {
    expect(fixture.methods['/v1/subscriptionOfferCodes/{id}']).not.toContain('DELETE');
    expect(fixture.methods['/v1/subscriptionPromotionalOffers/{id}']).toEqual(expect.arrayContaining(['PATCH', 'DELETE']));
    expect(fixture.methods['/v1/subscriptionIntroductoryOffers/{id}']).toEqual(expect.arrayContaining(['PATCH', 'DELETE']));
    expect(fixture.methods['/v1/winBackOffers/{id}']).toEqual(expect.arrayContaining(['PATCH', 'DELETE']));
  });
});

// ---------------------------------------------------------------------------
// Through the real client: creates retry only on 429, every request is budgeted

let credentials: AppleConnectCredentials;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  credentials = {
    privateKey: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`,
    keyId: 'TESTKEY123',
    issuerId: '00000000-0000-0000-0000-000000000000',
    bundleId: 'com.example.test',
  };
});

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const appleError = (status: number) => ({ errors: [{ status: String(status), code: 'ERR', title: 'Error', detail: `status ${status}` }] });

let calls: Array<{ url: string; method: string; body?: unknown }>;
function serve(responses: Response[]) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const next = responses.shift();
      if (!next) throw new Error(`Unexpected fetch ${String(input)}`);
      return next;
    })
  );
}

async function settle<T>(promise: Promise<T>): Promise<void> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  for (let i = 0; i < 2000 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(250);
  }
}

beforeEach(() => {
  clearTokenCache();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const creates: Array<[string, (budget?: RequestBudget) => Promise<{ id: string }>]> = [
  ['promotional offer', (budget) => createPromotionalOffer(credentials, { subscriptionId: '1', name: 'n', offerCode: 'c', duration: 'ONE_YEAR', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, prices }, { budget })],
  ['introductory offer', (budget) => createIntroductoryOffer(credentials, { subscriptionId: '1', territory: 'US', pricePointId: 'pp', duration: 'ONE_MONTH', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1 }, { budget })],
  [
    'offer code',
    (budget) =>
      createOfferCode(
        credentials,
        { subscriptionId: '1', name: 'n', customerEligibilities: ['NEW'], offerEligibility: 'STACK_WITH_INTRO_OFFERS', duration: 'ONE_MONTH', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, prices },
        { budget }
      ),
  ],
  [
    'win-back offer',
    (budget) =>
      createWinBackOffer(
        credentials,
        {
          subscriptionId: '1',
          referenceName: 'n',
          offerId: 'o',
          duration: 'ONE_MONTH',
          offerMode: 'PAY_UP_FRONT',
          periodCount: 1,
          paidSubscriptionDurationInMonths: 1,
          timeSinceLastSubscribedInMonths: { minimum: 1, maximum: 6 },
          startDate: '2030-01-01',
          priority: 'NORMAL',
          prices,
        },
        { budget }
      ),
  ],
];

describe('offer creates retry only on 429', () => {
  it.each(creates)('a %s create that answers 5xx is not sent again', async (_name, create) => {
    serve([json(503, appleError(503)), json(201, { data: { id: 'dup' } })]);
    const promise = create();
    const assertion = expect(promise).rejects.toMatchObject({ status: 503, retryable: false });
    await settle(promise);
    await assertion;
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
  });

  it.each(creates)('a %s create that answers 429 is retried', async (_name, create) => {
    serve([json(429, appleError(429)), json(201, { data: { id: 'created' } })]);
    const promise = create();
    await settle(promise);
    await expect(promise).resolves.toEqual({ id: 'created' });
    expect(calls).toHaveLength(2);
  });

  it('a price replace (PATCH) is retried on 5xx: sending the same full list again is harmless', async () => {
    serve([json(503, appleError(503)), json(200, { data: { id: 'promo-1' } })]);
    const promise = replacePromotionalOfferPrices(credentials, 'promo-1', ['keep-1'], prices);
    await settle(promise);
    await expect(promise).resolves.toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'PATCH']);
    expect(calls[0].body).toEqual(calls[1].body);
  });
});

describe('offer writes are charged to the request budget', () => {
  it('every write consumes one request, and a spent budget sends nothing', async () => {
    const budget = new RequestBudget({ limit: 7 });
    serve([
      json(201, { data: { id: 'p' } }),
      json(200, {}),
      json(204, null),
      json(200, {}),
      json(204, null),
      json(200, {}),
      json(204, null),
    ]);
    await createPromotionalOffer(credentials, { subscriptionId: '1', name: 'n', offerCode: 'c', duration: 'ONE_YEAR', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, prices }, { budget });
    await replacePromotionalOfferPrices(credentials, 'p', [], prices, { budget });
    await deletePromotionalOffer(credentials, 'p', { budget });
    await setIntroductoryOfferEndDate(credentials, 'i', '2030-01-01', { budget });
    await deleteIntroductoryOffer(credentials, 'i', { budget });
    await setOfferCodeActive(credentials, 'c', false, { budget });
    await deleteWinBackOffer(credentials, 'w', { budget });
    expect(budget.remaining).toBe(0);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/subscriptionPromotionalOffers',
      'PATCH /v1/subscriptionPromotionalOffers/p',
      'DELETE /v1/subscriptionPromotionalOffers/p',
      'PATCH /v1/subscriptionIntroductoryOffers/i',
      'DELETE /v1/subscriptionIntroductoryOffers/i',
      'PATCH /v1/subscriptionOfferCodes/c',
      'DELETE /v1/winBackOffers/w',
    ]);
    await expect(updateWinBackOffer(credentials, 'w', { endDate: null }, { budget })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(calls).toHaveLength(7);
  });
});
