import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ApiError } from '@/lib/utils/api-error';
import { RequestBudget } from '@/lib/utils/request-budget';

import { appleHeaders, TEST_APPLE_ISSUER_ID } from '@/app/api/__tests__/helpers';

let signedIn = true;

const fetchOffers = vi.fn();
const constructed: Array<{ budget?: unknown }> = [];
vi.mock('@/lib/adapters/apple', () => ({
  AppleAdapter: class {
    constructor(options: { budget?: unknown }) {
      constructed.push(options);
    }
    fetchOffers = (...args: unknown[]) => fetchOffers(...args);
  },
}));

const assertSubscriptionInApp = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/lib/apple-connect/ownership', () => ({ assertSubscriptionInApp: (...args: unknown[]) => assertSubscriptionInApp(...args) }));

import { GET } from '../route';

function call(id: string) {
  return GET(new NextRequest(`http://localhost/api/apple/subscriptions/${id}/offers`, { headers: signedIn ? appleHeaders() : {} }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  fetchOffers.mockReset();
  signedIn = true;
  constructed.length = 0;
  assertSubscriptionInApp.mockReset();
  assertSubscriptionInApp.mockResolvedValue(undefined);
});

describe('GET offers ownership', () => {
  it("refuses another app's subscription before reading its offers", async () => {
    assertSubscriptionInApp.mockRejectedValue(new ApiError('Subscription 456 is not in com.example.test', { status: 409, code: 'APP_MISMATCH', platform: 'apple' }));
    const res = await call('456');
    expect(res.status).toBe(409);
    // The app named in X-PK-App, with the token from X-PK-Apple-Token (labelled by its non-secret IDs)
    expect(assertSubscriptionInApp).toHaveBeenCalledWith(
      { bundleId: 'com.example.test', tokens: expect.objectContaining({ platform: 'apple', label: `${TEST_APPLE_ISSUER_ID}:TESTKEY123` }) },
      '456',
      expect.objectContaining({ budget: expect.any(RequestBudget) })
    );
    expect(fetchOffers).not.toHaveBeenCalled();
  });
});

describe('GET offers', () => {
  it('lists the subscription offers with a fresh budget per request', async () => {
    const offers = [{ kind: 'apple.promo', storeId: 'p1', key: 'example_half', mode: 'PAY_UP_FRONT', duration: 'P1Y', prices: {} }];
    fetchOffers.mockResolvedValue(offers);
    const response = await call('123');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offers });
    expect(fetchOffers).toHaveBeenCalledWith({ platform: 'apple', type: 'subscription', id: '123' });
    expect(constructed[0].budget).toBeInstanceOf(RequestBudget);
    await call('123');
    expect(constructed[1].budget).not.toBe(constructed[0].budget);
  });

  it('returns 401 without a token and never builds an adapter', async () => {
    signedIn = false;
    expect((await call('123')).status).toBe(401);
    expect(constructed).toHaveLength(0);
    expect(fetchOffers).not.toHaveBeenCalled();
  });

  it('refuses a non-numeric subscription ID', async () => {
    expect((await call('com.example.sub')).status).toBe(400);
    expect(fetchOffers).not.toHaveBeenCalled();
  });

  it("passes App Store Connect's status through, e.g. a spent budget", async () => {
    fetchOffers.mockRejectedValue(new ApiError('Request budget exceeded', { status: 429, code: 'BUDGET_EXCEEDED', platform: 'apple', retryable: false }));
    const response = await call('123');
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });
});
