import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '../types';
import { appleKeyConnection } from '../../token-source';
import { ApiError } from '@/lib/utils/api-error';

// No network: every Apple call goes through this mock
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

import {
  listInAppPurchases,
  updateInAppPurchasePrices,
  getInAppPurchase,
  getBaseTerritoryForProduct,
  getInAppPurchasePrices,
  getAvailablePricePoints,
} from '../products';
import { updateAppPriceSchedule } from '../app-price';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.test',
};
const connection = appleKeyConnection(credentials);

function appleFailure(status: number) {
  return new ApiError(`Apple returned ${status}`, { status, platform: 'apple' });
}

beforeEach(() => {
  appleApiRequest.mockReset();
  appleApiRequest.mockResolvedValue({});
  getAppIdForBundleId.mockReset();
  getAppIdForBundleId.mockResolvedValue('app-1');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('updateInAppPurchasePrices', () => {
  it('throws a 4xx ApiError when the base territory price is missing', async () => {
    const promise = updateInAppPurchasePrices(
      connection,
      'iap-1',
      [{ territoryId: 'FRA', pricePointId: 'pp-fra' }],
      'USA'
    );

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({
      status: 422,
      code: 'MISSING_BASE_TERRITORY_PRICE',
    });
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('throws when the base territory is not supported for IAP pricing', async () => {
    await expect(
      updateInAppPurchasePrices(
        connection,
        'iap-1',
        [{ territoryId: 'MCO', pricePointId: 'pp-mco' }],
        'MCO'
      )
    ).rejects.toMatchObject({ status: 422, code: 'UNSUPPORTED_BASE_TERRITORY' });
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('sends the schedule when the base territory price is present', async () => {
    await updateInAppPurchasePrices(
      connection,
      'iap-1',
      [
        { territoryId: 'USA', pricePointId: 'pp-usa' },
        { territoryId: 'FRA', pricePointId: 'pp-fra' },
      ],
      'USA'
    );

    expect(appleApiRequest).toHaveBeenCalledTimes(1);
    const [, endpoint, options] = appleApiRequest.mock.calls[0];
    expect(endpoint).toBe('/inAppPurchasePriceSchedules');
    expect(options.method).toBe('POST');
    expect(options.body.data.relationships.baseTerritory.data.id).toBe('USA');
    expect(options.body.included).toHaveLength(2);
  });
});

describe('getInAppPurchase', () => {
  it('rethrows API failures as ApiError instead of returning null', async () => {
    appleApiRequest.mockRejectedValue(appleFailure(500));

    const promise = getInAppPurchase(connection, 'coins_100');
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 500 });
  });

  it('returns null for a genuine 404 or an empty result', async () => {
    appleApiRequest.mockRejectedValueOnce(appleFailure(404));
    await expect(getInAppPurchase(connection, 'coins_100')).resolves.toBeNull();

    appleApiRequest.mockResolvedValueOnce({ data: [] });
    await expect(getInAppPurchase(connection, 'coins_100')).resolves.toBeNull();
  });

  it('throws APP_NOT_FOUND when the bundle ID has no app', async () => {
    getAppIdForBundleId.mockResolvedValue(null);

    await expect(getInAppPurchase(connection, 'coins_100')).rejects.toMatchObject({
      status: 404,
      code: 'APP_NOT_FOUND',
    });
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('propagates an app lookup failure', async () => {
    getAppIdForBundleId.mockRejectedValue(appleFailure(401));

    await expect(getInAppPurchase(connection, 'coins_100')).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('getBaseTerritoryForProduct', () => {
  it('returns the base territory', async () => {
    appleApiRequest.mockResolvedValue({ data: { id: 'GBR', type: 'territories' } });

    await expect(getBaseTerritoryForProduct(connection, 'iap-1')).resolves.toBe('GBR');
  });

  it('throws on an API error instead of guessing USA', async () => {
    appleApiRequest.mockRejectedValue(appleFailure(503));

    await expect(getBaseTerritoryForProduct(connection, 'iap-1')).rejects.toMatchObject({
      status: 503,
    });
  });

  it('returns null when the product has no price schedule', async () => {
    appleApiRequest.mockRejectedValueOnce(appleFailure(404));
    await expect(getBaseTerritoryForProduct(connection, 'iap-1')).resolves.toBeNull();

    appleApiRequest.mockResolvedValueOnce({ data: null });
    await expect(getBaseTerritoryForProduct(connection, 'iap-1')).resolves.toBeNull();
  });
});

describe('getInAppPurchasePrices', () => {
  it('rethrows API failures instead of returning no prices', async () => {
    appleApiRequest.mockRejectedValue(appleFailure(429));

    await expect(getInAppPurchasePrices(connection, 'iap-1')).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
  });

  it('returns no prices when the product has no price schedule (404)', async () => {
    appleApiRequest.mockRejectedValue(appleFailure(404));

    await expect(getInAppPurchasePrices(connection, 'iap-1')).resolves.toEqual({});
  });
});

describe('getAvailablePricePoints', () => {
  it('rethrows API failures instead of returning no price points', async () => {
    appleApiRequest.mockRejectedValue(appleFailure(500));

    await expect(getAvailablePricePoints(connection, 'USA')).rejects.toMatchObject({
      status: 500,
    });
  });

  it('throws APP_NOT_FOUND when the bundle ID has no app', async () => {
    getAppIdForBundleId.mockResolvedValue(null);

    await expect(getAvailablePricePoints(connection, 'USA')).rejects.toMatchObject({
      status: 404,
      code: 'APP_NOT_FOUND',
    });
  });

  it('maps price points', async () => {
    appleApiRequest.mockResolvedValue({
      data: [{ id: 'pp-1', attributes: { customerPrice: '0.99', proceeds: '0.70' } }],
    });

    await expect(getAvailablePricePoints(connection, 'USA')).resolves.toEqual([
      { id: 'pp-1', customerPrice: '0.99', proceeds: '0.70' },
    ]);
  });
});

describe('listInAppPurchases base prices', () => {
  const listResponse = {
    data: [
      {
        id: 'iap-1',
        type: 'inAppPurchases',
        attributes: { name: 'Coins', productId: 'com.example.coins', inAppPurchaseType: 'CONSUMABLE', state: 'APPROVED' },
        relationships: {},
      },
    ],
    included: [
      {
        id: 'iap-1',
        type: 'inAppPurchasePriceSchedules',
        relationships: { baseTerritory: { data: { id: 'GBR' } } },
      },
    ],
    links: {},
  };

  function mockList(priceResult: () => unknown) {
    appleApiRequest.mockImplementation(async (_creds: unknown, endpoint: string) => {
      if (endpoint.endsWith('/manualPrices')) return priceResult();
      return listResponse;
    });
  }

  it('rethrows a failed base price read instead of listing the product without a price', async () => {
    mockList(() => {
      throw appleFailure(500);
    });

    const promise = listInAppPurchases(connection);
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 500 });
  });

  it('lists the product without a price when the schedule has none (404)', async () => {
    mockList(() => {
      throw appleFailure(404);
    });

    const products = await listInAppPurchases(connection);
    expect(products).toHaveLength(1);
    expect(products[0].baseTerritory).toBeUndefined();
  });

  it('reads the base price from the base territory', async () => {
    mockList(() => ({
      data: [{ id: 'price-1', type: 'inAppPurchasePrices', attributes: {} }],
      included: [
        { id: 'pp-1', type: 'inAppPurchasePricePoints', attributes: { customerPrice: '0.99', proceeds: '0.70' } },
        { id: 'GBR', type: 'territories', attributes: { currency: 'GBP' } },
      ],
    }));

    const products = await listInAppPurchases(connection);
    expect(products[0].baseTerritory).toBe('GBR');
    expect(products[0].prices).toEqual({
      GBR: { territoryCode: 'GBR', currency: 'GBP', customerPrice: '0.99', proceeds: '0.70', pricePointId: 'pp-1' },
    });
  });
});

// API keys reach every app of a team. In-app purchase and app price writes are scoped to the
// session's app by construction: the product is found by SKU in that app's own list, and the
// app price schedule names that app. No client-supplied Apple resource ID is ever written to.
describe('writes are scoped to the session app', () => {
  it("finds an in-app purchase only in the session app's own list", async () => {
    appleApiRequest.mockResolvedValue({ data: [] });
    await expect(getInAppPurchase(connection, 'coins_100')).resolves.toBeNull();
    expect(getAppIdForBundleId).toHaveBeenCalledWith(connection, expect.anything());
    const [, endpoint, options] = appleApiRequest.mock.calls[0];
    expect(endpoint).toBe('/apps/app-1/inAppPurchasesV2');
    expect(options.queryParams['filter[productId]']).toBe('coins_100');
  });

  it("writes the app price schedule for the session app only", async () => {
    await updateAppPriceSchedule(connection, [{ territoryId: 'USA', pricePointId: 'pp-usa' }], 'USA');
    expect(getAppIdForBundleId).toHaveBeenCalledWith(connection);
    const post = appleApiRequest.mock.calls.find(([, , o]) => o?.method === 'POST')!;
    expect(post[2].body.data.relationships.app.data).toEqual({ id: 'app-1', type: 'apps' });
  });
});
