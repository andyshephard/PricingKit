import { describe, it, expect } from 'vitest';
import { calculateRegionalPrice, parsePricingSpec, PricingSpecError, specTargets, type PricingSpecProduct, type ProductPriceState } from '@/lib/pricing';

const appleSub = { platform: 'apple', type: 'subscription', id: '1234567890' } as const;
const playPlan = { platform: 'google', type: 'subscription', productId: 'pro', basePlanId: 'annual' } as const;

const spec = (products: unknown[], app: unknown = { bundleId: 'com.example.app' }) => ({ kind: 'pricingkit.spec', schemaVersion: 1, app, products });

function problems(input: unknown): string[] {
  try {
    parsePricingSpec(input);
  } catch (error) {
    if (error instanceof PricingSpecError) return error.issues;
    throw error;
  }
  return [];
}

describe('parsePricingSpec', () => {
  it('accepts fixed and percent targets and normalises amounts', () => {
    const parsed = parsePricingSpec(
      JSON.stringify(
        spec([
          { product: appleSub, targets: { type: 'fixed', prices: { GB: '4.990', US: { amount: '5.99', currency: 'USD' } } }, snap: 'floor', startDate: '2030-06-01' },
        ])
      )
    );
    expect(parsed.products[0].targets).toEqual({ type: 'fixed', prices: { GB: '4.99', US: { amount: '5.99', currency: 'USD' } } });
    expect(
      parsePricingSpec(spec([{ product: playPlan, targets: { type: 'percentOfCurrent', percent: '110.5', territories: ['GB'] } }], { packageName: 'com.example.app' }))
        .products[0].targets
    ).toEqual({ type: 'percentOfCurrent', percent: '110.5', territories: ['GB'] });
  });

  it('refuses malformed specs with the path of each problem', () => {
    expect(problems('{')).toEqual(['not valid JSON']);
    expect(problems({ ...spec([]), kind: 'other' })).toEqual(expect.arrayContaining([expect.stringMatching(/^kind:/)]));
    expect(problems(spec([]))).toEqual([expect.stringMatching(/^products:/)]);
    expect(problems(spec([{ product: appleSub, targets: { type: 'fixed', prices: { GB: 4.99 } } }]))).toEqual([expect.stringMatching(/^products\.0\.targets\.prices\.GB/)]);
    expect(problems(spec([{ product: appleSub, targets: { type: 'fixed', prices: { GB: '-1' } } }]))).toEqual([expect.stringMatching(/must not be negative/)]);
    expect(problems(spec([{ product: appleSub, targets: { type: 'percentOfCurrent', percent: '0' } }]))).toEqual([expect.stringMatching(/above 0/)]);
    expect(problems(spec([{ product: appleSub, targets: { type: 'percentOfCurrent', percent: '1.23456' } }]))).toEqual([expect.stringMatching(/4 decimal places/)]);
    expect(problems(spec([{ product: appleSub, targets: { type: 'fixed', prices: { GB: '1' } }, extra: true }]))).toHaveLength(1);
    expect(problems(spec([{ product: appleSub, targets: { type: 'fixed', prices: { GB: '1' } }, startDate: '1 June' }]))).toEqual([expect.stringMatching(/YYYY-MM-DD/)]);
  });

  it('checks rules across products and the app', () => {
    const fixed = { type: 'fixed', prices: { GB: '1' } };
    expect(problems(spec([{ product: playPlan, targets: fixed }]))).toEqual([expect.stringMatching(/a Google Play product, but the spec is for an app on App Store/)]);
    expect(problems(spec([{ product: appleSub, targets: fixed }, { product: appleSub, targets: fixed }]))).toEqual([expect.stringMatching(/listed twice/)]);
    expect(problems(spec([{ product: { ...appleSub, type: 'inapp' }, targets: fixed }]))).toEqual([expect.stringMatching(/in-app purchase/)]);
    expect(problems(spec([{ product: playPlan, targets: fixed, startDate: '2030-01-01' }], { packageName: 'p' }))).toEqual([expect.stringMatching(/Apple-only/)]);
    expect(problems(spec([{ product: appleSub, targets: { type: 'fixed', prices: {} } }]))).toEqual([expect.stringMatching(/empty/)]);
  });
});

describe('specTargets', () => {
  const state = (product: ProductPriceState['product']): ProductPriceState => ({
    product,
    capturedAt: '2030-01-01T00:00:00Z',
    territories: {
      GB: { territory: 'GB', currency: 'GBP', current: { currency: 'GBP', amount: '4.99' } },
      JP: { territory: 'JP', currency: 'JPY', current: { currency: 'JPY', amount: '650' } },
      US: { territory: 'US', currency: 'USD', current: null },
      DE: { territory: 'DE', currency: 'EUR', current: null, problems: { current: '2 prices share the latest start date' } },
    },
  });

  it('fixed: takes each territory currency from its state unless given', () => {
    const entry: PricingSpecProduct = { product: appleSub, targets: { type: 'fixed', prices: { GB: '5.49', FR: '4.99', CA: { amount: '6.99', currency: 'CAD' } } } };
    const result = specTargets(entry, state(appleSub));
    expect(result.targets).toEqual({ GB: { currency: 'GBP', amount: '5.49' }, CA: { currency: 'CAD', amount: '6.99' } });
    expect(result.skipped).toEqual([expect.objectContaining({ territory: 'FR', reason: 'INVALID_TARGET' })]);
  });

  it('percentOfCurrent: exact on Apple, minor units on Play, skips unreadable and unpriced territories', () => {
    const entry = (product: PricingSpecProduct['product']): PricingSpecProduct => ({ product, targets: { type: 'percentOfCurrent', percent: '110' } });
    const apple = specTargets(entry(appleSub), state(appleSub));
    expect(apple.targets).toEqual({ GB: { currency: 'GBP', amount: '5.489' }, JP: { currency: 'JPY', amount: '715' } });
    expect(apple.skipped.map((s) => `${s.territory}:${s.reason}`)).toEqual(['DE:AMBIGUOUS_STATE', 'US:NOT_CONFIGURED']);

    const play = specTargets(entry(playPlan), state(playPlan));
    expect(play.targets.GB).toEqual({ currency: 'GBP', amount: '5.49' });
    expect(play.targets.JP).toEqual({ currency: 'JPY', amount: '715' });
  });

  it('percentOfCurrent: only the listed territories', () => {
    const result = specTargets({ product: appleSub, targets: { type: 'percentOfCurrent', percent: '90', territories: ['GB', 'FR'] } }, state(appleSub));
    expect(Object.keys(result.targets)).toEqual(['GB']);
    expect(result.targets.GB.amount).toBe('4.491');
    expect(result.skipped).toEqual([expect.objectContaining({ territory: 'FR', reason: 'NOT_CONFIGURED' })]);
  });

  describe('strategy', () => {
    const ppp = (extra: object = {}): PricingSpecProduct['targets'] => ({ type: 'strategy', strategy: 'ppp', base: { territory: 'GB', amount: '4.99' }, ...extra }) as PricingSpecProduct['targets'];

    it('spreads the base price with the core strategy, in each territory current currency', () => {
      const result = specTargets({ product: appleSub, targets: ppp() }, state(appleSub));
      // Exactly what calculateRegionalPrice gives (rounding "none" on Apple: snapping picks the price point)
      const expected = (territory: string, currency: string, scale: number) =>
        calculateRegionalPrice(4.99, territory, 'ppp', 'none', undefined, undefined, { [territory]: currency }, undefined, 'GBP', 'GB').rawPrice.toFixed(scale);
      expect(result.targets.GB).toEqual({ currency: 'GBP', amount: '4.99' });
      expect(result.targets.JP).toEqual({ currency: 'JPY', amount: String(Number(expected('JP', 'JPY', 0))) });
      expect(result.targets.US.amount).toBe(String(Number(expected('US', 'USD', 2))));
      expect(result.targets.DE.currency).toBe('EUR');
      expect(result.skipped).toEqual([]);
    });

    it('rounds to price endings on Play by default, and takes the rounding the spec names', () => {
      const play = specTargets({ product: playPlan, targets: ppp() }, state(playPlan));
      expect(play.targets.US.amount).toMatch(/\.99$/);
      const up = specTargets({ product: playPlan, targets: ppp({ rounding: 'none' }) }, state(playPlan));
      expect(up.targets.US.amount).toBe(String(Number(calculateRegionalPrice(4.99, 'US', 'ppp', 'none', undefined, undefined, { US: 'USD' }, undefined, 'GBP', 'GB').rawPrice.toFixed(2))));
    });

    it('uses the spec exchange rates over the built-in ones, and only the listed territories', () => {
      const direct = (rates?: Record<string, string>) =>
        specTargets({ product: appleSub, targets: ppp({ strategy: 'direct', territories: ['US', 'FR'], ...(rates ? { exchangeRates: rates } : {}) }) }, state(appleSub));
      const withRates = direct({ GBP: '0.5' });
      expect(withRates.targets).toEqual({ US: { currency: 'USD', amount: '9.98' } });
      expect(withRates.skipped).toEqual([expect.objectContaining({ territory: 'FR', reason: 'NOT_CONFIGURED' })]);
      expect(direct().targets.US.amount).not.toBe('9.98');
    });

    it('skips territories it cannot price, and everything when the base currency is unknown', () => {
      const odd: ProductPriceState = { ...state(appleSub), territories: { ...state(appleSub).territories, XX: { territory: 'XX', currency: 'XXX', current: null } } };
      const result = specTargets({ product: appleSub, targets: ppp({ strategy: 'direct' }) }, odd);
      expect(result.skipped).toEqual([expect.objectContaining({ territory: 'XX', reason: 'INVALID_TARGET', detail: expect.stringMatching(/exchange rate/) })]);
      const noBase = specTargets({ product: appleSub, targets: ppp({ base: { territory: 'FR', amount: '4.99' }, territories: ['GB'] }) }, state(appleSub));
      expect(noBase.targets).toEqual({});
      expect(noBase.skipped).toEqual([expect.objectContaining({ territory: 'GB', reason: 'INVALID_TARGET', detail: expect.stringMatching(/give base\.currency/) })]);
      const given = specTargets({ product: appleSub, targets: ppp({ base: { territory: 'FR', amount: '4.99', currency: 'EUR' }, territories: ['GB'] }) }, state(appleSub));
      expect(Object.keys(given.targets)).toEqual(['GB']);
    });

    it('parses strategy targets and refuses what the core cannot price', () => {
      expect(parsePricingSpec(spec([{ product: appleSub, targets: ppp({ rounding: 'nearest-99', exchangeRates: { EUR: '0.920' } }) }])).products[0].targets).toEqual({
        type: 'strategy',
        strategy: 'ppp',
        base: { territory: 'GB', amount: '4.99' },
        rounding: 'nearest-99',
        exchangeRates: { EUR: '0.92' },
      });
      expect(problems(spec([{ product: appleSub, targets: ppp({ strategy: 'custom' }) }]))).toEqual([expect.stringMatching(/^products\.0\.targets\.strategy/)]);
      expect(problems(spec([{ product: appleSub, targets: ppp({ rounding: 'nearest-tier' }) }]))).toEqual([expect.stringMatching(/^products\.0\.targets\.rounding/)]);
      expect(problems(spec([{ product: appleSub, targets: ppp({ base: { territory: 'GB', amount: '0' } }) }]))).toEqual([expect.stringMatching(/above 0/)]);
      expect(problems(spec([{ product: appleSub, targets: ppp({ base: { territory: 'GBR', amount: '1' } }) }]))).toEqual([expect.stringMatching(/alpha-2/)]);
      expect(problems(spec([{ product: appleSub, targets: ppp({ exchangeRates: { EUR: 0.9 } }) }]))).toHaveLength(1);
    });
  });
});
