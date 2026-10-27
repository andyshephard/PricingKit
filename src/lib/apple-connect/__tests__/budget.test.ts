// Every request a helper sends must consume from the caller's RequestBudget,
// and bulk reads must stay within a bounded concurrency.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '../types';
import { appleKeyConnection } from '../../token-source';

const appleApiRequest = vi.fn();
const getAppIdForBundleId = vi.fn();
vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return {
    ...actual,
    appleApiRequest: (...args: unknown[]) => appleApiRequest(...args),
    getAppIdForBundleId: (...args: unknown[]) => getAppIdForBundleId(...args),
  };
});

import { listInAppPurchases, APPLE_READ_CONCURRENCY } from '../products';
import { applySubscriptionPriceChanges, getSubscription, getSubscriptionPricePoints } from '../subscriptions';
import { RequestBudget } from '@/lib/utils/request-budget';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.test',
};
const connection = appleKeyConnection(credentials);

// Simulates the real client: each call consumes one unit of the passed budget
function budgetedApi(handler: (endpoint: string, options: Record<string, unknown>) => unknown) {
  appleApiRequest.mockImplementation(async (_c: unknown, endpoint: string, options: Record<string, unknown> = {}) => {
    (options.budget as RequestBudget | undefined)?.consume('apple');
    return handler(endpoint, options);
  });
}

beforeEach(() => {
  appleApiRequest.mockReset();
  getAppIdForBundleId.mockReset();
  getAppIdForBundleId.mockResolvedValue('1234567890');
});

describe('RequestBudget threading', () => {
  it('passes the budget to every request of a subscription lookup, including the app lookup', async () => {
    budgetedApi((endpoint) => {
      if (endpoint.endsWith('/subscriptionGroups')) return { data: [{ id: 'g1', attributes: { referenceName: 'G' } }] };
      if (endpoint.endsWith('/subscriptions')) {
        return { data: [{ id: 's1', attributes: { productId: 'com.example.monthly', name: 'M', state: 'APPROVED', subscriptionPeriod: 'ONE_MONTH' } }] };
      }
      return { data: { id: 's1', attributes: { productId: 'com.example.monthly', name: 'M', state: 'APPROVED', subscriptionPeriod: 'ONE_MONTH' } } };
    });
    const budget = new RequestBudget({ limit: 100 });
    await getSubscription(connection, 'com.example.monthly', { budget });
    expect(getAppIdForBundleId).toHaveBeenCalledWith(connection, { budget });
    expect(appleApiRequest).toHaveBeenCalledTimes(3);
    for (const call of appleApiRequest.mock.calls) expect(call[2].budget).toBe(budget);
    expect(budget.used).toBe(3);
  });

  it('stops sending once the budget is spent', async () => {
    budgetedApi(() => ({ data: [] }));
    const budget = new RequestBudget({ limit: 1 });
    await getSubscriptionPricePoints(connection, 'sub-1', 'USA', { budget });
    await expect(getSubscriptionPricePoints(connection, 'sub-1', 'GBR', { budget })).rejects.toMatchObject({
      status: 429,
      code: 'BUDGET_EXCEEDED',
    });
  });

  it('reads a territory ladder in one request of up to 8000 points', async () => {
    budgetedApi(() => ({ data: [] }));
    await getSubscriptionPricePoints(connection, 'sub-1', 'USA');
    expect(appleApiRequest.mock.calls[0][2].queryParams.limit).toBe('8000');
  });

  it('charges creates and deletes of a price change run to its budget', async () => {
    budgetedApi(() => ({}));
    const budget = new RequestBudget({ limit: 3 });
    const outcomes = await applySubscriptionPriceChanges(
      connection,
      'sub-1',
      {
        US: { pricePointId: 'pp-us', startDate: '2099-01-01' },
        GB: { pricePointId: 'pp-gb' },
        FR: { pricePointId: 'pp-fr' },
      },
      { US: { territoryCode: 'US', currency: 'USD', customerPrice: '4.99', proceeds: '3.5', pricePointId: 'old', subscriptionPriceId: 'sp-old', startDate: '2098-01-01' } },
      { budget, rateLimit: { concurrency: 1, delayBetweenBatches: 0 } }
    );
    // US create + delete = 2, GB create = 3, FR refused before sending
    expect(budget.used).toBe(3);
    expect(outcomes.map((o) => o.status)).toEqual(['replaced', 'created', 'failed']);
    expect(outcomes[2].error).toMatch(/budget/i);
  });
});

describe('listInAppPurchases', () => {
  it('reads base prices with bounded concurrency', async () => {
    const products = Array.from({ length: 12 }, (_, i) => ({
      id: `iap-${i}`,
      type: 'inAppPurchases',
      attributes: { productId: `com.example.item${i}`, name: `Item ${i}`, inAppPurchaseType: 'CONSUMABLE', state: 'APPROVED' },
    }));
    const schedules = products.map((p) => ({
      id: p.id,
      type: 'inAppPurchasePriceSchedules',
      relationships: { baseTerritory: { data: { id: 'GBR' } } },
    }));
    let inFlight = 0;
    let peak = 0;
    appleApiRequest.mockImplementation(async (_c: unknown, endpoint: string) => {
      if (endpoint.endsWith('/inAppPurchasesV2')) return { data: products, included: schedules };
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return {
        data: [{ id: 'price', type: 'inAppPurchasePrices', attributes: {} }],
        included: [
          { id: 'pp', type: 'inAppPurchasePricePoints', attributes: { customerPrice: '1.99', proceeds: '1.4' } },
          { id: 'GBR', type: 'territories', attributes: { currency: 'GBP' } },
        ],
      };
    });

    const result = await listInAppPurchases(connection);
    expect(result).toHaveLength(12);
    expect(result.every((p) => p.prices.GBR?.customerPrice === '1.99')).toBe(true);
    expect(peak).toBeLessThanOrEqual(APPLE_READ_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
});
