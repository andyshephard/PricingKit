import { beforeEach, describe, expect, it, vi } from 'vitest';
import { googlePlayFetch } from '../client';
import {
  deleteBasePlanRegionPrice,
  updateBasePlanPrices,
} from '../subscriptions';
import type {
  BasePlan,
  ServiceAccountCredentials,
  Subscription,
} from '../types';

vi.mock('../client', () => ({
  googlePlayFetch: vi.fn(),
}));

const credentials = {} as ServiceAccountCredentials;

const existingBasePlan: BasePlan = {
  basePlanId: 'prepaid-1y',
  state: 'active',
  prepaidBasePlanType: {
    billingPeriodDuration: 'P1Y',
    timeExtension: 'timeExtensionActive',
  },
  regionalConfigs: [
    {
      regionCode: 'IN',
      price: { currencyCode: 'INR', units: '300' },
      newSubscriberAvailability: true,
    },
    {
      regionCode: 'DE',
      price: { currencyCode: 'EUR', units: '3' },
      newSubscriberAvailability: false,
    },
    {
      regionCode: 'AR',
      price: { currencyCode: 'USD', units: '3' },
      newSubscriberAvailability: false,
    },
  ],
};

const subscription: Subscription = {
  packageName: 'app.ormika.mobile',
  productId: 'app.ormika.kerala_psc_scert.1y',
  basePlans: [existingBasePlan],
  listings: [],
  regionsVersion: { version: '2025/03' },
};

describe('updateBasePlanPrices', () => {
  beforeEach(() => {
    vi.mocked(googlePlayFetch).mockReset();
  });

  it('updates only requested prices and preserves regional availability', async () => {
    vi.mocked(googlePlayFetch)
      .mockResolvedValueOnce(subscription)
      .mockResolvedValueOnce(subscription);

    await updateBasePlanPrices(
      credentials,
      subscription.packageName,
      subscription.productId,
      existingBasePlan.basePlanId,
      [
        {
          regionCode: 'IN',
          price: { currencyCode: 'INR', units: '298', nanos: 990000000 },
        },
        {
          regionCode: 'DE',
          price: { currencyCode: 'EUR', units: '10', nanos: 990000000 },
        },
      ]
    );

    const [, , requestOptions] = vi.mocked(googlePlayFetch).mock.calls[1];
    const requestBody = requestOptions?.body as {
      basePlans: BasePlan[];
    };
    const configs = requestBody.basePlans[0].regionalConfigs;

    expect(configs).toEqual([
      {
        regionCode: 'IN',
        price: { currencyCode: 'INR', units: '298', nanos: 990000000 },
        newSubscriberAvailability: true,
      },
      {
        regionCode: 'DE',
        price: { currencyCode: 'EUR', units: '10', nanos: 990000000 },
        newSubscriberAvailability: false,
      },
      {
        regionCode: 'AR',
        price: { currencyCode: 'USD', units: '3' },
        newSubscriberAvailability: false,
      },
    ]);
  });

  it('keeps a newly priced region unavailable instead of enabling it', async () => {
    vi.mocked(googlePlayFetch)
      .mockResolvedValueOnce(subscription)
      .mockResolvedValueOnce(subscription);

    await updateBasePlanPrices(
      credentials,
      subscription.packageName,
      subscription.productId,
      existingBasePlan.basePlanId,
      [
        {
          regionCode: 'FR',
          price: { currencyCode: 'EUR', units: '10', nanos: 990000000 },
        },
      ]
    );

    const [, , requestOptions] = vi.mocked(googlePlayFetch).mock.calls[1];
    const requestBody = requestOptions?.body as {
      basePlans: BasePlan[];
    };
    const configs = requestBody.basePlans[0].regionalConfigs;

    expect(configs).toHaveLength(existingBasePlan.regionalConfigs.length + 1);
    expect(configs.find((config) => config.regionCode === 'FR')).toEqual({
      regionCode: 'FR',
      price: { currencyCode: 'EUR', units: '10', nanos: 990000000 },
      newSubscriberAvailability: false,
    });
  });

  it('deletes only the requested regional price without generating replacements', async () => {
    vi.mocked(googlePlayFetch)
      .mockResolvedValueOnce(subscription)
      .mockResolvedValueOnce(subscription);

    await deleteBasePlanRegionPrice(
      credentials,
      subscription.packageName,
      subscription.productId,
      existingBasePlan.basePlanId,
      'DE'
    );

    const [, , requestOptions] = vi.mocked(googlePlayFetch).mock.calls[1];
    const requestBody = requestOptions?.body as {
      basePlans: BasePlan[];
    };
    const configs = requestBody.basePlans[0].regionalConfigs;

    expect(configs).toEqual([
      {
        regionCode: 'IN',
        price: { currencyCode: 'INR', units: '300' },
        newSubscriberAvailability: true,
      },
      {
        regionCode: 'AR',
        price: { currencyCode: 'USD', units: '3' },
        newSubscriberAvailability: false,
      },
    ]);
  });
});
