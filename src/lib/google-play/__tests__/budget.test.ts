import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeaderTokenSource } from '../../token-source';

vi.mock('../client', () => ({ googlePlayFetch: vi.fn() }));

import { googlePlayFetch } from '../client';
import { updateBasePlanPrices } from '../subscriptions';
import { updateInAppProductPrices } from '../products';
import { RequestBudget } from '@/lib/utils/request-budget';

const fetchMock = vi.mocked(googlePlayFetch);
const tokens = new HeaderTokenSource('google', 'test-access-token', 'test@example.iam.gserviceaccount.com');

beforeEach(() => {
  fetchMock.mockReset();
});

describe('Google helpers charge every request to the caller budget', () => {
  it('base plan price edit: read and PATCH', async () => {
    fetchMock.mockImplementation(async (_c, _p, options) => {
      if (options?.method === 'PATCH') return options.body as never;
      return {
        productId: 'premium',
        regionsVersion: { version: '2025/03' },
        basePlans: [{ basePlanId: 'monthly', regionalConfigs: [{ regionCode: 'GB', price: { currencyCode: 'GBP', units: '4' } }] }],
      } as never;
    });
    const budget = new RequestBudget();
    await updateBasePlanPrices(tokens, 'com.example.app', 'premium', 'monthly', [
      { regionCode: 'GB', price: { currencyCode: 'GBP', units: '5' }, newSubscriberAvailability: true },
    ], { budget });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) expect(call[2]?.budget).toBe(budget);
  });

  it('one-time product price edit: read and PATCH', async () => {
    fetchMock.mockImplementation(async (_c, _p, options) => {
      if (options?.method === 'PATCH') return options.body as never;
      return {
        productId: 'coins',
        purchaseOptions: [{ regionalPricingAndAvailabilityConfigs: [{ regionCode: 'GB', price: { currencyCode: 'GBP', units: '1' } }] }],
      } as never;
    });
    const budget = new RequestBudget();
    await updateInAppProductPrices(tokens, 'com.example.app', 'coins', { GB: { currencyCode: 'GBP', units: '2' } }, undefined, { budget });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) expect(call[2]?.budget).toBe(budget);
  });
});
