import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

import { appleHeaders } from '@/app/api/__tests__/helpers';

let signedIn = true;

const planOffers = vi.fn();
const fetchOffer = vi.fn();
const verifyProduct = vi.fn();
const constructed: unknown[] = [];
vi.mock('@/lib/adapters/apple', () => ({
  AppleAdapter: class {
    constructor(options: unknown) {
      constructed.push(options);
    }
    planOffers = (...args: unknown[]) => planOffers(...args);
    verifyProduct = (...args: unknown[]) => verifyProduct(...args);
    fetchOffer = (...args: unknown[]) => fetchOffer(...args);
  },
}));

import { POST } from '../route';

const call = (body: unknown, id = '123') =>
  POST(new NextRequest(`http://localhost/api/apple/subscriptions/${id}/offers/plan`, { method: 'POST', headers: { 'content-type': 'application/json', ...(signedIn ? appleHeaders() : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

const create = { action: 'create', offerCode: 'example_half', name: 'Half', mode: 'PAY_UP_FRONT', duration: 'P1Y', percent: '50', basis: 'totalOverDuration', snap: 'nearest' };

beforeEach(() => {
  signedIn = true;
  planOffers.mockReset();
  planOffers.mockResolvedValue({ changeSet: { ops: [] }, hash: '0123456789abcdef', entries: [{ action: 'create' }] });
  fetchOffer.mockReset();
  verifyProduct.mockReset();
  verifyProduct.mockResolvedValue(undefined);
  constructed.length = 0;
});

describe('POST offers/plan', () => {
  it('returns 401 without a token and reads nothing', async () => {
    signedIn = false;
    expect((await call(create)).status).toBe(401);
    expect(constructed).toHaveLength(0);
  });

  it('plans a promotional offer for the signed-in app from the rule', async () => {
    const response = await call(create);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changeSet: { ops: [] }, hash: '0123456789abcdef', entry: { action: 'create' } });
    const [{ app, offers }] = planOffers.mock.calls[0];
    expect(app).toEqual({ bundleId: 'com.example.test' });
    expect(offers[0]).toMatchObject({ id: 'example_half', name: 'Half', kind: 'apple.promo', mode: 'PAY_UP_FRONT', duration: 'P1Y', pricing: { percent: '50', basis: 'totalOverDuration' } });
  });

  it('re-prices an existing promo with its own terms', async () => {
    fetchOffer.mockResolvedValue({ kind: 'apple.promo', storeId: 'p1', key: 'example_half', name: 'Half', mode: 'PAY_UP_FRONT', duration: 'P6M', periods: 1, prices: {} });
    const response = await call({ action: 'updatePrices', offer: 'p1', percent: '40', basis: 'perPeriod', snap: 'floor' });
    expect(response.status).toBe(200);
    expect(planOffers.mock.calls[0][0].offers[0]).toMatchObject({ id: 'example_half', duration: 'P6M', pricing: { percent: '40', snap: 'floor' } });
    fetchOffer.mockResolvedValue(null);
    expect((await call({ action: 'updatePrices', offer: 'nope', percent: '40', basis: 'perPeriod' })).status).toBe(404);
  });

  it('refuses bad input before reading anything', async () => {
    expect((await call({ ...create, percent: '150' })).status).toBe(400);
    expect((await call({ ...create, mode: 'FREE_TRIAL' })).status).toBe(400);
    expect((await call({ ...create, extra: 1 })).status).toBe(400);
    expect((await call(create, 'com.example.sub')).status).toBe(400);
    expect(planOffers).not.toHaveBeenCalled();
  });

  it('refuses a subscription from another app on the same key before planning', async () => {
    const { ApiError } = await import('@/lib/utils/api-error');
    verifyProduct.mockRejectedValue(new ApiError('not this app', { status: 409, code: 'APP_MISMATCH', platform: 'apple', retryable: false }));
    const response = await call(create);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'APP_MISMATCH' });
    expect(verifyProduct).toHaveBeenCalledWith({ platform: 'apple', type: 'subscription', id: '123' });
    expect(planOffers).not.toHaveBeenCalled();
  });
});
