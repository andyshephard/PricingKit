import { describe, it, expect } from 'vitest';
import type { BasePlan } from '@/lib/google-play/types';
import type { AppleProductPrice } from '@/lib/apple-connect/types';
import {
  appleInAppPurchaseToExport,
  appleSubscriptionToExport,
  googleBasePlanToExport,
  googleOneTimeProductToExport,
  toAlpha2,
} from '../transform';
import { InvalidAmountError } from '../decimal';
import { PRICE_EXPORT_SCHEMA_VERSION, type PriceExport } from '../types';

const EXPORTED_AT = '2026-01-15T10:30:00.000Z';

function applePrice(overrides: Partial<AppleProductPrice>): AppleProductPrice {
  return {
    territoryCode: 'USA',
    currency: 'USD',
    customerPrice: '0.99',
    proceeds: '0.84',
    pricePointId: 'pp',
    ...overrides,
  };
}

function expectNoFloatAmounts(data: PriceExport) {
  for (const price of data.prices) {
    expect(price.amount === null || typeof price.amount === 'string').toBe(true);
    if (price.proceeds !== undefined) expect(typeof price.proceeds).toBe('string');
    for (const s of price.scheduled ?? []) {
      expect(typeof s.amount).toBe('string');
    }
  }
}

describe('toAlpha2', () => {
  it('maps Apple alpha-3 codes to alpha-2', () => {
    expect(toAlpha2('USA')).toBe('US');
    expect(toAlpha2('gbr')).toBe('GB');
  });

  it('passes alpha-2 codes through upper-cased', () => {
    expect(toAlpha2('de')).toBe('DE');
  });
});

describe('googleOneTimeProductToExport', () => {
  it('produces the canonical shape from the first purchase option', () => {
    const result = googleOneTimeProductToExport(
      'com.example.app',
      {
        productId: 'coins_100',
        purchaseOptions: [
          {
            purchaseOptionId: 'default',
            regionalPricingAndAvailabilityConfigs: [
              { regionCode: 'US', price: { currencyCode: 'USD', units: '4', nanos: 990000000 }, availability: 'AVAILABLE' },
              { regionCode: 'JP', price: { currencyCode: 'JPY', units: '800' }, availability: 'AVAILABLE' },
              { regionCode: 'DE', price: { currencyCode: 'EUR', units: '0', nanos: 10000000 }, availability: 'NO_LONGER_AVAILABLE' },
              { regionCode: 'FR' }, // no price: skipped
            ],
          },
          {
            purchaseOptionId: 'other',
            regionalPricingAndAvailabilityConfigs: [
              { regionCode: 'GB', price: { currencyCode: 'GBP', units: '9' } },
            ],
          },
        ],
      },
      { exportedAt: EXPORTED_AT }
    );

    expect(result).toEqual({
      schemaVersion: 1,
      exportedAt: EXPORTED_AT,
      platform: 'google',
      app: { packageName: 'com.example.app' },
      product: { type: 'inapp', id: 'coins_100', purchaseOptionId: 'default' },
      prices: [
        { territory: 'DE', currency: 'EUR', amount: '0.01', availability: 'NO_LONGER_AVAILABLE' },
        { territory: 'JP', currency: 'JPY', amount: '800', availability: 'AVAILABLE' },
        { territory: 'US', currency: 'USD', amount: '4.99', availability: 'AVAILABLE' },
      ],
    });
    expectNoFloatAmounts(result);
  });

  it('handles a product with no purchase options', () => {
    const result = googleOneTimeProductToExport('com.example.app', { productId: 'x' }, { exportedAt: EXPORTED_AT });
    expect(result.prices).toEqual([]);
    expect(result.product).toEqual({ type: 'inapp', id: 'x' });
  });

  it('defaults exportedAt to an ISO timestamp', () => {
    const result = googleOneTimeProductToExport('com.example.app', { productId: 'x' });
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.schemaVersion).toBe(PRICE_EXPORT_SCHEMA_VERSION);
  });
});

describe('googleBasePlanToExport', () => {
  const basePlan: BasePlan = {
    basePlanId: 'monthly',
    state: 'active',
    regionalConfigs: [
      { regionCode: 'US', price: { currencyCode: 'USD', units: '9', nanos: 990000000 }, newSubscriberAvailability: true },
      { regionCode: 'IN', price: { currencyCode: 'INR', units: '199' }, newSubscriberAvailability: false },
      { regionCode: 'BR', price: { currencyCode: 'BRL', units: '14', nanos: 900000000 } },
    ],
    otherRegionsConfig: {
      usdPrice: { currencyCode: 'USD', units: '9', nanos: 990000000 },
      eurPrice: { currencyCode: 'EUR', units: '8', nanos: 990000000 },
      newSubscriberAvailability: true,
    },
  };

  it('produces the canonical shape with base plan id and availability', () => {
    const result = googleBasePlanToExport('com.example.app', 'premium', basePlan, { exportedAt: EXPORTED_AT });
    expect(result).toEqual({
      schemaVersion: 1,
      exportedAt: EXPORTED_AT,
      platform: 'google',
      app: { packageName: 'com.example.app' },
      product: { type: 'subscription', id: 'premium', basePlanId: 'monthly' },
      prices: [
        { territory: 'BR', currency: 'BRL', amount: '14.9' },
        { territory: 'IN', currency: 'INR', amount: '199', availability: 'NO_NEW_SUBSCRIBERS' },
        { territory: 'US', currency: 'USD', amount: '9.99', availability: 'AVAILABLE' },
      ],
      otherRegions: { usdAmount: '9.99', eurAmount: '8.99', availability: 'AVAILABLE' },
    });
    expectNoFloatAmounts(result);
  });

  it('omits otherRegions when not configured', () => {
    const result = googleBasePlanToExport(
      'com.example.app',
      'premium',
      { ...basePlan, otherRegionsConfig: undefined },
      { exportedAt: EXPORTED_AT }
    );
    expect(result).not.toHaveProperty('otherRegions');
  });

  it('throws on malformed money rather than exporting a wrong amount', () => {
    expect(() =>
      googleBasePlanToExport(
        'com.example.app',
        'premium',
        { ...basePlan, regionalConfigs: [{ regionCode: 'US', price: { currencyCode: 'USD', units: '9.99' } }] },
        { exportedAt: EXPORTED_AT }
      )
    ).toThrow(InvalidAmountError);
  });
});

describe('appleInAppPurchaseToExport', () => {
  it('normalizes alpha-3 territories, decimals and base territory', () => {
    const result = appleInAppPurchaseToExport(
      'com.example.app',
      {
        id: '1234567890',
        productId: 'com.example.app.coins',
        baseTerritory: 'GBR',
        prices: {
          USA: applePrice({ territoryCode: 'USA', currency: 'USD', customerPrice: '0.99', proceeds: '0.84' }),
          GBR: applePrice({ territoryCode: 'GBR', currency: 'GBP', customerPrice: '0.990', proceeds: '0.70' }),
          JPN: applePrice({ territoryCode: 'JPN', currency: 'JPY', customerPrice: '160.0', proceeds: '136' }),
        },
      },
      { exportedAt: EXPORTED_AT }
    );

    expect(result).toEqual({
      schemaVersion: 1,
      exportedAt: EXPORTED_AT,
      platform: 'apple',
      app: { bundleId: 'com.example.app' },
      product: { type: 'inapp', id: 'com.example.app.coins', storeId: '1234567890', baseTerritory: 'GB' },
      prices: [
        { territory: 'GB', currency: 'GBP', amount: '0.99', proceeds: '0.7' },
        { territory: 'JP', currency: 'JPY', amount: '160', proceeds: '136' },
        { territory: 'US', currency: 'USD', amount: '0.99', proceeds: '0.84' },
      ],
    });
    expectNoFloatAmounts(result);
  });

  it('throws on a non-decimal customer price', () => {
    expect(() =>
      appleInAppPurchaseToExport(
        'com.example.app',
        { id: '1', productId: 'p', prices: { USA: applePrice({ customerPrice: '$0.99' }) } },
        { exportedAt: EXPORTED_AT }
      )
    ).toThrow(InvalidAmountError);
  });
});

describe('appleSubscriptionToExport', () => {
  it('attaches scheduled prices to their territory', () => {
    const result = appleSubscriptionToExport(
      'com.example.app',
      {
        id: '6700000000',
        productId: 'com.example.app.pro.monthly',
        prices: {
          US: applePrice({ territoryCode: 'US', currency: 'USD', customerPrice: '9.99', proceeds: '8.49' }),
          DE: applePrice({ territoryCode: 'DE', currency: 'EUR', customerPrice: '9.99', proceeds: '7.14' }),
        },
        scheduledPrices: {
          US: applePrice({
            territoryCode: 'US',
            currency: 'USD',
            customerPrice: '12.99',
            proceeds: '11.04',
            startDate: '2026-03-01',
          }),
        },
      },
      { exportedAt: EXPORTED_AT }
    );

    expect(result.product).toEqual({
      type: 'subscription',
      id: 'com.example.app.pro.monthly',
      storeId: '6700000000',
    });
    expect(result.prices).toEqual([
      { territory: 'DE', currency: 'EUR', amount: '9.99', proceeds: '7.14' },
      {
        territory: 'US',
        currency: 'USD',
        amount: '9.99',
        proceeds: '8.49',
        scheduled: [{ amount: '12.99', startDate: '2026-03-01', proceeds: '11.04' }],
      },
    ]);
    expectNoFloatAmounts(result);
  });

  it('keeps scheduled-only territories with a null current amount', () => {
    const result = appleSubscriptionToExport(
      'com.example.app',
      {
        id: '1',
        productId: 'p',
        prices: {},
        scheduledPrices: {
          FR: applePrice({ territoryCode: 'FR', currency: 'EUR', customerPrice: '4.99', proceeds: '3.5', startDate: '2026-05-01' }),
        },
      },
      { exportedAt: EXPORTED_AT }
    );
    expect(result.prices).toEqual([
      {
        territory: 'FR',
        currency: 'EUR',
        amount: null,
        scheduled: [{ amount: '4.99', startDate: '2026-05-01', proceeds: '3.5' }],
      },
    ]);
  });

  it('ignores scheduled entries without a start date', () => {
    const result = appleSubscriptionToExport(
      'com.example.app',
      {
        id: '1',
        productId: 'p',
        prices: { US: applePrice({ territoryCode: 'US' }) },
        scheduledPrices: { US: applePrice({ territoryCode: 'US', customerPrice: '1.99' }) },
      },
      { exportedAt: EXPORTED_AT }
    );
    expect(result.prices[0].scheduled).toBeUndefined();
  });
});
