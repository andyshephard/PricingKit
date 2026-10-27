import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ApiError } from '@/lib/utils/api-error';
import { RequestBudget } from '@/lib/utils/request-budget';

vi.mock('@/middleware/auth', () => ({
  getAppleAuthFromCookies: vi.fn(async () => ({
    credentials: { privateKey: 'unused', keyId: 'TESTKEY123', issuerId: 'issuer', bundleId: 'com.example.test' },
    bundleId: 'com.example.test',
  })),
}));

const getSubscriptionPricePoints = vi.fn();
vi.mock('@/lib/apple-connect', () => ({
  getSubscriptionPricePoints: (...args: unknown[]) => getSubscriptionPricePoints(...args),
}));

import { POST } from '../route';

async function events(response: Response) {
  const text = await response.text();
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

function request(territories: Record<string, { targetPrice: number; currency: string }>) {
  return new NextRequest('http://localhost/api/apple/subscriptions/123/price-points/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ territories }),
  });
}

// Block body: a function returned from beforeEach runs as a teardown in vitest
beforeEach(() => {
  getSubscriptionPricePoints.mockReset();
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
