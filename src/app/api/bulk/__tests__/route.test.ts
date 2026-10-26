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
  it('reports a subscription without basePlanId as a failed item', async () => {
    const response = await POST(
      bulkRequest({
        items: [{ type: 'subscription', id: 'premium' }],
        operation: { type: 'percentage', value: 10 },
        targetRegions: ['US'],
      })
    );
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.successful).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0]).toMatchObject({
      id: 'premium',
      success: false,
      committed: false,
      error: expect.stringMatching(/basePlanId/),
    });
    expect(getSubscription).not.toHaveBeenCalled();
    expect(updateBasePlanPrices).not.toHaveBeenCalled();
  });

  it('is not successful overall when any item failed', async () => {
    getInAppProduct.mockResolvedValue(product);
    updateInAppProductPrices.mockResolvedValue(product);

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
