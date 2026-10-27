// Invented products and prices for plan / executor tests. Not real store data.
import type { ProductPriceState, ProductRef, TerritoryPriceState } from '../../model';

export const APPLE_APP = { bundleId: 'com.example.app' };
export const GOOGLE_APP = { packageName: 'com.example.app' };

export const APPLE_SUB: ProductRef = {
  platform: 'apple',
  type: 'subscription',
  id: '9000000001',
  productId: 'com.example.app.pro.annual',
};

export const GOOGLE_PLAN: ProductRef = {
  platform: 'google',
  type: 'subscription',
  productId: 'pro',
  basePlanId: 'annual',
};

export function territory(
  code: string,
  currency: string,
  amount: string | null,
  extra: Partial<TerritoryPriceState> & { pricePointId?: string } = {}
): TerritoryPriceState {
  const { pricePointId, ...rest } = extra;
  return {
    territory: code,
    currency,
    current: amount === null ? null : { currency, amount, ...(pricePointId ? { pricePointId } : {}) },
    ...rest,
  };
}

export function appleState(): ProductPriceState {
  return {
    product: APPLE_SUB,
    capturedAt: '2030-01-01T00:00:00.000Z',
    territories: {
      US: territory('US', 'USD', '29.99', { pricePointId: 'pp-us-2999' }),
      GB: territory('GB', 'GBP', '24.99', { pricePointId: 'pp-gb-2499' }),
      DE: territory('DE', 'EUR', '27.99', {
        pricePointId: 'pp-de-2799',
        scheduled: { currency: 'EUR', amount: '29.99', pricePointId: 'pp-de-2999', startDate: '2030-06-01' },
      }),
    },
  };
}

export function googleState(): ProductPriceState {
  return {
    product: GOOGLE_PLAN,
    capturedAt: '2030-01-01T00:00:00.000Z',
    territories: {
      US: territory('US', 'USD', '29.99'),
      GB: territory('GB', 'GBP', '24.99'),
      JP: territory('JP', 'JPY', '3900'),
    },
  };
}
