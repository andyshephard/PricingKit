import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ApiError } from '@/lib/utils/api-error';
import { RequestBudget } from '@/lib/utils/request-budget';

import { appleHeaders } from '@/app/api/__tests__/helpers';

const getSubscriptionPricePoints = vi.fn();
vi.mock('@/lib/apple-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apple-connect')>()),
  getSubscriptionPricePoints: (...args: unknown[]) => getSubscriptionPricePoints(...args),
}));

const assertSubscriptionInApp = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/lib/apple-connect/ownership', () => ({ assertSubscriptionInApp: (...args: unknown[]) => assertSubscriptionInApp(...args) }));

import { POST } from '../route';

async function events(response: Response) {
  const text = await response.text();
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

function request(territories: Record<string, { targetPrice: number; currency: string }>) {
  return new NextRequest('http://localhost/api/apple/subscriptions/123/price-points/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...appleHeaders() },
    body: JSON.stringify({ territories }),
  });
}

// Block body: a function returned from beforeEach runs as a teardown in vitest
beforeEach(() => {
  getSubscriptionPricePoints.mockReset();
  assertSubscriptionInApp.mockReset();
  assertSubscriptionInApp.mockResolvedValue(undefined);
});

describe('POST price-points/batch: the subscription', () => {
  it('must be a numeric ID: anything else never reaches the App Store Connect path', async () => {
    for (const id of ['..', 'v1/apps', '123%2F..%2Fapps', 'abc']) {
      const res = await POST(request({ US: { targetPrice: 5, currency: 'USD' } }), { params: Promise.resolve({ id }) });
      expect(res.status, id).toBe(400);
    }
    expect(assertSubscriptionInApp).not.toHaveBeenCalled();
    expect(getSubscriptionPricePoints).not.toHaveBeenCalled();
  });

  it("must belong to the session's app", async () => {
    assertSubscriptionInApp.mockRejectedValue(new ApiError('not in app', { status: 409, code: 'APP_MISMATCH', platform: 'apple' }));
    const res = await POST(request({ US: { targetPrice: 5, currency: 'USD' } }), { params: Promise.resolve({ id: '123' }) });
    expect(res.status).toBe(409);
    expect(getSubscriptionPricePoints).not.toHaveBeenCalled();
  });

  it('takes only territory codes as keys', async () => {
    const res = await POST(request({ constructor: { targetPrice: 5, currency: 'USD' } }), { params: Promise.resolve({ id: '123' }) });
    expect(res.status).toBe(400);
  });
});

describe('POST price-points/batch', () => {
  it('passes one RequestBudget to every lookup in the run', async () => {
    getSubscriptionPricePoints.mockResolvedValue([{ id: 'pp', customerPrice: '4.99', proceeds: '3.5' }]);
    const response = await POST(request({ US: { targetPrice: 5, currency: 'USD' }, GB: { targetPrice: 4, currency: 'GBP' } }), {
      params: Promise.resolve({ id: '123' }),
    });
    const done = (await events(response)).at(-1);
    expect(done.type).toBe('done');
    const budgets = getSubscriptionPricePoints.mock.calls.map((call) => call[3]?.budget);
    expect(budgets[0]).toBeInstanceOf(RequestBudget);
    expect(budgets[1]).toBe(budgets[0]);
  });

  it('aborts the run when the budget is spent instead of skipping every territory', async () => {
    getSubscriptionPricePoints.mockRejectedValue(
      new ApiError('Request budget exceeded', { status: 429, code: 'BUDGET_EXCEEDED', platform: 'apple', retryable: false })
    );
    const response = await POST(request({ US: { targetPrice: 5, currency: 'USD' } }), {
      params: Promise.resolve({ id: '123' }),
    });
    const last = (await events(response)).at(-1);
    expect(last.type).toBe('error');
    expect(getSubscriptionPricePoints).toHaveBeenCalledTimes(1);
  });
});
