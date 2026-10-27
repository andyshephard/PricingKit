import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getAuthFromCookies: vi.fn(),
  getAppleAuthFromCookies: vi.fn(),
  getInAppProductRaw: vi.fn(),
  getGoogleSubscription: vi.fn(),
  getInAppPurchase: vi.fn(),
  getBaseTerritoryForProduct: vi.fn(),
  getInAppPurchasePrices: vi.fn(),
  getAppleSubscription: vi.fn(),
  getAppleSubscriptionById: vi.fn(),
  getAppleSubscriptionPrices: vi.fn(),
}));

vi.mock('@/middleware/auth', () => ({
  getGoogleAuthFromCookies: mocks.getAuthFromCookies,
  getAppleAuthFromCookies: mocks.getAppleAuthFromCookies,
}));
// Only read functions are provided: any write call would fail as undefined.
vi.mock('@/lib/google-play/products', () => ({ getInAppProductRaw: mocks.getInAppProductRaw }));
vi.mock('@/lib/google-play/subscriptions', () => ({ getSubscription: mocks.getGoogleSubscription }));
vi.mock('@/lib/apple-connect', () => ({
  getInAppPurchase: mocks.getInAppPurchase,
  getBaseTerritoryForProduct: mocks.getBaseTerritoryForProduct,
  getInAppPurchasePrices: mocks.getInAppPurchasePrices,
  getSubscription: mocks.getAppleSubscription,
  getSubscriptionById: mocks.getAppleSubscriptionById,
  getSubscriptionPrices: mocks.getAppleSubscriptionPrices,
}));

const assertSubscriptionInApp = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/lib/apple-connect/ownership', () => ({
  APP_MISMATCH: 'APP_MISMATCH',
  assertSubscriptionInApp: (...args: unknown[]) => assertSubscriptionInApp(...args),
}));

import * as route from '../route';

function request(query: string) {
  return new NextRequest(`http://localhost/api/export?${query}`);
}

const googleAuth = { credentials: {}, packageName: 'com.example.app' };
const appleAuth = { credentials: {}, bundleId: 'com.example.app' };

beforeEach(() => {
  vi.clearAllMocks();
  assertSubscriptionInApp.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('/api/export', () => {
  it('only exposes GET', () => {
    const handlers = Object.keys(route).filter((k) => /^[A-Z]+$/.test(k));
    expect(handlers).toEqual(['GET']);
  });

  it('imports only read functions from the store clients', () => {
    const source = readFileSync(join(__dirname, '../route.ts'), 'utf8');
    const imported = [
      ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/lib\/(?:google-play|apple-connect)[^']*'/g),
    ]
      .flatMap((match) => match[1].split(','))
      .map((name) => name.trim().split(/\s+as\s+/)[0])
      .filter(Boolean)
      .sort();
    expect(imported).toEqual([
      'APP_MISMATCH',
      'assertSubscriptionInApp',
      'getBaseTerritoryForProduct',
      'getInAppProductRaw',
      'getInAppPurchase',
      'getInAppPurchasePrices',
      'getSubscription',
      'getSubscription',
      'getSubscriptionById',
      'getSubscriptionPrices',
    ]);
  });

  it('rejects invalid queries', async () => {
    const res = await route.GET(request('platform=google&type=subscription&id=premium'));
    expect(res.status).toBe(400);
    const res2 = await route.GET(request('platform=steam&type=inapp&id=x'));
    expect(res2.status).toBe(400);
    const res3 = await route.GET(request('platform=google&type=inapp&id=bad%20id'));
    expect(res3.status).toBe(400);
  });

  it('returns 401 without a session', async () => {
    mocks.getAuthFromCookies.mockResolvedValue(null);
    const res = await route.GET(request('platform=google&type=inapp&id=coins'));
    expect(res.status).toBe(401);
  });

  it('exports a Google one-time product as CSV attachment', async () => {
    mocks.getAuthFromCookies.mockResolvedValue(googleAuth);
    mocks.getInAppProductRaw.mockResolvedValue({
      productId: 'coins',
      purchaseOptions: [
        {
          purchaseOptionId: 'default',
          regionalPricingAndAvailabilityConfigs: [
            { regionCode: 'US', price: { currencyCode: 'USD', units: '4', nanos: 990000000 }, availability: 'AVAILABLE' },
          ],
        },
      ],
    });

    const res = await route.GET(request('platform=google&type=inapp&id=coins&format=csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="prices-google-inapp-coins-\d{8}T\d{6}Z\.csv"$/
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain(',US,USD,4.99,,AVAILABLE,');
  });

  it('maps a Google 404 to 404', async () => {
    mocks.getAuthFromCookies.mockResolvedValue(googleAuth);
    mocks.getInAppProductRaw.mockRejectedValue({ code: 404 });
    const res = await route.GET(request('platform=google&type=inapp&id=missing'));
    expect(res.status).toBe(404);
  });

  it('exports a Google base plan as JSON', async () => {
    mocks.getAuthFromCookies.mockResolvedValue(googleAuth);
    mocks.getGoogleSubscription.mockResolvedValue({
      productId: 'premium',
      basePlans: [
        {
          basePlanId: 'monthly',
          state: 'active',
          regionalConfigs: [{ regionCode: 'US', price: { currencyCode: 'USD', units: '9', nanos: 990000000 } }],
        },
      ],
    });

    const res = await route.GET(request('platform=google&type=subscription&id=premium&basePlanId=monthly'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.schemaVersion).toBe(1);
    expect(json.product).toEqual({ type: 'subscription', id: 'premium', basePlanId: 'monthly' });
    expect(json.prices).toEqual([{ territory: 'US', currency: 'USD', amount: '9.99' }]);

    const missing = await route.GET(request('platform=google&type=subscription&id=premium&basePlanId=yearly'));
    expect(missing.status).toBe(404);
  });

  it('exports an Apple IAP and refuses empty price reads', async () => {
    mocks.getAppleAuthFromCookies.mockResolvedValue(appleAuth);
    mocks.getInAppPurchase.mockResolvedValue({ id: '123', productId: 'com.example.app.coins', prices: {} });
    mocks.getBaseTerritoryForProduct.mockResolvedValue('USA');
    mocks.getInAppPurchasePrices.mockResolvedValue({
      USA: { territoryCode: 'USA', currency: 'USD', customerPrice: '0.99', proceeds: '0.84', pricePointId: 'p' },
    });

    const res = await route.GET(request('platform=apple&type=inapp&id=com.example.app.coins'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.app).toEqual({ bundleId: 'com.example.app' });
    expect(json.product.baseTerritory).toBe('US');
    expect(json.prices).toEqual([{ territory: 'US', currency: 'USD', amount: '0.99', proceeds: '0.84' }]);

    mocks.getInAppPurchasePrices.mockResolvedValue({});
    const empty = await route.GET(request('platform=apple&type=inapp&id=com.example.app.coins'));
    expect(empty.status).toBe(502);
  });

  it('fails the export when the base territory lookup resolves to null', async () => {
    mocks.getAppleAuthFromCookies.mockResolvedValue(appleAuth);
    mocks.getInAppPurchase.mockResolvedValue({ id: '123', productId: 'com.example.app.coins', prices: {} });
    mocks.getBaseTerritoryForProduct.mockResolvedValue(null);
    mocks.getInAppPurchasePrices.mockResolvedValue({
      USA: { territoryCode: 'USA', currency: 'USD', customerPrice: '0.99', proceeds: '0.84', pricePointId: 'p' },
    });

    const res = await route.GET(request('platform=apple&type=inapp&id=com.example.app.coins'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/base territory/);
  });

  it.each([
    [500, 502],
    [503, 502],
    [404, 502],
    [401, 401],
    [403, 403],
    [429, 429],
  ])('fails the whole export with a clear error when the base territory lookup throws %i', async (thrown, expected) => {
    mocks.getAppleAuthFromCookies.mockResolvedValue(appleAuth);
    mocks.getInAppPurchase.mockResolvedValue({ id: '123', productId: 'com.example.app.coins', prices: {} });
    mocks.getBaseTerritoryForProduct.mockRejectedValue(
      Object.assign(new Error('Apple failed'), { status: thrown })
    );
    mocks.getInAppPurchasePrices.mockResolvedValue({
      USA: { territoryCode: 'USA', currency: 'USD', customerPrice: '0.99', proceeds: '0.84', pricePointId: 'p' },
    });

    const res = await route.GET(request('platform=apple&type=inapp&id=com.example.app.coins'));
    expect(res.status).toBe(expected);
    const json = await res.json();
    expect(json.error).toBe(
      'Could not read the base territory for this product from App Store Connect. Nothing was exported.'
    );
  });

  it('exports an Apple subscription by numeric id with scheduled prices', async () => {
    mocks.getAppleAuthFromCookies.mockResolvedValue(appleAuth);
    mocks.getAppleSubscriptionById.mockResolvedValue({ id: '6700000000', productId: 'com.example.app.pro' });
    mocks.getAppleSubscriptionPrices.mockResolvedValue({
      current: { US: { territoryCode: 'US', currency: 'USD', customerPrice: '9.99', proceeds: '8.49', pricePointId: 'a' } },
      scheduled: {
        US: { territoryCode: 'US', currency: 'USD', customerPrice: '12.99', proceeds: '11.04', pricePointId: 'b', startDate: '2026-03-01' },
      },
    });

    const res = await route.GET(request('platform=apple&type=subscription&id=6700000000&format=csv'));
    expect(res.status).toBe(200);
    expect(mocks.getAppleSubscription).not.toHaveBeenCalled();
    const body = await res.text();
    expect(body).toContain(',US,USD,9.99,8.49,,12.99,2026-03-01,11.04');
  });

  it("refuses to export another app's subscription by numeric id (it would carry this app's bundle ID)", async () => {
    mocks.getAppleAuthFromCookies.mockResolvedValue(appleAuth);
    assertSubscriptionInApp.mockRejectedValue(Object.assign(new Error('not in app'), { status: 409, code: 'APP_MISMATCH' }));
    const res = await route.GET(request('platform=apple&type=subscription&id=6700000001'));
    expect(res.status).toBe(409);
    expect(mocks.getAppleSubscriptionById).not.toHaveBeenCalled();
    expect(mocks.getAppleSubscriptionPrices).not.toHaveBeenCalled();
  });

  it('returns 502 when a store amount is not an exact decimal', async () => {
    mocks.getAppleAuthFromCookies.mockResolvedValue(appleAuth);
    mocks.getAppleSubscription.mockResolvedValue({ id: '1', productId: 'com.example.app.pro' });
    mocks.getAppleSubscriptionPrices.mockResolvedValue({
      current: { US: { territoryCode: 'US', currency: 'USD', customerPrice: '9.99e0', proceeds: '8', pricePointId: 'a' } },
      scheduled: {},
    });
    const res = await route.GET(request('platform=apple&type=subscription&id=com.example.app.pro'));
    expect(res.status).toBe(502);
  });

  describe('Apple read failures', () => {
    // Same shape as the shared ApiError: a numeric `status` on an Error.
    class StoreError extends Error {
      constructor(message: string, public status: number) {
        super(message);
      }
    }

    beforeEach(() => {
      mocks.getAppleAuthFromCookies.mockResolvedValue(appleAuth);
      mocks.getInAppPurchase.mockResolvedValue({ id: '123', productId: 'com.example.app.coins' });
      mocks.getBaseTerritoryForProduct.mockResolvedValue('USA');
      mocks.getAppleSubscription.mockResolvedValue({ id: '1', productId: 'com.example.app.pro' });
    });

    it.each([401, 403, 404, 429, 503])('maps a thrown %i to the same status', async (status) => {
      mocks.getInAppPurchasePrices.mockRejectedValue(new StoreError('boom', status));
      const iap = await route.GET(request('platform=apple&type=inapp&id=com.example.app.coins'));
      expect(iap.status).toBe(status);
      expect(await iap.json()).toEqual({ error: 'Failed to export prices' });

      mocks.getAppleSubscriptionPrices.mockRejectedValue(new StoreError('boom', status));
      const sub = await route.GET(request('platform=apple&type=subscription&id=com.example.app.pro'));
      expect(sub.status).toBe(status);
    });

    it('maps a thrown lookup error and an AppleApiError statusCode', async () => {
      mocks.getAppleSubscription.mockRejectedValue(new StoreError('rate limited', 429));
      const sub = await route.GET(request('platform=apple&type=subscription&id=com.example.app.pro'));
      expect(sub.status).toBe(429);

      mocks.getInAppPurchase.mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }));
      const iap = await route.GET(request('platform=apple&type=inapp&id=com.example.app.coins'));
      expect(iap.status).toBe(403);
    });

    it('returns 500 for errors without a status', async () => {
      mocks.getAppleSubscriptionPrices.mockRejectedValue(new Error('network down'));
      const res = await route.GET(request('platform=apple&type=subscription&id=com.example.app.pro'));
      expect(res.status).toBe(500);
    });

    it('still refuses an empty subscription price read', async () => {
      mocks.getAppleSubscriptionPrices.mockResolvedValue({ current: {}, scheduled: {} });
      const res = await route.GET(request('platform=apple&type=subscription&id=com.example.app.pro'));
      expect(res.status).toBe(502);
    });
  });
});
