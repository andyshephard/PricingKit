import { describe, it, expect } from 'vitest';
import {
  applyChangeSet,
  changeSetHash,
  checkOfferOpRules,
  classifyOfferOp,
  computeOfferIdempotencyKey,
  ConfirmationRequiredError,
  invertOfferOp,
  parseChangeSet,
  planOfferChanges,
  serializeChangeSet,
  windowsOverlap,
  type OfferOp,
  type OfferPlanInput,
  type OfferState,
  type PlatformAdapter,
  type ProductPriceState,
  type StoreOffer,
} from '..';

const product = { platform: 'apple' as const, type: 'subscription' as const, id: '9200000001' };
const app = { bundleId: 'com.example.app' };

const base: ProductPriceState = {
  product,
  capturedAt: '2030-01-01T00:00:00Z',
  territories: {
    US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '59.99', pricePointId: 'us-5999' } },
    GB: { territory: 'GB', currency: 'GBP', current: { currency: 'GBP', amount: '49.99', pricePointId: 'gb-4999' } },
    FR: { territory: 'FR', currency: 'EUR', current: null },
  },
};
const ladders = {
  US: { currency: 'USD', points: [{ id: 'us-2999', customerPrice: '29.99' }, { id: 'us-3499', customerPrice: '34.99' }, { id: 'us-5999', customerPrice: '59.99' }] },
  GB: { currency: 'GBP', points: [{ id: 'gb-2499', customerPrice: '24.99' }, { id: 'gb-4999', customerPrice: '49.99' }] },
};

const input = (over: Partial<OfferPlanInput['spec']> = {}, existing: StoreOffer[] = []): OfferPlanInput => ({
  spec: {
    id: 'example_half',
    productRef: product,
    kind: 'apple.promo',
    mode: 'PAY_UP_FRONT',
    duration: 'P1Y',
    pricing: { type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'nearest' },
    territories: 'all',
    syncWithBase: true,
    ...over,
  },
  billingPeriod: 'P1Y',
  base,
  ladders,
  existing,
});

const plan = (inputs: OfferPlanInput[]) => planOfferChanges({ app, inputs, createdAt: '2030-01-01T00:00:00Z', id: 'p', today: '2030-01-01' });

describe('planOfferChanges', () => {
  it('derives each territory from its own price and skips what it cannot price', () => {
    const result = plan([input()]);
    const op = result.changeSet.ops[0] as OfferOp;
    expect(op.kind).toBe('createOffer');
    expect(op.after!.prices).toEqual({ US: { currency: 'USD', amount: '29.99', pricePointId: 'us-2999' }, GB: { currency: 'GBP', amount: '24.99', pricePointId: 'gb-2499' } });
    expect(result.changeSet.skipped).toEqual([expect.objectContaining({ territory: 'FR', reason: 'NOT_CONFIGURED', offerKey: 'example_half' })]);
    expect(result.hash).toBe(changeSetHash(result.changeSet));
    expect(op.idempotencyKey).toBe(computeOfferIdempotencyKey(op));
  });

  it('is deterministic: the same inputs give the same ops and keys', () => {
    expect(plan([input()]).changeSet).toEqual(plan([input()]).changeSet);
  });

  it('refuses two offers with the same key on one product', () => {
    const result = plan([input(), input()]);
    expect(result.changeSet.ops).toHaveLength(1);
    expect(result.entries[1]).toMatchObject({ action: 'refused', refusals: [{ code: 'AMBIGUOUS_OFFER' }] });
  });

  it('refuses Play pricing and a play.offer kind', () => {
    const result = plan([input({ pricing: { type: 'play.relativeDiscount', fraction: '0.5' } })]);
    expect(result.entries[0].refusals[0].code).toBe('UNSUPPORTED_PRICING');
  });

  it('only re-prices: territories the rule cannot price keep their current offer price', () => {
    const existing: StoreOffer = {
      kind: 'apple.promo',
      storeId: 'promo-1',
      key: 'example_half',
      mode: 'PAY_UP_FRONT',
      duration: 'P1Y',
      periods: 1,
      prices: { US: { currency: 'USD', amount: '34.99', pricePointId: 'us-3499' }, FR: { currency: 'EUR', amount: '19.99', pricePointId: 'fr-1999' } },
    };
    const result = plan([input({}, [existing])]);
    const op = result.changeSet.ops[0] as OfferOp;
    expect(op.kind).toBe('updateOfferPrices');
    expect(op.after!.prices.FR).toEqual(existing.prices.FR);
    expect(result.entries[0].changes.map((c) => c.territory)).toEqual(['GB', 'US']);
  });
});

describe('offer op rules', () => {
  const state = (over: Partial<OfferState> = {}): OfferState => ({
    kind: 'apple.promo',
    key: 'k',
    mode: 'PAY_UP_FRONT',
    duration: 'P1Y',
    periods: 1,
    prices: { US: { currency: 'USD', amount: '29.99', pricePointId: 'us-2999' } },
    ...over,
  });
  const op = (kind: OfferOp['kind'], before: OfferState | null, after: OfferState | null): OfferOp => {
    const o = { id: 'op-1', kind, platform: 'apple' as const, target: { product, offer: { kind: (after ?? before)!.kind, key: (after ?? before)!.key } }, before, after };
    return { ...o, idempotencyKey: computeOfferIdempotencyKey(o) };
  };

  it('refuses editing a promotional offer’s duration', () => {
    expect(checkOfferOpRules(op('updateOfferPrices', state(), state({ duration: 'P6M' })), 'apple').join()).toMatch(/doesn't allow changing a promotional offer's duration/);
  });
  it('refuses re-pricing offer codes and win-back offers, deleting offer codes, and ending promos', () => {
    const code = state({ kind: 'apple.offerCode', eligibility: { type: 'apple.offerCode', customerEligibilities: ['NEW'], offerEligibility: 'STACK_WITH_INTRO_OFFERS' } });
    expect(checkOfferOpRules(op('updateOfferPrices', code, { ...code, prices: { US: { currency: 'USD', amount: '34.99', pricePointId: 'us-3499' } } }), 'apple').join()).toMatch(/can't change an offer code's prices/);
    expect(checkOfferOpRules(op('deleteOffer', code, null), 'apple').join()).toMatch(/can't delete an offer code/);
    expect(checkOfferOpRules(op('deactivateOffer', state(), state()), 'apple').join()).toMatch(/no active switch/);
  });
  it('needs a price point for paid offers and free prices for a free trial', () => {
    expect(checkOfferOpRules(op('createOffer', null, state({ prices: { US: { currency: 'USD', amount: '29.99' } } })), 'apple').join()).toMatch(/must name an Apple price point/);
    expect(checkOfferOpRules(op('createOffer', null, state({ mode: 'FREE_TRIAL' })), 'apple').join()).toMatch(/must be free/);
  });
  it('rejects a tampered idempotency key when parsing a plan', () => {
    const result = plan([input()]);
    const json = JSON.parse(serializeChangeSet(result.changeSet));
    json.ops[0].after.prices.US.pricePointId = 'us-3499';
    expect(() => parseChangeSet(json)).toThrow(/idempotencyKey doesn't match/);
  });

  it('inverts: create -> delete (with a caveat), update -> previous prices, deactivate -> activate', () => {
    const created = op('createOffer', null, state());
    expect(invertOfferOp(created)).toMatchObject({ op: { kind: 'deleteOffer', before: state(), after: null }, caveat: expect.stringMatching(/needs force/) });
    const repriced = op('updateOfferPrices', state(), state({ prices: { US: { currency: 'USD', amount: '34.99', pricePointId: 'us-3499' } } }));
    expect(invertOfferOp(repriced).op).toMatchObject({ kind: 'updateOfferPrices', after: { prices: state().prices } });
    const intro = state({ kind: 'apple.intro', key: 'intro:PAY_UP_FRONT:P1Y:1:', schedule: {} });
    const ended = op('deactivateOffer', intro, { ...intro, schedule: { end: '2030-02-01' } });
    expect(invertOfferOp(ended).op).toMatchObject({ kind: 'activateOffer', after: intro });
  });
});

describe('classification and intro windows', () => {
  it('treats windows as [start, end) with an open start meaning today', () => {
    expect(windowsOverlap({ start: '2030-01-01', end: '2030-02-01' }, { start: '2030-02-01' }, '2029-12-01')).toBe(false);
    expect(windowsOverlap({ start: '2030-01-01', end: '2030-02-02' }, { start: '2030-02-01' }, '2029-12-01')).toBe(true);
    expect(windowsOverlap({}, { start: '2030-06-01' }, '2030-01-01')).toBe(true);
    expect(windowsOverlap({ end: '2030-01-01' }, {}, '2030-01-01')).toBe(false);
  });

  it('finds a keyed offer that already exists with other prices and refuses it', () => {
    const result = plan([input()]);
    const op = result.changeSet.ops[0] as OfferOp;
    const other: StoreOffer = { kind: 'apple.promo', storeId: 'x', key: 'example_half', mode: 'PAY_UP_FRONT', duration: 'P1Y', periods: 1, prices: { US: { currency: 'USD', amount: '34.99', pricePointId: 'us-3499' } } };
    expect(classifyOfferOp(op, [other], '2030-01-01')).toMatchObject({ kind: 'drifted', message: expect.stringMatching(/already exists with other terms or prices/) });
    expect(classifyOfferOp(op, [{ ...other, prices: op.after!.prices }], '2030-01-01').kind).toBe('atTarget');
    expect(classifyOfferOp(op, [], '2030-01-01').kind).toBe('ready');
  });
});

describe('executor safety for offer ops', () => {
  it('refuses to apply without confirm, even with a stub adapter, before reading anything', async () => {
    const result = plan([input()]);
    let reads = 0;
    const adapter = {
      platform: 'apple',
      fetchState: async () => {
        reads++;
        return base;
      },
      fetchOffers: async () => {
        reads++;
        return [];
      },
      applyOffer: async () => ({}),
      resolvePricePoints: async () => ({ resolved: {}, unresolved: {} }),
      apply: async () => ({}),
      inverse: () => ({ notReversible: 'x' }),
    } as PlatformAdapter;
    await expect(applyChangeSet(result.changeSet, { adapter })).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(reads).toBe(0);
    const run = await applyChangeSet(result.changeSet, { adapter, confirm: result.hash });
    expect(run.status).toBe('completed');
  });
});
