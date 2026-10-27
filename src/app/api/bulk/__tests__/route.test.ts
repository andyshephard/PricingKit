import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { InAppProduct } from '@/lib/google-play/types';

import { googleHeaders } from '@/app/api/__tests__/helpers';

// No network: every Google Play call is mocked

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
    headers: { 'Content-Type': 'application/json', ...googleHeaders() },
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
        expectedPrices: { 'premium/monthly': { US: 'USD 10' }, 'premium/yearly': { US: 'USD 100' } },
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
        expectedPrices: { 'premium/monthly': { US: 'USD 10' }, 'premium/yearly': { US: 'USD 100' } },
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
        expectedPrices: { 'premium/monthly': { US: 'USD 10' }, 'premium/yearly': { US: 'USD 100' } },
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
        expectedPrices: {},
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
        expectedPrices: { coins_100: { US: 'USD 12' } },
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
        expectedPrices: { coins_100: { US: 'USD 12' } },
      })
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.skippedRegions).toBe(1);
    expect(body.results[0].skippedRegions).toEqual([
      { regionCode: 'DE', reason: expect.stringMatching(/No existing price/), code: 'NO_PRICE' },
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
        expectedPrices: {},
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
        expectedPrices: { coins_100: { US: 'USD 12', JP: 'JPY 1234' } },
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
        expectedPrices: { 'premium/monthly': { US: 'USD 12' } },
      })
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(updateBasePlanPrices.mock.calls[0][4]).toEqual([
      { regionCode: 'US', price: { currencyCode: 'USD', units: '11', nanos: 990_000_000 } },
    ]);
  });

  describe('preview first', () => {
    const base = { items: [{ type: 'product', id: 'coins_100' }], operation: { type: 'percentage', value: 10 }, targetRegions: ['US', 'JP'] };

    it('dryRun returns every change with exact old and new prices and writes nothing', async () => {
      getInAppProduct.mockResolvedValue({ ...product, prices: { US: { currencyCode: 'USD', units: '9', nanos: 990_000_000 }, JP: { currencyCode: 'JPY', units: '1234' } } });
      const body = await (await POST(bulkRequest({ ...base, dryRun: true }))).json();
      expect(body).toMatchObject({ dryRun: true, success: true, committed: 0 });
      expect(body.results[0]).toMatchObject({ id: 'coins_100', success: true, committed: false });
      expect(body.results[0].changes).toEqual([
        { regionCode: 'US', oldPrice: 'USD 9.99', newPrice: 'USD 10.989' },
        { regionCode: 'JP', oldPrice: 'JPY 1234', newPrice: 'JPY 1357' },
      ]);
      expect(updateInAppProductPrices).not.toHaveBeenCalled();
    });

    it('refuses to write without the preview it confirms', async () => {
      const res = await POST(bulkRequest(base));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Preview first/);
      expect(getInAppProduct).not.toHaveBeenCalled();
    });

    it('writes only regions whose price is still the previewed one', async () => {
      getInAppProduct.mockResolvedValue(product);
      updateInAppProductPrices.mockResolvedValue(product);
      const body = await (await POST(bulkRequest({ ...base, targetRegions: ['US', 'JP'], expectedPrices: { coins_100: { US: 'USD 11' } } }))).json();
      expect(updateInAppProductPrices).not.toHaveBeenCalled();
      expect(body.results[0]).toMatchObject({ success: false });
      expect(body.results[0].skippedRegions.map((r: { regionCode: string; code: string }) => [r.regionCode, r.code])).toEqual([
        ['US', 'PRICE_CHANGED'],
        ['JP', 'NOT_PREVIEWED'],
      ]);
    });

    it('writes the previewed regions when they still match', async () => {
      getInAppProduct.mockResolvedValue(product);
      updateInAppProductPrices.mockResolvedValue(product);
      const body = await (await POST(bulkRequest({ ...base, expectedPrices: { coins_100: { US: 'USD 12', JP: 'JPY 1234' } } }))).json();
      expect(body).toMatchObject({ success: true, committed: 1 });
      expect(updateInAppProductPrices.mock.calls[0][3]).toEqual({
        US: { currencyCode: 'USD', units: '13', nanos: 200_000_000 },
        JP: { currencyCode: 'JPY', units: '1357', nanos: undefined },
      });
    });
  });

  describe('fixed prices', () => {
    it('apply in one currency only: other currencies are left alone, never converted', async () => {
      getInAppProduct.mockResolvedValue(product);
      const body = await (
        await POST(bulkRequest({ items: [{ type: 'product', id: 'coins_100' }], operation: { type: 'fixed', value: 9.99, currency: 'USD' }, targetRegions: ['US', 'JP'], dryRun: true }))
      ).json();
      expect(body.results[0].changes).toEqual([{ regionCode: 'US', oldPrice: 'USD 12', newPrice: 'USD 9.99' }]);
      expect(body.results[0].skippedRegions).toEqual([{ regionCode: 'JP', code: 'OTHER_CURRENCY', reason: expect.stringMatching(/never converted/) }]);
    });

    it('need a currency and a value of 0 or more', async () => {
      for (const operation of [{ type: 'fixed', value: 9.99 }, { type: 'fixed', value: -1, currency: 'USD' }, { type: 'fixed', currency: 'USD' }]) {
        const res = await POST(bulkRequest({ items: [{ type: 'product', id: 'coins_100' }], operation, targetRegions: ['US'], dryRun: true }));
        expect(res.status, JSON.stringify(operation)).toBe(400);
      }
    });
  });

  it('validates product IDs, base plan IDs and regions', async () => {
    for (const body of [
      { items: [{ type: 'product', id: '..' }], operation: { type: 'percentage', value: 1 }, targetRegions: ['US'], dryRun: true },
      { items: [{ type: 'subscription', id: 'premium', basePlanId: '../x' }], operation: { type: 'percentage', value: 1 }, targetRegions: ['US'], dryRun: true },
      { items: [{ type: 'product', id: 'coins_100' }], operation: { type: 'percentage', value: 1 }, targetRegions: ['constructor'], dryRun: true },
      { items: [{ type: 'product', id: 'coins_100' }], operation: { type: 'percentage', value: 1 }, targetRegions: ['us'], dryRun: true },
    ]) {
      expect((await POST(bulkRequest(body))).status).toBe(400);
    }
    expect(getInAppProduct).not.toHaveBeenCalled();
  });

  describe('each product and base plan once, written only at the previewed price', () => {
    it('deduplicates repeated items and a base plan also covered by its subscription', async () => {
      getInAppProduct.mockResolvedValue(product);
      updateInAppProductPrices.mockResolvedValue(product);
      getSubscription.mockResolvedValue(twoPlanSubscription);
      updateBasePlanPrices.mockResolvedValue({});
      const body = await (
        await POST(
          bulkRequest({
            items: [
              { type: 'product', id: 'coins_100' },
              { type: 'product', id: 'coins_100' },
              { type: 'subscription', id: 'premium' },
              { type: 'subscription', id: 'premium', basePlanId: 'monthly' },
              { type: 'subscription', id: 'premium' },
            ],
            operation: { type: 'percentage', value: 10 },
            targetRegions: ['US'],
            expectedPrices: { coins_100: { US: 'USD 12' }, 'premium/monthly': { US: 'USD 10' }, 'premium/yearly': { US: 'USD 100' } },
          })
        )
      ).json();
      expect(updateInAppProductPrices).toHaveBeenCalledTimes(1);
      expect(updateBasePlanPrices.mock.calls.map((c) => c[3])).toEqual(['monthly', 'yearly']);
      expect(body.results.map((r: { id: string; basePlanId?: string }) => `${r.id}/${r.basePlanId ?? ''}`)).toEqual(['coins_100/', 'premium/monthly', 'premium/yearly']);
      // What was dropped is reported, not silently swallowed
      expect(body.duplicates).toEqual([
        { type: 'product', id: 'coins_100', reason: 'REPEATED_ITEM' },
        { type: 'subscription', id: 'premium', reason: 'REPEATED_ITEM' },
        { type: 'subscription', id: 'premium', basePlanId: 'monthly', reason: 'BASE_PLAN_COVERED' },
      ]);
    });

    it('hands the previewed prices to the write helpers, which re-check them against their own fresh read', async () => {
      getInAppProduct.mockResolvedValue(product);
      updateInAppProductPrices.mockResolvedValue(product);
      getSubscription.mockResolvedValue(twoPlanSubscription);
      updateBasePlanPrices.mockResolvedValue({});
      await POST(
        bulkRequest({
          items: [{ type: 'product', id: 'coins_100' }, { type: 'subscription', id: 'premium', basePlanId: 'yearly' }],
          operation: { type: 'percentage', value: 10 },
          targetRegions: ['US'],
          expectedPrices: { coins_100: { US: 'USD 12' }, 'premium/yearly': { US: 'USD 100' } },
        })
      );
      expect(updateInAppProductPrices.mock.calls[0][6]).toEqual({ expected: { US: { currencyCode: 'USD', units: '12' } } });
      expect(updateBasePlanPrices.mock.calls[0][6]).toEqual({ expected: { US: { currencyCode: 'USD', units: '100' } } });
    });

    it('reports PRICE_CHANGED when the price moved between this request\'s read and the write', async () => {
      getInAppProduct.mockResolvedValue(product);
      const { assertExpectedPrices } = await import('@/lib/google-play/expected-prices');
      updateInAppProductPrices.mockImplementation(async (...args: unknown[]) => {
        // The helper's own fresh read finds another price
        assertExpectedPrices({ US: { currencyCode: 'USD', units: '13' } }, (args[6] as { expected: Record<string, never> }).expected);
      });
      const body = await (
        await POST(bulkRequest({ items: [{ type: 'product', id: 'coins_100' }], operation: { type: 'percentage', value: 10 }, targetRegions: ['US'], expectedPrices: { coins_100: { US: 'USD 12' } } }))
      ).json();
      expect(body.results[0]).toMatchObject({ success: false, committed: false, error: expect.stringMatching(/^PRICE_CHANGED/) });
    });
  });
});

