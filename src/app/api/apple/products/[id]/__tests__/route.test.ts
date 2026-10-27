import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ApiError } from '@/lib/utils/api-error';

// No network: auth and every Apple call are mocked
vi.mock('@/middleware/auth', () => ({
  getAppleAuthFromCookies: vi.fn(async () => ({
    credentials: {
      privateKey: 'unused',
      keyId: 'TESTKEY123',
      issuerId: '00000000-0000-0000-0000-000000000000',
      bundleId: 'com.example.test',
    },
    bundleId: 'com.example.test',
  })),
}));

const getInAppPurchase = vi.fn();
const getInAppPurchasePrices = vi.fn();
const getBaseTerritoryForProduct = vi.fn();
const replaceInAppPurchaseManualPrices = vi.fn();
const resolvePPPPricesToPricePoints = vi.fn();
const updateInAppPurchasePrices = vi.fn();
vi.mock('@/lib/apple-connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect')>();
  return {
    ...actual,
    getInAppPurchase: (...args: unknown[]) => getInAppPurchase(...args),
    getInAppPurchasePrices: (...args: unknown[]) => getInAppPurchasePrices(...args),
    getBaseTerritoryForProduct: (...args: unknown[]) => getBaseTerritoryForProduct(...args),
    replaceInAppPurchaseManualPrices: (...args: unknown[]) => replaceInAppPurchaseManualPrices(...args),
    resolvePPPPricesToPricePoints: (...args: unknown[]) => resolvePPPPricesToPricePoints(...args),
    updateInAppPurchasePrices: (...args: unknown[]) => updateInAppPurchasePrices(...args),
  };
});

import { GET, PATCH } from '../route';

const params = () => ({ params: Promise.resolve({ id: 'coins_100' }) });
const product = { id: 'iap-1', productId: 'coins_100', name: 'Coins', prices: {} };

function appleFailure(status: number) {
  return new ApiError(`Apple returned ${status}`, { status, platform: 'apple' });
}

beforeEach(() => {
  getInAppPurchase.mockReset();
  getInAppPurchasePrices.mockReset();
  getBaseTerritoryForProduct.mockReset();
  replaceInAppPurchaseManualPrices.mockReset();
  resolvePPPPricesToPricePoints.mockReset();
  updateInAppPurchasePrices.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/apple/products/[id]', () => {
  it.each([401, 403, 429, 503])('maps a %i read failure to its status', async (status) => {
    getInAppPurchase.mockRejectedValue(appleFailure(status));

    const response = await GET(new NextRequest('http://localhost/x'), params());

    expect(response.status).toBe(status);
    const { error } = await response.json();
    if (status === 401) expect(error).toBe('Session expired. Please reconnect.');
    if (status === 403) expect(error).toMatch(/Access denied/);
  });

  it('returns 404 only when the product genuinely does not exist', async () => {
    getInAppPurchase.mockResolvedValue(null);

    const response = await GET(new NextRequest('http://localhost/x'), params());

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Product not found');
  });

  it('fails instead of returning empty prices when the price read fails', async () => {
    getInAppPurchase.mockResolvedValue({ ...product });
    getInAppPurchasePrices.mockRejectedValue(appleFailure(500));
    getBaseTerritoryForProduct.mockResolvedValue('USA');

    const response = await GET(new NextRequest('http://localhost/x'), params());

    expect(response.status).toBe(500);
  });

  it('fails instead of guessing USA when the base territory read fails', async () => {
    getInAppPurchase.mockResolvedValue({ ...product });
    getInAppPurchasePrices.mockResolvedValue({});
    getBaseTerritoryForProduct.mockRejectedValue(appleFailure(503));

    const response = await GET(new NextRequest('http://localhost/x'), params());

    expect(response.status).toBe(503);
  });
});

describe('PATCH /api/apple/products/[id]', () => {
  it('reports a completed write with refreshError when the reload fails', async () => {
    getInAppPurchase
      .mockResolvedValueOnce({ ...product })
      .mockRejectedValueOnce(appleFailure(503));
    getBaseTerritoryForProduct.mockResolvedValue('USA');
    replaceInAppPurchaseManualPrices.mockResolvedValue({ sent: 1, kept: 0, keptScheduled: [] });

    const response = await PATCH(
      new NextRequest('http://localhost/x', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices: { USA: { pricePointId: 'pp-usa' } } }),
      }),
      params()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.updated).toBe(1);
    expect(body.product).toBeNull();
    expect(body.refreshError).toBe('Apple returned 503');
  });

  function patch(prices: Record<string, unknown>) {
    return PATCH(
      new NextRequest('http://localhost/x', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices }),
      }),
      params()
    );
  }

  it("writes nothing for a product that isn't in the session app (looked up by SKU in that app only)", async () => {
    getInAppPurchase.mockResolvedValue(null);
    const response = await patch({ GB: { pricePointId: 'pp-gb' } });
    expect(response.status).toBe(404);
    expect(replaceInAppPurchaseManualPrices).not.toHaveBeenCalled();
    expect(updateInAppPurchasePrices).not.toHaveBeenCalled();
  });

  it('sends every territory in one schedule, not one schedule per territory', async () => {
    getInAppPurchase.mockResolvedValue({ ...product });
    getInAppPurchasePrices.mockResolvedValue({});
    getBaseTerritoryForProduct.mockResolvedValue('GBR');
    replaceInAppPurchaseManualPrices.mockResolvedValue({ sent: 2, kept: 5, keptScheduled: [{ territoryId: 'GBR', startDate: '2099-01-01' }] });

    const response = await patch({ GB: { pricePointId: 'pp-gb' }, FR: { pricePointId: 'pp-fr', startDate: '2099-01-01' } });
    expect(response.status).toBe(200);
    expect(replaceInAppPurchaseManualPrices).toHaveBeenCalledTimes(1);
    const [, iapId, changes, base] = replaceInAppPurchaseManualPrices.mock.calls[0];
    expect(iapId).toBe('iap-1');
    expect(changes).toEqual({ GB: { pricePointId: 'pp-gb' }, FR: { pricePointId: 'pp-fr', startDate: '2099-01-01' } });
    expect(base).toBe('GBR');
    const body = await response.json();
    expect(body.updated).toBe(2);
    expect(body.keptScheduled).toEqual([{ territoryId: 'GBR', startDate: '2099-01-01' }]);
  });

  it('refuses several territories for a product without a schedule (no base territory to keep)', async () => {
    getInAppPurchase.mockResolvedValue({ ...product });
    getBaseTerritoryForProduct.mockResolvedValue(null);
    const response = await patch({ GB: { pricePointId: 'pp-gb' }, FR: { pricePointId: 'pp-fr' } });
    expect(response.status).toBe(422);
    expect(replaceInAppPurchaseManualPrices).not.toHaveBeenCalled();
  });

  it('calculated (PPP) prices go through the same merge, so untouched territories keep their prices', async () => {
    getInAppPurchase.mockResolvedValue({ ...product });
    getInAppPurchasePrices.mockResolvedValue({});
    getBaseTerritoryForProduct.mockResolvedValue('USA');
    resolvePPPPricesToPricePoints.mockResolvedValue({
      resolved: [
        { territoryId: 'USA', pricePointId: 'pp-usa' },
        { territoryId: 'GBR', pricePointId: 'pp-gbr' },
      ],
      skipped: ['FRA: no cached tier data for EUR'],
    });
    replaceInAppPurchaseManualPrices.mockResolvedValue({ sent: 2, kept: 3, keptScheduled: [] });

    const response = await patch({
      USA: { currencyCode: 'USD', units: '4', nanos: 990000000 },
      GBR: { currencyCode: 'GBP', units: '3', nanos: 990000000 },
      FRA: { currencyCode: 'EUR', units: '4', nanos: 490000000 },
    });
    expect(response.status).toBe(200);
    expect(updateInAppPurchasePrices).not.toHaveBeenCalled();
    expect(replaceInAppPurchaseManualPrices).toHaveBeenCalledTimes(1);
    const [, , changes, base] = replaceInAppPurchaseManualPrices.mock.calls[0];
    expect(changes).toEqual({ USA: { pricePointId: 'pp-usa' }, GBR: { pricePointId: 'pp-gbr' } });
    expect(base).toBe('USA');
    const body = await response.json();
    expect(body.updated).toBe(2);
    expect(body.skipped).toEqual(['FRA: no cached tier data for EUR']);
  });

  it('refuses calculated prices when the base territory could not be resolved', async () => {
    getInAppPurchase.mockResolvedValue({ ...product });
    getBaseTerritoryForProduct.mockResolvedValue('USA');
    resolvePPPPricesToPricePoints.mockResolvedValue({ resolved: [{ territoryId: 'GBR', pricePointId: 'pp-gbr' }], skipped: ['USA: none'] });
    const response = await patch({
      USA: { currencyCode: 'USD', units: '4' },
      GBR: { currencyCode: 'GBP', units: '3' },
    });
    expect(response.status).toBe(422);
    expect(replaceInAppPurchaseManualPrices).not.toHaveBeenCalled();
  });

  it('uses a single immediate price as the base of a new schedule', async () => {
    getInAppPurchase.mockResolvedValue({ ...product });
    getInAppPurchasePrices.mockResolvedValue({});
    getBaseTerritoryForProduct.mockResolvedValue(null);
    replaceInAppPurchaseManualPrices.mockResolvedValue({ sent: 1, kept: 0, keptScheduled: [] });
    await patch({ GB: { pricePointId: 'pp-gb' } });
    expect(replaceInAppPurchaseManualPrices.mock.calls[0][3]).toBe('GBR');
  });
});
