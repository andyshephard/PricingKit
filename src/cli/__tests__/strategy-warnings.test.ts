// Strategy targets pass the strategy's own warnings (e.g. a minimum price
// not enforced) into the plan. The built-in data has no territory that
// triggers one, so calculateRegionalPrice is wrapped to add a warning.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/pricing/strategies', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pricing/strategies')>();
  return {
    ...actual,
    calculateRegionalPrice: (...args: Parameters<typeof actual.calculateRegionalPrice>) => {
      const price = actual.calculateRegionalPrice(...args);
      return args[1] === 'GB' || args[1] === 'US' ? { ...price, warnings: ['Minimum price not enforced: no exchange rate for XXX'] } : price;
    },
  };
});

import { specTargets, type PricingSpecProduct, type ProductPriceState, type ResolveTarget } from '@/lib/pricing';
import { planFromSpec } from '../commands/plan';

const product = { platform: 'google', type: 'subscription', productId: 'pro', basePlanId: 'annual' } as const;
const state: ProductPriceState = {
  product,
  capturedAt: '2030-01-01T00:00:00Z',
  territories: {
    GB: { territory: 'GB', currency: 'GBP', current: { currency: 'GBP', amount: '4.99' } },
    US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '1.00' } },
  },
};
const entry: PricingSpecProduct = { product, targets: { type: 'strategy', strategy: 'direct', base: { territory: 'GB', amount: '4.99' } } };

describe('strategy warnings', () => {
  it('specTargets returns them per territory', () => {
    expect(specTargets(entry, state).warnings).toEqual([
      { territory: 'GB', message: 'Minimum price not enforced: no exchange rate for XXX' },
      { territory: 'US', message: 'Minimum price not enforced: no exchange rate for XXX' },
    ]);
  });

  it('the plan carries them on the op of the territory, or on "-" when it needs no change', async () => {
    const reader = {
      fetchState: async () => structuredClone(state),
      // Play takes amounts as given: echo the targets back
      resolvePricePoints: async (_p: unknown, targets: Record<string, ResolveTarget>) => ({
        resolved: Object.fromEntries(Object.entries(targets).map(([t, v]) => [t, { ...v, target: v.amount, deviation: '0', deviationRatio: '0' }])),
        unresolved: {},
      }),
      fetchRegionsVersion: async () => '2025/03',
    };
    const { changeSet } = await planFromSpec(
      { kind: 'pricingkit.spec', schemaVersion: 1, app: { packageName: 'com.example.app' }, products: [entry] },
      reader as never,
      '2030-01-01T00:00:00Z'
    );
    expect(changeSet.ops.map((op) => (op as { target: { territory: string } }).target.territory)).toEqual(['US']);
    expect(changeSet.warnings).toEqual([
      { opId: '-', message: 'google:subscription:pro/annual GB (no change): Minimum price not enforced: no exchange rate for XXX' },
      { opId: changeSet.ops[0].id, message: 'US: Minimum price not enforced: no exchange rate for XXX' },
    ]);
  });
});
