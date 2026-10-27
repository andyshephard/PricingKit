import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';

vi.mock('@/lib/google-play/client', () => ({ googlePlayFetch: vi.fn() }));

import { googlePlayFetch } from '@/lib/google-play/client';
import { PlayAdapter } from '../play';
import {
  basePriceOps,
  applyChangeSet,
  buildChangeSet,
  buildUndoChangeSet,
  type ProductRef,
} from '@/lib/pricing';
import { RequestBudget } from '@/lib/utils/request-budget';

const fetchMock = vi.mocked(googlePlayFetch);
const credentials = {} as ServiceAccountCredentials;
const PKG = 'com.example.app';
const plan: ProductRef = { platform: 'google', type: 'subscription', productId: 'pro', basePlanId: 'annual' };
const coins: ProductRef = { platform: 'google', type: 'inapp', productId: 'coins' };
const app = { packageName: PKG };

type Region = { regionCode: string; price: { currencyCode: string; units: string; nanos?: number }; newSubscriberAvailability?: boolean };

// Invented tax rates and FX, only for the convertRegionPrices fake
const REGIONS: Record<string, { currency: string; tax: number; perUsd: number }> = {
  US: { currency: 'USD', tax: 0, perUsd: 1 },
  GB: { currency: 'GBP', tax: 0.2, perUsd: 0.8 },
  JP: { currency: 'JPY', tax: 0.1, perUsd: 150 },
};

function money(currency: string, amount: number) {
  const units = Math.floor(amount);
  const nanos = Math.round((amount - units) * 100) * 10_000_000;
  return { currencyCode: currency, units: String(units), ...(nanos ? { nanos } : {}) };
}

let subscription: { productId: string; regionsVersion: { version: string }; basePlans: Array<{ basePlanId: string; regionalConfigs: Region[] }> };
let product: { productId: string; purchaseOptions: Array<{ purchaseOptionId: string; regionalPricingAndAvailabilityConfigs: Array<Record<string, unknown>> }> };
const calls: Array<{ method: string; path: string; budget?: unknown; body?: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  subscription = {
    productId: 'pro',
    regionsVersion: { version: '2025/03' },
    basePlans: [
      {
        basePlanId: 'annual',
        regionalConfigs: [
          { regionCode: 'US', price: { currencyCode: 'USD', units: '29', nanos: 990000000 }, newSubscriberAvailability: true },
          { regionCode: 'GB', price: { currencyCode: 'GBP', units: '24', nanos: 990000000 }, newSubscriberAvailability: false },
          { regionCode: 'JP', price: { currencyCode: 'JPY', units: '3900' }, newSubscriberAvailability: true },
        ],
      },
      { basePlanId: 'monthly', regionalConfigs: [{ regionCode: 'US', price: { currencyCode: 'USD', units: '2', nanos: 990000000 } }] },
    ],
  };
  product = {
    productId: 'coins',
    purchaseOptions: [
      { purchaseOptionId: 'default', regionalPricingAndAvailabilityConfigs: [{ regionCode: 'GB', price: { currencyCode: 'GBP', units: '1', nanos: 490000000 }, availability: 'AVAILABLE' }] },
    ],
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_c, path, options) => {
    const method = options?.method ?? 'GET';
    calls.push({ method, path, budget: options?.budget, body: options?.body });
    (options?.budget as RequestBudget | undefined)?.consume('google');
    if (path.endsWith('/pricing:convertRegionPrices')) {
      const input = (options!.body as { price: { currencyCode: string; units: string; nanos?: number } }).price;
      const amount = Number(input.units) + (input.nanos ?? 0) / 1e9;
      const usd = amount / REGIONS[Object.keys(REGIONS).find((r) => REGIONS[r].currency === input.currencyCode)!].perUsd;
      const converted: Record<string, unknown> = {};
      for (const [region, r] of Object.entries(REGIONS)) {
        const net = usd * r.perUsd;
        // "Pretty" rounding: .99 endings, whole tens for JPY
        const gross = r.currency === 'JPY' ? Math.round((net * (1 + r.tax)) / 10) * 10 : Math.ceil(net * (1 + r.tax)) - 0.01;
        converted[region] = { regionCode: region, price: money(r.currency, gross), taxAmount: money(r.currency, gross - gross / (1 + r.tax)) };
      }
      return { convertedRegionPrices: converted } as never;
    }
    if (path.endsWith('/subscriptions/pro')) {
      if (method === 'PATCH') {
        subscription = structuredClone({ ...subscription, ...(options!.body as object) }) as typeof subscription;
        return subscription as never;
      }
      return structuredClone(subscription) as never;
    }
    if (path.endsWith('/oneTimeProducts/coins') || path.endsWith('/onetimeproducts/coins')) {
      if (method === 'PATCH') {
        product = structuredClone(options!.body) as typeof product;
        return product as never;
      }
      return structuredClone(product) as never;
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

const adapter = (budget?: RequestBudget) => new PlayAdapter({ credentials, packageName: PKG, budget });

describe('PlayAdapter', () => {
  it('reads base plan and one-time product prices as decimals', async () => {
    const state = await adapter().fetchState(plan);
    expect(state.territories.GB).toEqual({
      territory: 'GB',
      currency: 'GBP',
      current: { currency: 'GBP', amount: '24.99' },
      availability: 'NO_NEW_SUBSCRIBERS',
    });
    expect((await adapter().fetchState(coins)).territories.GB.current).toEqual({ currency: 'GBP', amount: '1.49' });
  });

  it('snaps targets with convertRegionPrices: one probe plus one call per distinct target', async () => {
    const result = await adapter().resolvePricePoints(plan, {
      US: { currency: 'USD', amount: '25.40' },
      GB: { currency: 'GBP', amount: '21.10' },
      JP: { currency: 'JPY', amount: '3333' },
    });
    expect(calls.filter((c) => c.path.endsWith('convertRegionPrices'))).toHaveLength(4);
    // US has no tax: the input is the target itself, rounded by Play's pattern
    expect(result.resolved.US).toMatchObject({ currency: 'USD', amount: '25.99', target: '25.4' });
    // GB: target converted to tax-exclusive first, so the answer lands near the target, not 20% above it
    expect(Number(result.resolved.GB.amount)).toBeGreaterThan(20);
    expect(Number(result.resolved.GB.amount)).toBeLessThan(23);
    expect(result.resolved.JP.amount).toBe('3330');
    expect(result.resolved.JP.deviation).toBe('-3');
    expect(result.unresolved).toEqual({});
  });

  it('writes every region of one product in a single PATCH and leaves the rest as fetched', async () => {
    const state = await adapter().fetchState(plan);
    const changeSet = buildChangeSet({
      app,
      products: [{ state, targets: { US: { currency: 'USD', amount: '24.99' }, GB: { currency: 'GBP', amount: '19.99' } } }],
    });
    calls.length = 0;
    const run = await applyChangeSet(changeSet, { adapter: adapter() });
    expect(run.status).toBe('completed');
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(1);
    const annual = subscription.basePlans.find((bp) => bp.basePlanId === 'annual')!;
    expect(annual.regionalConfigs).toEqual([
      { regionCode: 'US', price: { currencyCode: 'USD', units: '24', nanos: 990000000 }, newSubscriberAvailability: true },
      { regionCode: 'GB', price: { currencyCode: 'GBP', units: '19', nanos: 990000000 }, newSubscriberAvailability: false },
      { regionCode: 'JP', price: { currencyCode: 'JPY', units: '3900' }, newSubscriberAvailability: true },
    ]);
    expect(subscription.basePlans.find((bp) => bp.basePlanId === 'monthly')!.regionalConfigs).toHaveLength(1);
  });

  it('is idempotent and undoable, including a region it added', async () => {
    const before = structuredClone(subscription);
    const state = await adapter().fetchState(plan);
    const changeSet = buildChangeSet({
      app,
      products: [
        {
          state,
          targets: { JP: { currency: 'JPY', amount: '3500' }, FR: { currency: 'EUR', amount: '27.99' } },
          options: { allowNewTerritories: true },
        },
      ],
    });
    const run = await applyChangeSet(changeSet, { adapter: adapter() });
    expect(run.status).toBe('completed');
    expect(subscription.basePlans[0].regionalConfigs.map((c) => c.regionCode)).toEqual(['US', 'GB', 'JP', 'FR']);

    const patchesAfterFirst = calls.filter((c) => c.method === 'PATCH').length;
    const again = await applyChangeSet(changeSet, { adapter: adapter() });
    expect(again.ops.every((r) => r.status === 'skipped')).toBe(true);
    expect(calls.filter((c) => c.method === 'PATCH').length).toBe(patchesAfterFirst);

    const undo = buildUndoChangeSet(changeSet, run);
    expect(basePriceOps(undo).map((op) => `${op.kind} ${op.target.territory}`)).toEqual(['setPrice JP', 'removePrice FR']);
    const undone = await applyChangeSet(undo, { adapter: adapter() });
    expect(undone.status).toBe('completed');
    expect(subscription.basePlans).toEqual(before.basePlans);
  });

  it('applies one-time product prices', async () => {
    const state = await adapter().fetchState(coins);
    const changeSet = buildChangeSet({ app, products: [{ state, targets: { GB: { currency: 'GBP', amount: '0.99' } } }] });
    await applyChangeSet(changeSet, { adapter: adapter() });
    expect(product.purchaseOptions[0].regionalPricingAndAvailabilityConfigs[0]).toEqual({
      regionCode: 'GB',
      price: { currencyCode: 'GBP', units: '0', nanos: 990000000 },
      availability: 'AVAILABLE',
    });
  });

  it('charges reads, conversions and writes to the budget', async () => {
    const budget = new RequestBudget({ limit: 100 });
    const a = adapter(budget);
    await a.resolvePricePoints(plan, { US: { currency: 'USD', amount: '20' } });
    const state = await a.fetchState(plan);
    await applyChangeSet(buildChangeSet({ app, products: [{ state, targets: { US: { currency: 'USD', amount: '19.99' } } }] }), { adapter: a, budget });
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((c) => c.budget === budget)).toBe(true);
    expect(budget.used).toBe(calls.length);
  });
});
