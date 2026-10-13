import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client', () => ({
  googlePlayFetch: vi.fn(),
}));

import { googlePlayFetch } from '../client';
import { updateBasePlanPrices } from '../subscriptions';
import type { ServiceAccountCredentials, Subscription } from '../types';

const credentials = {} as ServiceAccountCredentials;

const subscription: Subscription = {
  packageName: 'at.persie0.hanziHero',
  productId: 'yearly',
  listings: [],
  basePlans: [
    {
      basePlanId: 'yearly-base',
      state: 'active',
      regionalConfigs: [
        {
          regionCode: 'US',
          newSubscriberAvailability: true,
          price: { currencyCode: 'USD', units: '10' },
        },
        {
          // Legacy configuration from an older Google regions version.
          regionCode: 'AR',
          newSubscriberAvailability: true,
          price: { currencyCode: 'ARS', units: '10000' },
        },
      ],
      autoRenewingBasePlanType: {
        billingPeriodDuration: 'P1Y',
      },
    },
  ],
};

describe('subscription regional price updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the current Google region version and normalizes legacy currencies before PATCH', async () => {
    const fetchMock = vi.mocked(googlePlayFetch);

    fetchMock.mockImplementation(async (_credentials, path, options) => {
      if (path.endsWith('/subscriptions/yearly') && options?.method === 'PATCH') {
        return subscription;
      }

      if (path.endsWith('/subscriptions/yearly')) {
        return structuredClone(subscription);
      }

      if (path.endsWith('/pricing:convertRegionPrices')) {
        return {
          convertedRegionPrices: {
            US: {
              regionCode: 'US',
              price: { currencyCode: 'USD', units: '10' },
            },
            AR: {
              regionCode: 'AR',
              price: { currencyCode: 'USD', units: '9', nanos: 990_000_000 },
            },
          },
          convertedOtherRegionsPrice: {
            usdPrice: { currencyCode: 'USD', units: '10' },
            eurPrice: { currencyCode: 'EUR', units: '9' },
          },
          regionVersion: { version: '2026/09' },
        };
      }

      throw new Error(`Unexpected Google Play request: ${path}`);
    });

    await updateBasePlanPrices(
      credentials,
      'at.persie0.hanziHero',
      'yearly',
      'yearly-base',
      [
        {
          regionCode: 'US',
          price: { currencyCode: 'USD', units: '12' },
          newSubscriberAvailability: true,
        },
      ]
    );

    const convertCall = fetchMock.mock.calls.find(([, path]) =>
      path.endsWith('/pricing:convertRegionPrices')
    );
    expect(convertCall).toBeDefined();

    const patchCall = fetchMock.mock.calls.find(([, , options]) => options?.method === 'PATCH');
    expect(patchCall).toBeDefined();

    const patchOptions = patchCall?.[2];
    expect(patchOptions?.query?.['regionsVersion.version']).toBe('2026/09');

    const body = patchOptions?.body as {
      basePlans?: Array<{
        regionalConfigs?: Array<{
          regionCode: string;
          price: { currencyCode: string; units: string; nanos?: number };
        }>;
      }>;
    };
    const argentina = body.basePlans?.[0]?.regionalConfigs?.find(
      (config) => config.regionCode === 'AR'
    );

    expect(argentina?.price.currencyCode).toBe('USD');
  });

  it('sanitizes untargeted base plans by normalizing legacy currencies and dropping non-billable regions', async () => {
    const multiPlanSubscription: Subscription = {
      ...subscription,
      basePlans: [
        subscription.basePlans![0],
        {
          basePlanId: 'yearly-legacy',
          state: 'active',
          regionalConfigs: [
            {
              regionCode: 'US',
              newSubscriberAvailability: true,
              price: { currencyCode: 'USD', units: '10' },
            },
            {
              regionCode: 'AR',
              newSubscriberAvailability: true,
              price: { currencyCode: 'ARS', units: '5000' },
            },
            {
              regionCode: 'ET',
              newSubscriberAvailability: true,
              price: { currencyCode: 'ETB', units: '200' },
            },
          ],
        },
      ],
    };

    const fetchMock = vi.mocked(googlePlayFetch);

    fetchMock.mockImplementation(async (_credentials, path, options) => {
      if (path.endsWith('/subscriptions/yearly') && options?.method === 'PATCH') {
        return multiPlanSubscription;
      }

      if (path.endsWith('/subscriptions/yearly')) {
        return structuredClone(multiPlanSubscription);
      }

      if (path.endsWith('/pricing:convertRegionPrices')) {
        return {
          convertedRegionPrices: {
            US: {
              regionCode: 'US',
              price: { currencyCode: 'USD', units: '10' },
            },
            AR: {
              regionCode: 'AR',
              price: { currencyCode: 'USD', units: '9', nanos: 990_000_000 },
            },
          },
          convertedOtherRegionsPrice: {
            usdPrice: { currencyCode: 'USD', units: '10' },
            eurPrice: { currencyCode: 'EUR', units: '9' },
          },
          regionVersion: { version: '2026/09' },
        };
      }

      throw new Error(`Unexpected Google Play request: ${path}`);
    });

    await updateBasePlanPrices(
      credentials,
      'at.persie0.hanziHero',
      'yearly',
      'yearly-base',
      [
        {
          regionCode: 'US',
          price: { currencyCode: 'USD', units: '15' },
          newSubscriberAvailability: true,
        },
      ]
    );

    const patchCall = fetchMock.mock.calls.find(([, , options]) => options?.method === 'PATCH');
    expect(patchCall).toBeDefined();

    const body = patchCall?.[2]?.body as {
      basePlans?: Array<{
        basePlanId?: string;
        regionalConfigs?: Array<{
          regionCode: string;
          price: { currencyCode: string; units: string; nanos?: number };
        }>;
      }>;
    };

    const untargetedPlan = body.basePlans?.find((bp) => bp.basePlanId === 'yearly-legacy');
    expect(untargetedPlan).toBeDefined();

    // AR should have been normalized to USD
    const legacyAr = untargetedPlan?.regionalConfigs?.find((rc) => rc.regionCode === 'AR');
    expect(legacyAr?.price.currencyCode).toBe('USD');

    // ET should have been dropped because it's not in currentRegionPrices
    const legacyEt = untargetedPlan?.regionalConfigs?.find((rc) => rc.regionCode === 'ET');
    expect(legacyEt).toBeUndefined();
  });
});

