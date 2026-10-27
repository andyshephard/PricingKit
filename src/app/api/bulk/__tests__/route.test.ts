import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { InAppProduct } from '@/lib/google-play/types';

// No network: auth and every Google Play call are mocked
vi.mock('../../auth/route', () => ({
  getAuthFromCookies: vi.fn(async () => ({
    credentials: { client_email: 'test@example.com', private_key: 'unused' },
    packageName: 'com.example.app',
  })),
}));

const getInAppProduct = vi.fn();
const updateInAppProductPrices = vi.fn();
vi.mock('@/lib/google-play/products', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/google-play/products')>();
  return {
    ...actual,
    getInAppProduct: (...args: unknown[]) => getInAppProduct(...args),
    updateInAppProductPrices: (...args: unknown[]) => updateInAppProductPrices(...args),
  };
});

const getSubscription = vi.fn();
const updateBasePlanPrices = vi.fn();
vi.mock('@/lib/google-play/subscriptions', () => ({
  getSubscription: (...args: unknown[]) => getSubscription(...args),
  updateBasePlanPrices: (...args: unknown[]) => updateBasePlanPrices(...args),
}));

import { POST } from '../route';

function bulkRequest(body: unknown) {
  return new NextRequest('http://localhost/api/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const product: InAppProduct = {
  packageName: 'com.example.app',
  sku: 'coins_100',
  status: 'active',
  purchaseType: 'managedUser',
  defaultLanguage: 'en-US',
  listings: {},
  defaultPrice: { currencyCode: 'USD', units: '12' },
  prices: {
    US: { currencyCode: 'USD', units: '12' },
    JP: { currencyCode: 'JPY', units: '1234' },
  },
};

beforeEach(() => {
  getInAppProduct.mockReset();
  updateInAppProductPrices.mockReset();
  getSubscription.mockReset();
  updateBasePlanPrices.mockReset();
});

describe('POST /api/bulk', () => {
  const twoPlanSubscription = {
    productId: 'premium',
    basePlans: [
      {
        basePlanId: 'monthly',
        regionalConfigs: [{ regionCode: 'US', price: { currencyCode: 'USD', units: '10' } }],
      },
      {
        basePlanId: 'yearly',
        regionalConfigs: [{ regionCode: 'US', price: { currencyCode: 'USD', units: '100' } }],
      },
    ],
  };

  it('expands a subscription without basePlanId to every base plan', async () => {
    getSubscription.mockResolvedValue(twoPlanSubscription);
    updateBasePlanPrices.mockResolvedValue({});

    const response = await POST(
      bulkRequest({
        items: [{ type: 'subscription', id: 'premium' }],
        operation: { type: 'percentage', value: 10 },
        targetRegions: ['US'],
      })
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.total).toBe(2);
    expect(body.successful).toBe(2);
    expect(body.results.map((r: { basePlanId: string }) => r.basePlanId)).toEqual([
      'monthly',
      'yearly',
    ]);
    expect(getSubscription).toHaveBeenCalledTimes(1);
    expect(updateBasePlanPrices.mock.calls.map((c) => c[3])).toEqual(['monthly', 'yearly']);
    expect(updateBasePlanPrices.mock.calls[0][4][0].price).toEqual({
      currencyCode: 'USD',
      units: '11',
      nanos: undefined,
    });
  });

  it('reports each expanded base plan separately when one fails', async () => {
    getSubscription.mockResolvedValue(twoPlanSubscription);
    updateBasePlanPrices
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({});

    const response = await POST(
      bulkRequest({
        items: [{ type: 'subscription', id: 'premium' }],
        operation: { type: 'percentage', value: 10 },
        targetRegions: ['US'],
      })
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.failed).toBe(1);
    expect(body.successful).toBe(1);
    expect(body.results[0]).toMatchObject({ basePlanId: 'monthly', success: false, committed: false });
    expect(body.results[1]).toMatchObject({ basePlanId: 'yearly', success: true, committed: true });
  });

  it('stops expanding base plans after a failure when stopOnFailure is set', async () => {
    getSubscription.mockResolvedValue(twoPlanSubscription);
    updateBasePlanPrices.mockRejectedValueOnce(new Error('boom'));

    const response = await POST(
      bulkRequest({
        items: [{ type: 'subscription', id: 'premium' }],
        operation: { type: 'percentage', value: 10 },
        targetRegions: ['US'],
        stopOnFailure: true,
      })
    );
    const body = await response.json();

    expect(body.stoppedEarly).toBe(true);
    expect(updateBasePlanPrices).toHaveBeenCalledTimes(1);
    expect(body.results[1]).toMatchObject({
      basePlanId: 'yearly',
      success: false,
      error: expect.stringMatching(/Skipped/),
    });
  });

  it('fails a subscription without base plans instead of skipping it', async () => {
    getSubscription.mockResolvedValue({ productId: 'premium', basePlans: [] });

    const response = await POST(
      bulkRequest({
        items: [{ type: 'subscription', id: 'premium' }],
        operation: { type: 'percentage', value: 10 },
        targetRegions: ['US'],
      })
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.results[0]).toMatchObject({
      id: 'premium',
      success: false,
      error: 'Subscription has no base plans',
    });
    expect(updateBasePlanPrices).not.toHaveBeenCalled();
  });

  it('is not successful overall when any item failed', async () => {
    getInAppProduct.mockResolvedValue(product);
    updateInAppProductPrices.mockResolvedValue(product);
    getSubscription.mockResolvedValue(null);

    const response = await POST(
      bulkRequest({
        items: [
          { type: 'product', id: 'coins_100' },
          { type: 'subscription', id: 'premium' },
        ],
        operation: { type: 'percentage', value: 10 },
        targetRegions: ['US'],
      })
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.successful).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[1].error).toBe('Subscription not found');
  });

  it('reports regions without an existing price as skipped with a reason', async () => {
    getInAppProduct.mockResolvedValue(product);
    updateInAppProductPrices.mockResolvedValue(product);

    const response = await POST(
      bulkRequest({
        items: [{ type: 'product', id: 'coins_100' }],
        operation: { type: 'percentage', value: 10 },
        targetRegions: ['US', 'DE'],
      })
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.skippedRegions).toBe(1);
    expect(body.results[0].skippedRegions).toEqual([
      { regionCode: 'DE', reason: expect.stringMatching(/No existing price/) },
    ]);
    expect(Object.keys(updateInAppProductPrices.mock.calls[0][3])).toEqual(['US']);
  });

  it('fails an item when every target region was skipped', async () => {
    getInAppProduct.mockResolvedValue(product);

    const response = await POST(
      bulkRequest({
        items: [{ type: 'product', id: 'coins_100' }],
        operation: { type: 'percentage', value: 10 },
        targetRegions: ['DE', 'FR'],
      })
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.successful).toBe(0);
    expect(body.results[0].success).toBe(false);
    expect(body.results[0].skippedRegions).toHaveLength(2);
    expect(updateInAppProductPrices).not.toHaveBeenCalled();
  });

  it('round operation never raises a price and respects JPY', async () => {
    getInAppProduct.mockResolvedValue(product);
    updateInAppProductPrices.mockResolvedValue(product);

    await POST(
      bulkRequest({
        items: [{ type: 'product', id: 'coins_100' }],
        operation: { type: 'round', roundTo: 0.99 },
        targetRegions: ['US', 'JP'],
      })
    );

    const sent = updateInAppProductPrices.mock.calls[0][3];
    expect(sent.US).toEqual({ currencyCode: 'USD', units: '11', nanos: 990_000_000 });
    expect(sent.JP).toEqual({ currencyCode: 'JPY', units: '1190', nanos: undefined });
  });

  it('uses the same price maths for subscription base plans', async () => {
    getSubscription.mockResolvedValue({
      productId: 'premium',
      basePlans: [
        {
          basePlanId: 'monthly',
          regionalConfigs: [{ regionCode: 'US', price: { currencyCode: 'USD', units: '12' } }],
        },
      ],
    });
    updateBasePlanPrices.mockResolvedValue({});

    const response = await POST(
      bulkRequest({
        items: [{ type: 'subscription', id: 'premium', basePlanId: 'monthly' }],
        operation: { type: 'round', roundTo: 0.99 },
        targetRegions: ['US'],
      })
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(updateBasePlanPrices.mock.calls[0][4]).toEqual([
      { regionCode: 'US', price: { currencyCode: 'USD', units: '11', nanos: 990_000_000 } },
    ]);
  });
});
