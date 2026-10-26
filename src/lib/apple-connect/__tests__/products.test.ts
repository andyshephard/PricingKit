import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '../types';
import { ApiError } from '@/lib/utils/api-error';

// No network: every Apple call goes through this mock
const appleApiRequest = vi.fn();
vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return {
    ...actual,
    appleApiRequest: (...args: unknown[]) => appleApiRequest(...args),
  };
});

import { updateInAppPurchasePrices } from '../products';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.test',
};

beforeEach(() => {
  appleApiRequest.mockReset();
  appleApiRequest.mockResolvedValue({});
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
