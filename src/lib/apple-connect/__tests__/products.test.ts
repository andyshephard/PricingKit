import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '../types';
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
  updateInAppPurchasePrices,
  getInAppPurchase,
  getBaseTerritoryForProduct,
  getInAppPurchasePrices,
  getAvailablePricePoints,
} from '../products';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.test',
};

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
      credentials,
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
        credentials,
        'iap-1',
        [{ territoryId: 'MCO', pricePointId: 'pp-mco' }],
        'MCO'
      )
    ).rejects.toMatchObject({ status: 422, code: 'UNSUPPORTED_BASE_TERRITORY' });
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('sends the schedule when the base territory price is present', async () => {
    await updateInAppPurchasePrices(
      credentials,
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

    const promise = getInAppPurchase(credentials, 'coins_100');
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 500 });
  });

  it('returns null for a genuine 404 or an empty result', async () => {
    appleApiRequest.mockRejectedValueOnce(appleFailure(404));
    await expect(getInAppPurchase(credentials, 'coins_100')).resolves.toBeNull();

    appleApiRequest.mockResolvedValueOnce({ data: [] });
    await expect(getInAppPurchase(credentials, 'coins_100')).resolves.toBeNull();
  });

  it('throws APP_NOT_FOUND when the bundle ID has no app', async () => {
    getAppIdForBundleId.mockResolvedValue(null);

    await expect(getInAppPurchase(credentials, 'coins_100')).rejects.toMatchObject({
      status: 404,
      code: 'APP_NOT_FOUND',
    });
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('propagates an app lookup failure', async () => {
    getAppIdForBundleId.mockRejectedValue(appleFailure(401));

    await expect(getInAppPurchase(credentials, 'coins_100')).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('getBaseTerritoryForProduct', () => {
  it('returns the base territory', async () => {
    appleApiRequest.mockResolvedValue({ data: { id: 'GBR', type: 'territories' } });

    await expect(getBaseTerritoryForProduct(credentials, 'iap-1')).resolves.toBe('GBR');
  });

  it('throws on an API error instead of guessing USA', async () => {
    appleApiRequest.mockRejectedValue(appleFailure(503));

    await expect(getBaseTerritoryForProduct(credentials, 'iap-1')).rejects.toMatchObject({
      status: 503,
    });
  });

  it('returns null when the product has no price schedule', async () => {
    appleApiRequest.mockRejectedValueOnce(appleFailure(404));
    await expect(getBaseTerritoryForProduct(credentials, 'iap-1')).resolves.toBeNull();

    appleApiRequest.mockResolvedValueOnce({ data: null });
    await expect(getBaseTerritoryForProduct(credentials, 'iap-1')).resolves.toBeNull();
  });
});

describe('getInAppPurchasePrices', () => {
  it('rethrows API failures instead of returning no prices', async () => {
    appleApiRequest.mockRejectedValue(appleFailure(429));

    await expect(getInAppPurchasePrices(credentials, 'iap-1')).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
  });

  it('returns no prices when the product has no price schedule (404)', async () => {
    appleApiRequest.mockRejectedValue(appleFailure(404));

    await expect(getInAppPurchasePrices(credentials, 'iap-1')).resolves.toEqual({});
  });
});

describe('getAvailablePricePoints', () => {
  it('rethrows API failures instead of returning no price points', async () => {
    appleApiRequest.mockRejectedValue(appleFailure(500));

    await expect(getAvailablePricePoints(credentials, 'USA')).rejects.toMatchObject({
      status: 500,
    });
  });

  it('throws APP_NOT_FOUND when the bundle ID has no app', async () => {
    getAppIdForBundleId.mockResolvedValue(null);

    await expect(getAvailablePricePoints(credentials, 'USA')).rejects.toMatchObject({
      status: 404,
      code: 'APP_NOT_FOUND',
    });
  });

  it('maps price points', async () => {
    appleApiRequest.mockResolvedValue({
      data: [{ id: 'pp-1', attributes: { customerPrice: '0.99', proceeds: '0.70' } }],
    });

    await expect(getAvailablePricePoints(credentials, 'USA')).resolves.toEqual([
      { id: 'pp-1', customerPrice: '0.99', proceeds: '0.70' },
    ]);
  });
});
