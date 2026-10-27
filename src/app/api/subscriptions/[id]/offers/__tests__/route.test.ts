import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { ApiError } from '@/lib/utils/api-error';
import { RequestBudget } from '@/lib/utils/request-budget';

const session = { credentials: { client_email: 'robot@example-project.iam.gserviceaccount.com' }, packageName: 'com.example.app' };
const getGoogleAuthFromCookies = vi.fn();
vi.mock('@/middleware/auth', () => ({
  getGoogleAuthFromCookies: () => getGoogleAuthFromCookies(),
}));

const fetchOffers = vi.fn();
const fetchSubscriptionOffers = vi.fn();
const constructed: Array<{ packageName?: string; budget?: unknown }> = [];
vi.mock('@/lib/adapters/play', () => ({
  PlayAdapter: class {
    constructor(options: { packageName?: string; budget?: unknown }) {
      constructed.push(options);
    }
    fetchOffers = (...args: unknown[]) => fetchOffers(...args);
    fetchSubscriptionOffers = (...args: unknown[]) => fetchSubscriptionOffers(...args);
  },
}));

import { GET } from '../route';

function call(id: string, query = '') {
  return GET(new NextRequest(`http://localhost/api/subscriptions/${id}/offers${query}`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  fetchOffers.mockReset();
  fetchSubscriptionOffers.mockReset();
  getGoogleAuthFromCookies.mockReset();
  getGoogleAuthFromCookies.mockResolvedValue(session);
  constructed.length = 0;
});

describe('GET /api/subscriptions/[id]/offers (Google Play, read-only)', () => {
  it("lists every base plan's offers for the session's app, with a fresh budget per request", async () => {
    const offers = [{ kind: 'play.offer', storeId: 'com.example.pro/annual/annual-half-off', key: 'annual-half-off', mode: null, duration: null, prices: {} }];
    fetchSubscriptionOffers.mockResolvedValue(offers);
    const response = await call('com.example.pro');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offers });
    expect(fetchSubscriptionOffers).toHaveBeenCalledWith('com.example.pro');
    expect(constructed[0]).toMatchObject({ packageName: 'com.example.app' });
    expect(constructed[0].budget).toBeInstanceOf(RequestBudget);
    await call('com.example.pro');
    expect(constructed[1].budget).not.toBe(constructed[0].budget);
  });

  it('reads one base plan with basePlanId', async () => {
    fetchOffers.mockResolvedValue([]);
    expect((await call('com.example.pro', '?basePlanId=annual')).status).toBe(200);
    expect(fetchOffers).toHaveBeenCalledWith({ platform: 'google', type: 'subscription', productId: 'com.example.pro', basePlanId: 'annual' });
  });

  it('returns 401 without a session and never builds an adapter', async () => {
    getGoogleAuthFromCookies.mockResolvedValue(null);
    expect((await call('com.example.pro')).status).toBe(401);
    expect(constructed).toHaveLength(0);
  });

  it('refuses a bad base plan ID and passes 404 and 429 through; other errors are generic', async () => {
    expect((await call('com.example.pro', '?basePlanId=%20bad')).status).toBe(400);
    fetchSubscriptionOffers.mockRejectedValueOnce(new ApiError('Subscription not found', { status: 404, platform: 'google' }));
    expect((await call('com.example.pro')).status).toBe(404);
    fetchSubscriptionOffers.mockRejectedValueOnce(new ApiError('Request budget exhausted', { status: 429, code: 'BUDGET_EXCEEDED', platform: 'google' }));
    expect((await call('com.example.pro')).status).toBe(429);
    fetchSubscriptionOffers.mockRejectedValueOnce(new Error('upstream detail that stays in the log'));
    const failed = await call('com.example.pro');
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'Failed to fetch offers' });
  });

  it('only reads: the route has no write handler and no write import', () => {
    const text = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8');
    expect(text).not.toMatch(/export (async function|const) (POST|PATCH|PUT|DELETE)\b/);
    expect(text).not.toMatch(/applyChangeSet|applyOffer|createSubscriptionOffer|patchSubscriptionOffer/);
    expect(text).toMatch(/from '@\/middleware\/auth'/);
  });
});
