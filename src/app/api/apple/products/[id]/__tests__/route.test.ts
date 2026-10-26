import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ApiError } from '@/lib/utils/api-error';

// No network: auth and every Apple call are mocked
vi.mock('../../../auth/route', () => ({
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
const updateInAppPurchasePrice = vi.fn();
vi.mock('@/lib/apple-connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect')>();
  return {
    ...actual,
    getInAppPurchase: (...args: unknown[]) => getInAppPurchase(...args),
    getInAppPurchasePrices: (...args: unknown[]) => getInAppPurchasePrices(...args),
    getBaseTerritoryForProduct: (...args: unknown[]) => getBaseTerritoryForProduct(...args),
    updateInAppPurchasePrice: (...args: unknown[]) => updateInAppPurchasePrice(...args),
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
  updateInAppPurchasePrice.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/apple/products/[id]', () => {
  it.each([401, 403, 429, 503])('maps a %i read failure to its status', async (status) => {
    getInAppPurchase.mockRejectedValue(appleFailure(status));

    const response = await GET(new NextRequest('http://localhost/x'), params());

    expect(response.status).toBe(status);
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
    updateInAppPurchasePrice.mockResolvedValue(undefined);

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
});
