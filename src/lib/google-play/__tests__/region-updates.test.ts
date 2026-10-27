import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeaderTokenSource } from '../../token-source';

vi.mock('../client', () => ({
  googlePlayFetch: vi.fn(),
}));

import { googlePlayFetch } from '../client';
import {
  updateBasePlanPrices,
  deleteBasePlanRegionPrice,
} from '../subscriptions';
import {
  updateInAppProductPrices,
  deleteRegionPrice,
  FALLBACK_PRODUCT_REGIONS_VERSION,
} from '../products';

const fetchMock = vi.mocked(googlePlayFetch);
const tokens = new HeaderTokenSource('google', 'test-access-token', 'test@example.iam.gserviceaccount.com');

type Call = [unknown, string, { method?: string; query?: Record<string, unknown>; body?: unknown }?];
type Region = { regionCode: string; [key: string]: unknown };
type PatchBody = {
  basePlans: Array<{ basePlanId: string; regionalConfigs: Region[]; otherRegionsConfig?: unknown }>;
  purchaseOptions: Array<{ regionalPricingAndAvailabilityConfigs: Region[] }>;
};

function patchCall(): { path: string; query: Record<string, unknown>; body: PatchBody } {
  const call = fetchMock.mock.calls.find(c => (c as Call)[2]?.method === 'PATCH') as Call | undefined;
  expect(call, 'expected a PATCH request').toBeDefined();
  return { path: call![1], query: call![2]!.query!, body: call![2]!.body as PatchBody };
}

/** Respond to GET with `resource` and echo PATCH bodies back. */
function serve(resource: unknown) {
  const snapshot = JSON.stringify(resource);
  fetchMock.mockImplementation(async (_creds, _path, options) => {
    if (options?.method === 'PATCH') return options.body as never;
    return JSON.parse(snapshot);
  });
}

function subscriptionFixture(overrides: Record<string, unknown> = {}) {
  return {
    packageName: 'com.example.app',
    productId: 'premium',
    regionsVersion: { version: '2023/11' },
    basePlans: [
      {
        basePlanId: 'monthly',
        state: 'active',
        regionalConfigs: [
          { regionCode: 'US', newSubscriberAvailability: true, price: { currencyCode: 'USD', units: '9', nanos: 990000000 } },
          { regionCode: 'DE', newSubscriberAvailability: false, price: { currencyCode: 'EUR', units: '8', nanos: 990000000 } },
          { regionCode: 'JP', price: { currencyCode: 'JPY', units: '1200' } },
        ],
        otherRegionsConfig: {
          usdPrice: { currencyCode: 'USD', units: '9', nanos: 990000000 },
          eurPrice: { currencyCode: 'EUR', units: '8', nanos: 990000000 },
          newSubscriberAvailability: true,
        },
      },
      {
        basePlanId: 'yearly',
        state: 'active',
        regionalConfigs: [
          { regionCode: 'US', newSubscriberAvailability: true, price: { currencyCode: 'USD', units: '99' } },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('updateBasePlanPrices', () => {
  it('changes only the requested region and leaves every other region byte-identical', async () => {
    const original = subscriptionFixture();
    serve(original);

    await updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [
      { regionCode: 'JP', price: { currencyCode: 'JPY', units: '1500' } },
    ]);

    const { body } = patchCall();
    const monthly = body.basePlans.find((bp: PatchBody["basePlans"][number]) => bp.basePlanId === 'monthly')!;
    const originalMonthly = original.basePlans[0];

    // No regions added, order preserved.
    expect(monthly.regionalConfigs.map((c: Region) => c.regionCode)).toEqual(['US', 'DE', 'JP']);
    // Untouched regions are byte-identical (price + availability).
    expect(JSON.stringify(monthly.regionalConfigs[0])).toBe(JSON.stringify(originalMonthly.regionalConfigs[0]));
    expect(JSON.stringify(monthly.regionalConfigs[1])).toBe(JSON.stringify(originalMonthly.regionalConfigs[1]));
    // Updated region: new price, availability not forced (was absent, stays absent).
    expect(monthly.regionalConfigs[2]).toEqual({ regionCode: 'JP', price: { currencyCode: 'JPY', units: '1500' } });
    // otherRegionsConfig and sibling base plans untouched.
    expect(monthly.otherRegionsConfig).toEqual(originalMonthly.otherRegionsConfig);
    expect(JSON.stringify(body.basePlans[1])).toBe(JSON.stringify(original.basePlans[1]));
  });

  it('keeps an existing region unavailable to new subscribers when its price changes', async () => {
    serve(subscriptionFixture());

    await updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [
      { regionCode: 'DE', price: { currencyCode: 'EUR', units: '7', nanos: 990000000 } },
    ]);

    const de = patchCall().body.basePlans[0].regionalConfigs.find((c: Region) => c.regionCode === 'DE')!;
    expect(de.newSubscriberAvailability).toBe(false);
    expect(de.price).toEqual({ currencyCode: 'EUR', units: '7', nanos: 990000000 });
  });

  it('adds a brand-new region (available by default) without filling in others', async () => {
    serve(subscriptionFixture());

    await updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [
      { regionCode: 'GB', price: { currencyCode: 'GBP', units: '7', nanos: 990000000 } },
    ]);

    const configs = patchCall().body.basePlans[0].regionalConfigs;
    expect(configs.map((c: Region) => c.regionCode)).toEqual(['US', 'DE', 'JP', 'GB']);
    expect(configs[3].newSubscriberAvailability).toBe(true);
  });

  it('does not require a US price', async () => {
    const sub = subscriptionFixture();
    const monthlyPlan = sub.basePlans[0] as { regionalConfigs: Region[] };
    monthlyPlan.regionalConfigs = monthlyPlan.regionalConfigs.filter(c => c.regionCode !== 'US');
    serve(sub);

    await updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [
      { regionCode: 'JP', price: { currencyCode: 'JPY', units: '1500' } },
    ]);

    expect(patchCall().body.basePlans[0].regionalConfigs.map((c: Region) => c.regionCode)).toEqual(['DE', 'JP']);
  });

  it("uses the subscription's own regionsVersion", async () => {
    serve(subscriptionFixture());
    await updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [
      { regionCode: 'JP', price: { currencyCode: 'JPY', units: '1500' } },
    ]);
    expect(patchCall().query['regionsVersion.version']).toBe('2023/11');
  });

  it("uses Play's current regions version (from a price conversion) when the resource has none, never a hard-coded one", async () => {
    // Play's Subscription resource has no regionsVersion field (discovery document)
    const resource = JSON.stringify(subscriptionFixture({ regionsVersion: undefined }));
    fetchMock.mockImplementation(async (_creds, path, options) => {
      if (options?.method === 'PATCH') return options.body as never;
      if (path.endsWith('/pricing:convertRegionPrices')) return { convertedRegionPrices: {}, regionVersion: { version: '2025/10' } } as never;
      return JSON.parse(resource);
    });
    await updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [
      { regionCode: 'JP', price: { currencyCode: 'JPY', units: '1500' } },
    ]);
    expect(patchCall().query['regionsVersion.version']).toBe('2025/10');
  });

  it('sends the regions version it is given (a reviewed plan records one), without asking Play', async () => {
    serve(subscriptionFixture({ regionsVersion: undefined }));
    await updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [{ regionCode: 'JP', price: { currencyCode: 'JPY', units: '1500' } }], {}, { regionsVersion: '2024/02' });
    expect(patchCall().query['regionsVersion.version']).toBe('2024/02');
    expect(fetchMock.mock.calls.some((c) => String(c[1]).endsWith(':convertRegionPrices'))).toBe(false);
  });

  it('refuses the edit, sending nothing, when Play reports no regions version', async () => {
    const resource = JSON.stringify(subscriptionFixture({ regionsVersion: undefined }));
    fetchMock.mockImplementation(async (_creds, path, options) => {
      if (options?.method === 'PATCH') return options.body as never;
      if (path.endsWith('/pricing:convertRegionPrices')) return { convertedRegionPrices: {} } as never;
      return JSON.parse(resource);
    });
    await expect(
      updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [{ regionCode: 'JP', price: { currencyCode: 'JPY', units: '1500' } }])
    ).rejects.toMatchObject({ code: 'NO_REGIONS_VERSION' });
    expect(fetchMock.mock.calls.some((c) => (c as Call)[2]?.method === 'PATCH')).toBe(false);
  });

  it("surfaces Google's rejection unchanged", async () => {
    const googleError = { code: 400, message: 'Price for region XX is required.' };
    const snapshot = JSON.stringify(subscriptionFixture());
    fetchMock.mockImplementation(async (_c, _p, options) => {
      if (options?.method === 'PATCH') throw googleError;
      return JSON.parse(snapshot);
    });

    await expect(
      updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [
        { regionCode: 'JP', price: { currencyCode: 'JPY', units: '1500' } },
      ])
    ).rejects.toBe(googleError);
  });
});

describe('deleteBasePlanRegionPrice', () => {
  it('removes exactly one region and re-adds nothing', async () => {
    const original = subscriptionFixture();
    serve(original);

    await deleteBasePlanRegionPrice(tokens, 'com.example.app', 'premium', 'monthly', 'DE');

    const { body, query } = patchCall();
    const configs = body.basePlans[0].regionalConfigs;
    expect(configs.map((c: Region) => c.regionCode)).toEqual(['US', 'JP']);
    expect(JSON.stringify(configs[0])).toBe(JSON.stringify(original.basePlans[0].regionalConfigs[0]));
    expect(JSON.stringify(configs[1])).toBe(JSON.stringify(original.basePlans[0].regionalConfigs[2]));
    expect(body.basePlans[0].otherRegionsConfig).toEqual(original.basePlans[0].otherRegionsConfig);
    expect(query['regionsVersion.version']).toBe('2023/11');
  });

  it('lets the caller remove the US region (Google decides if that is allowed)', async () => {
    serve(subscriptionFixture());
    await deleteBasePlanRegionPrice(tokens, 'com.example.app', 'premium', 'monthly', 'US');
    expect(patchCall().body.basePlans[0].regionalConfigs.map((c: Region) => c.regionCode)).toEqual(['DE', 'JP']);
  });

  it('returns 404 without patching when the region is not configured', async () => {
    serve(subscriptionFixture());
    await expect(
      deleteBasePlanRegionPrice(tokens, 'com.example.app', 'premium', 'monthly', 'FR')
    ).rejects.toMatchObject({ code: 404 });
    expect(fetchMock.mock.calls.some(c => (c as Call)[2]?.method === 'PATCH')).toBe(false);
  });
});

function productFixture(overrides: Record<string, unknown> = {}) {
  return {
    packageName: 'com.example.app',
    productId: 'coins_100',
    regionsVersion: { version: '2024/05' },
    listings: [{ languageCode: 'en-US', title: 'Coins', description: '100 coins' }],
    purchaseOptions: [
      {
        purchaseOptionId: 'default',
        state: 'ACTIVE',
        regionalPricingAndAvailabilityConfigs: [
          { regionCode: 'US', availability: 'AVAILABLE', price: { currencyCode: 'USD', units: '1', nanos: 990000000 } },
          { regionCode: 'KR', availability: 'NO_LONGER_AVAILABLE' },
          { regionCode: 'IN', availability: 'AVAILABLE', price: { currencyCode: 'INR', nanos: 500000000 } },
          { regionCode: 'DE', availability: 'AVAILABLE', price: { currencyCode: 'EUR', units: '1', nanos: 990000000 } },
        ],
      },
    ],
    ...overrides,
  };
}

describe('updateInAppProductPrices', () => {
  it('changes only the requested region and re-sends others exactly as fetched', async () => {
    const original = productFixture();
    serve(original);

    await updateInAppProductPrices(tokens, 'com.example.app', 'coins_100', {
      DE: { currencyCode: 'EUR', units: '2', nanos: 490000000 },
    });

    const { body, query } = patchCall();
    const configs = body.purchaseOptions[0].regionalPricingAndAvailabilityConfigs;
    const originalConfigs = original.purchaseOptions[0].regionalPricingAndAvailabilityConfigs;
    expect(configs.map((c: Region) => c.regionCode)).toEqual(['US', 'KR', 'IN', 'DE']);
    for (const i of [0, 1, 2]) {
      expect(JSON.stringify(configs[i])).toBe(JSON.stringify(originalConfigs[i]));
    }
    expect(configs[3]).toEqual({
      regionCode: 'DE',
      availability: 'AVAILABLE',
      price: { currencyCode: 'EUR', units: '2', nanos: 490000000 },
    });
    expect(query['regionsVersion.version']).toBe('2024/05');
  });

  it('never turns a priceless region into USD 0', async () => {
    serve(productFixture());

    await updateInAppProductPrices(tokens, 'com.example.app', 'coins_100', {
      US: { currencyCode: 'USD', units: '2', nanos: 990000000 },
    });

    const configs = patchCall().body.purchaseOptions[0].regionalPricingAndAvailabilityConfigs;
    const kr = configs.find((c: Region) => c.regionCode === 'KR')!;
    const inr = configs.find((c: Region) => c.regionCode === 'IN')!;
    expect(kr).toEqual({ regionCode: 'KR', availability: 'NO_LONGER_AVAILABLE' });
    expect(kr.price).toBeUndefined();
    expect(inr.price).toEqual({ currencyCode: 'INR', nanos: 500000000 });
  });

  it('falls back to the fallback regionsVersion only when the product has none', async () => {
    serve(productFixture({ regionsVersion: undefined }));
    await updateInAppProductPrices(tokens, 'com.example.app', 'coins_100', {
      US: { currencyCode: 'USD', units: '2' },
    });
    expect(patchCall().query['regionsVersion.version']).toBe(FALLBACK_PRODUCT_REGIONS_VERSION);
  });
});

describe('deleteRegionPrice (one-time products)', () => {
  it('removes exactly one region and PATCHes the product', async () => {
    const original = productFixture();
    serve(original);

    const result = await deleteRegionPrice(tokens, 'com.example.app', 'coins_100', 'DE');

    const { body, path, query } = patchCall();
    expect(path).toContain('/onetimeproducts/coins_100');
    expect(query.updateMask).toBe('purchaseOptions');
    expect(query['regionsVersion.version']).toBe('2024/05');
    const configs = body.purchaseOptions[0].regionalPricingAndAvailabilityConfigs;
    expect(JSON.stringify(configs)).toBe(
      JSON.stringify(original.purchaseOptions[0].regionalPricingAndAvailabilityConfigs.slice(0, 3))
    );
    expect(result.prices.DE).toBeUndefined();
    expect(result.prices.US).toBeDefined();
  });

  it('returns 404 without patching when the region is not configured', async () => {
    serve(productFixture());
    await expect(
      deleteRegionPrice(tokens, 'com.example.app', 'coins_100', 'FR')
    ).rejects.toMatchObject({ code: 404 });
    expect(fetchMock.mock.calls.some(c => (c as Call)[2]?.method === 'PATCH')).toBe(false);
  });

  it("surfaces Google's rejection unchanged", async () => {
    const googleError = { code: 400, message: 'Cannot remove region.' };
    const snapshot = JSON.stringify(productFixture());
    fetchMock.mockImplementation(async (_c, _p, options) => {
      if (options?.method === 'PATCH') throw googleError;
      return JSON.parse(snapshot);
    });
    await expect(
      deleteRegionPrice(tokens, 'com.example.app', 'coins_100', 'DE')
    ).rejects.toBe(googleError);
  });
});

describe('writing only if the price is still the expected one', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('base plan: refuses with PRICE_CHANGED when the fresh read differs, sending no PATCH', async () => {
    serve(subscriptionFixture());
    const newUs = { regionCode: 'US', price: { currencyCode: 'USD', units: '10' } } as never;
    await expect(
      updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [newUs], {}, { expected: { US: { currencyCode: 'USD', units: '9', nanos: 980000000 } } })
    ).rejects.toMatchObject({ status: 409, code: 'PRICE_CHANGED' });
    expect(fetchMock.mock.calls.some((c) => (c as Call)[2]?.method === 'PATCH')).toBe(false);
    // The previewed price still there: written
    await updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [newUs], {}, { expected: { US: { currencyCode: 'USD', units: '9', nanos: 990000000 } } });
    expect(patchCall().body.basePlans[0].regionalConfigs.find((r) => r.regionCode === 'US')?.price).toEqual({ currencyCode: 'USD', units: '10' });
  });

  it('one-time product: refuses with PRICE_CHANGED when a region lost its price or changed', async () => {
    serve({
      packageName: 'com.example.app',
      productId: 'coins',
      purchaseOptions: [{ purchaseOptionId: 'default', regionalPricingAndAvailabilityConfigs: [{ regionCode: 'US', availability: 'AVAILABLE', price: { currencyCode: 'USD', units: '12' } }] }],
    });
    await expect(
      updateInAppProductPrices(tokens, 'com.example.app', 'coins', { US: { currencyCode: 'USD', units: '13' } }, undefined, {}, { expected: { US: { currencyCode: 'USD', units: '11' }, GB: { currencyCode: 'GBP', units: '9' } } })
    ).rejects.toThrow(/PRICE_CHANGED: .* in GB, US/);
    expect(fetchMock.mock.calls.some((c) => (c as Call)[2]?.method === 'PATCH')).toBe(false);
  });
});
