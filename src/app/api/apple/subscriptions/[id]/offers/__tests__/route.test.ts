import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ApiError } from '@/lib/utils/api-error';
import { RequestBudget } from '@/lib/utils/request-budget';

const session = {
  credentials: { privateKey: 'unused', keyId: 'TESTKEY123', issuerId: 'issuer', bundleId: 'com.example.test' },
  bundleId: 'com.example.test',
};
const getAppleAuthFromCookies = vi.fn();
vi.mock('@/middleware/auth', () => ({
  getAppleAuthFromCookies: () => getAppleAuthFromCookies(),
}));

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

import { GET } from '../route';

function call(id: string) {
  return GET(new NextRequest(`http://localhost/api/apple/subscriptions/${id}/offers`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  fetchOffers.mockReset();
  getAppleAuthFromCookies.mockReset();
  getAppleAuthFromCookies.mockResolvedValue(session);
  constructed.length = 0;
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

  it('returns 401 without a session and never builds an adapter', async () => {
    getAppleAuthFromCookies.mockResolvedValue(null);
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
