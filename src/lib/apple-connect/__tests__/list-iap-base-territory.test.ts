import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '../types';

const appleApiRequest = vi.fn();
vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return {
    ...actual,
    appleApiRequest: (...args: unknown[]) => appleApiRequest(...args),
    getAppIdForBundleId: vi.fn(async () => '1234567890'),
  };
});

import { listInAppPurchases } from '../products';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.test',
};

beforeEach(() => {
  appleApiRequest.mockReset();
});

describe('listInAppPurchases without a base territory', () => {
  it('skips the price read and flags the product instead of assuming USA', async () => {
    appleApiRequest.mockImplementation(async (_c: unknown, endpoint: string) => {
      if (endpoint.endsWith('/inAppPurchasesV2')) {
        return {
          data: [
            { id: 'iap-1', type: 'inAppPurchases', attributes: { productId: 'com.example.coins', name: 'Coins', inAppPurchaseType: 'CONSUMABLE', state: 'APPROVED' } },
          ],
          // Price schedule present, but no baseTerritory relationship
          included: [{ id: 'iap-1', type: 'inAppPurchasePriceSchedules' }],
        };
      }
      throw new Error(`unexpected request ${endpoint}`);
    });

    const [product] = await listInAppPurchases(credentials);
    expect(product.priceUnavailableReason).toBe('BASE_TERRITORY_UNKNOWN');
    expect(product.prices).toEqual({});
    expect(product.baseTerritory).toBeUndefined();
    expect(appleApiRequest).toHaveBeenCalledTimes(1);
  });
});
