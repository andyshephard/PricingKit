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

// A plain recorder rather than vi.fn: with vitest 4.1 a vi.fn whose promise
// rejects inside the route's background task failed this test after all its
// assertions passed
type Lookup = (...args: unknown[]) => Promise<unknown>;
const lookups: unknown[][] = [];
let lookup: Lookup = async () => [];
vi.mock('@/lib/apple-connect', () => ({
  getSubscriptionPricePoints: (...args: unknown[]) => {
    lookups.push(args);
    return lookup(...args);
  },
}));

import { POST } from '../route';

async function events(response: Response) {
  const text = await response.text();
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

function request(territories: Record<string, { targetPrice: number; currency: string }>) {
  return new NextRequest('http://localhost/api/apple/subscriptions/123/price-points/batch', {
    method: 'POST',
    body: JSON.stringify({ territories }),
  });
}

beforeEach(() => {
  lookups.length = 0;
  lookup = async () => [];
});

describe('POST price-points/batch', () => {
  it('passes one RequestBudget to every lookup in the run', async () => {
    lookup = async () => [{ id: 'pp', customerPrice: '4.99', proceeds: '3.5' }];
    const response = await POST(request({ US: { targetPrice: 5, currency: 'USD' }, GB: { targetPrice: 4, currency: 'GBP' } }), {
      params: Promise.resolve({ id: '123' }),
    });
    const done = (await events(response)).at(-1);
    expect(done.type).toBe('done');
    const budgets = lookups.map((call) => (call[3] as { budget?: RequestBudget } | undefined)?.budget);
    expect(budgets[0]).toBeInstanceOf(RequestBudget);
    expect(budgets[1]).toBe(budgets[0]);
  });

  it('aborts the run when the budget is spent instead of skipping every territory', async () => {
    lookup = async () => {
      throw new ApiError('Request budget exceeded', { status: 429, code: 'BUDGET_EXCEEDED', platform: 'apple', retryable: false });
    };
    const response = await POST(request({ US: { targetPrice: 5, currency: 'USD' } }), {
      params: Promise.resolve({ id: '123' }),
    });
    const last = (await events(response)).at(-1);
    expect(last.type).toBe('error');
    expect(lookups).toHaveLength(1);
  });
});
