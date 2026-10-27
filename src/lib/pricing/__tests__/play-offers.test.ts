import { describe, it, expect } from 'vitest';
import {
  checkChangeSetRules,
  checkPlayOfferOpRules,
  classifyPlayOfferOp,
  computePlayOfferIdempotencyKey,
  createRun,
  derivePlayPhasePrices,
  invertPlayOfferOp,
  parseChangeSet,
  parseRun,
  planPlayOfferChanges,
  samePlayDuration,
  serializeRun,
  type ChangeSet,
  type OfferSpec,
  type PlayOfferOp,
  type PlayOfferState,
  type ProductPriceState,
  type ProductRef,
  type StoreOffer,
} from '..';

const product: ProductRef = { platform: 'google', type: 'subscription', productId: 'com.example.pro', basePlanId: 'annual' };
const app = { packageName: 'com.example.app' };

function state(over: Partial<PlayOfferState> = {}): PlayOfferState {
  return {
    kind: 'play.offer',
    key: 'annual-half-off',
    state: 'ACTIVE',
    phases: [{ duration: 'P1Y', recurrenceCount: 1, regions: { US: { type: 'relativeDiscount', fraction: '0.5' }, GB: { type: 'relativeDiscount', fraction: '0.5' } } }],
    targeting: { type: 'developerDetermined' },
    tags: ['rc-customer-center', 'rc-ignore-offer'],
    regions: { US: { newSubscriberAvailability: true }, GB: { newSubscriberAvailability: true } },
    ...over,
  };
}

function op(kind: PlayOfferOp['kind'], before: PlayOfferState | null, after: PlayOfferState | null, extra: Partial<PlayOfferOp> = {}): PlayOfferOp {
  const o = { id: 'op-0001', kind, platform: 'google' as const, target: { product, offer: { kind: 'play.offer' as const, key: (after ?? before)!.key } }, before, after, regionsVersion: '2025/03', ...extra };
  return { ...o, idempotencyKey: computePlayOfferIdempotencyKey(o) };
}

function store(s: PlayOfferState, problems?: string[]): StoreOffer {
  return {
    kind: 'play.offer',
    storeId: `com.example.pro/annual/${s.key}`,
    key: s.key,
    mode: null,
    duration: null,
    prices: {},
    ...(problems ? { problems } : {}),
    play: { productId: 'com.example.pro', basePlanId: 'annual', offer: s },
  };
}

const base: ProductPriceState = {
  product,
  capturedAt: '2030-01-01T00:00:00Z',
  territories: {
    US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '59.99' }, availability: 'AVAILABLE' },
    GB: { territory: 'GB', currency: 'GBP', current: { currency: 'GBP', amount: '49.99' }, availability: 'NO_NEW_SUBSCRIBERS' },
    JP: { territory: 'JP', currency: 'JPY', current: { currency: 'JPY', amount: '9800' } },
  },
};

describe('Play offer op rules', () => {
  it('accepts the ops of a valid lifecycle', () => {
    expect(checkPlayOfferOpRules(op('createOffer', null, state()), 'google')).toEqual([]);
    expect(checkPlayOfferOpRules(op('deactivateOffer', state(), state({ state: 'INACTIVE' })), 'google')).toEqual([]);
    expect(checkPlayOfferOpRules(op('activateOffer', state({ state: 'DRAFT' }), state()), 'google')).toEqual([]);
    expect(checkPlayOfferOpRules(op('deleteOffer', state({ state: 'DRAFT' }), null), 'google')).toEqual([]);
    const repriced = state({ phases: [{ ...state().phases[0], regions: { US: { type: 'relativeDiscount', fraction: '0.4' }, GB: { type: 'relativeDiscount', fraction: '0.5' } } }] });
    expect(checkPlayOfferOpRules(op('updateOfferPrices', state(), repriced), 'google')).toEqual([]);
  });

  it("refuses what Play doesn't allow or the plan can't express", () => {
    const problems = (o: PlayOfferOp, platform: 'apple' | 'google' = 'google') => checkPlayOfferOpRules(o, platform).join('\n');
    expect(problems(op('deleteOffer', state(), null))).toMatch(/deletes only draft offers/);
    expect(problems(op('createOffer', null, state({ state: 'INACTIVE' })))).toMatch(/can't be created INACTIVE/);
    expect(problems(op('createOffer', null, state(), { regionsVersion: undefined }))).toMatch(/needs regionsVersion/);
    expect(problems(op('updateOfferPrices', state(), state({ tags: ['rc-customer-center'] })))).toMatch(/changes phase prices only/);
    expect(problems(op('updateOffer', state(), state({ state: 'INACTIVE', tags: [] })))).toMatch(/doesn't change the offer's state/);
    expect(problems(op('deactivateOffer', state({ state: 'DRAFT' }), state({ state: 'INACTIVE' })))).toMatch(/goes from ACTIVE to INACTIVE/);
    expect(problems(op('createOffer', null, state({ regions: { US: { newSubscriberAvailability: true } } })))).toMatch(/must price exactly the offer's regions/);
    expect(problems(op('createOffer', null, state({ key: 'Bad_Id' })))).toMatch(/lower-case letters, digits and hyphens/);
    expect(problems(op('createOffer', null, state()), 'apple')).toMatch(/Play offer op in a change set for an apple app/);
    expect(problems({ ...op('createOffer', null, state()), idempotencyKey: 'x' })).toMatch(/idempotencyKey doesn't match/);
  });

  it('round-trips through a plan file and a run log, and stays out of Apple plans', () => {
    const changeSet: ChangeSet = { schemaVersion: 1, kind: 'pricingkit.changeset', id: 'p', createdAt: '2030-01-01T00:00:00Z', app, ops: [op('createOffer', null, state())] };
    expect(parseChangeSet(JSON.stringify(changeSet))).toEqual(changeSet);
    expect(checkChangeSetRules({ ...changeSet, app: { bundleId: 'com.example.app' } }).join()).toMatch(/Play offer op in a change set for an apple app/);
    const run = createRun(changeSet, { now: '2030-01-01T00:00:00Z' });
    run.ops[0].observedOffer = state();
    expect(parseRun(serializeRun(run)).ops[0].observedOffer).toEqual(state());
  });
});

describe('classifying a Play offer op against what Play holds', () => {
  it('create: ready when missing, done when it matches, activation-only for a matching draft, drift otherwise', () => {
    const create = op('createOffer', null, state());
    expect(classifyPlayOfferOp(create, []).kind).toBe('ready');
    expect(classifyPlayOfferOp(create, [store(state())]).kind).toBe('atTarget');
    expect(classifyPlayOfferOp(create, [store(state({ state: 'DRAFT' }))])).toMatchObject({ kind: 'ready', pending: ['activate'] });
    expect(classifyPlayOfferOp(create, [store(state({ tags: [] }))])).toMatchObject({ kind: 'drifted', message: expect.stringMatching(/already exists/) });
    expect(classifyPlayOfferOp(create, [store(state({ state: 'INACTIVE' }))]).kind).toBe('drifted');
    expect(classifyPlayOfferOp(create, [store(state(), ['unknown field x'])])).toMatchObject({ kind: 'drifted', message: expect.stringMatching(/can't be read unambiguously/) });
    expect(classifyPlayOfferOp(create, [store(state()), store(state())]).kind).toBe('drifted');
    // An offer with this ID on another base plan is not this one
    expect(classifyPlayOfferOp(create, [{ ...store(state()), play: { productId: 'com.example.pro', basePlanId: 'monthly', offer: state() } }]).kind).toBe('ready');
  });

  it('state changes and deletes', () => {
    const deactivate = op('deactivateOffer', state(), state({ state: 'INACTIVE' }));
    expect(classifyPlayOfferOp(deactivate, [store(state())]).kind).toBe('ready');
    expect(classifyPlayOfferOp(deactivate, [store(state({ state: 'INACTIVE' }))]).kind).toBe('atTarget');
    expect(classifyPlayOfferOp(deactivate, []).kind).toBe('drifted');
    const del = op('deleteOffer', state({ state: 'DRAFT' }), null);
    expect(classifyPlayOfferOp(del, []).kind).toBe('atTarget');
    expect(classifyPlayOfferOp(del, [store(state({ state: 'DRAFT' }))]).kind).toBe('ready');
    expect(classifyPlayOfferOp(del, [store(state())]).kind).toBe('drifted');
  });
});

describe('undoing Play offer ops', () => {
  it('maps every op to the op that restores it, with what it cannot restore', () => {
    expect(invertPlayOfferOp(op('createOffer', null, state()))).toMatchObject({ op: { kind: 'deactivateOffer', after: { state: 'INACTIVE' } }, caveat: expect.stringMatching(/only draft offers/) });
    expect(invertPlayOfferOp(op('createOffer', null, state({ state: 'DRAFT' })))).toMatchObject({ op: { kind: 'deleteOffer' } });
    expect(invertPlayOfferOp(op('createOffer', null, state()), { activated: false })).toMatchObject({ op: { kind: 'deleteOffer', before: { state: 'DRAFT' } } });
    expect(invertPlayOfferOp(op('activateOffer', state({ state: 'INACTIVE' }), state()))).toMatchObject({ op: { kind: 'deactivateOffer', after: { state: 'INACTIVE' } } });
    expect(invertPlayOfferOp(op('activateOffer', state({ state: 'DRAFT' }), state())).caveat).toMatch(/can't return to draft/);
    expect(invertPlayOfferOp(op('deactivateOffer', state(), state({ state: 'INACTIVE' })))).toMatchObject({ op: { kind: 'activateOffer', after: { state: 'ACTIVE' } } });
    const tags = invertPlayOfferOp(op('updateOffer', state(), state({ tags: [] })));
    expect(tags.op).toMatchObject({ kind: 'updateOffer', before: { tags: [] }, after: { tags: ['rc-customer-center', 'rc-ignore-offer'] }, regionsVersion: '2025/03' });
    expect(invertPlayOfferOp(op('deleteOffer', state({ state: 'DRAFT' }), null))).toMatchObject({ op: { kind: 'createOffer', after: { state: 'DRAFT' } } });
    expect(invertPlayOfferOp(op('deleteOffer', state({ state: 'DRAFT' }), null, { regionsVersion: undefined })).notReversible).toMatch(/no regionsVersion/);
  });
});

describe('Play phase prices per region', () => {
  const phase = { duration: 'P1Y', recurrenceCount: 1 };
  it('estimates relative discounts and absolute discounts, and checks fixed prices against the base', () => {
    const relative = derivePlayPhasePrices({ pricing: { type: 'play.relativeDiscount', fraction: '0.5' }, phase, billingPeriod: 'P1Y', base, territories: 'all' });
    expect(relative.map((r) => [r.region, r.offerPrice, r.discount, r.newSubscriberAvailability])).toEqual([
      ['GB', '25', '24.99', false],
      ['JP', '4900', '4900', true],
      ['US', '30', '29.99', true],
    ]);
    const absolute = derivePlayPhasePrices({ pricing: { type: 'play.absoluteDiscount', amounts: { US: '10', GB: '60' } }, phase, billingPeriod: 'P1Y', base, territories: 'all' });
    expect(absolute.find((r) => r.region === 'US')).toMatchObject({ ok: true, offerPrice: '49.99', config: { type: 'absoluteDiscount', currency: 'USD', amount: '10' } });
    expect(absolute.find((r) => r.region === 'GB')!.flags[0].code).toBe('DISCOUNT_TOO_LARGE');
    const fixed = derivePlayPhasePrices({ pricing: { type: 'fixed', prices: { US: '29.99', GB: '59.99' } }, phase, billingPeriod: 'P1Y', base, territories: 'all' });
    expect(fixed.find((r) => r.region === 'US')).toMatchObject({ ok: true, discount: '30' });
    expect(fixed.find((r) => r.region === 'GB')!.flags[0].code).toBe('NOT_BELOW_CURRENT');
  });

  it("prices percent-of-current with Play's own prices, prorated over the phase", () => {
    // A 1-year phase on a monthly base plan: 12 x price x 50%
    const monthly: ProductPriceState = { ...base, territories: { US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '5.99' } } } };
    const rows = derivePlayPhasePrices({
      pricing: { type: 'percentOfCurrent', percent: '50', snap: 'nearest' },
      phase,
      billingPeriod: 'P1M',
      base: monthly,
      territories: 'all',
      snapped: { resolved: { US: { currency: 'USD', amount: '35.99' } }, unresolved: {} },
    });
    expect(rows[0]).toMatchObject({ ok: true, proratedBase: '71.88', exactTarget: '35.94', offerPrice: '35.99', deviation: '0.05', config: { type: 'price', amount: '35.99' } });
    const unresolved = derivePlayPhasePrices({ pricing: { type: 'percentOfCurrent', percent: '50', snap: 'nearest' }, phase, billingPeriod: 'P1M', base: monthly, territories: 'all', snapped: { resolved: {}, unresolved: { US: 'Play returned no usable price' } } });
    expect(unresolved[0].flags[0]).toMatchObject({ code: 'NO_PLAY_PRICE', message: 'Play returned no usable price' });
    // Weeks against months: no exact ratio
    const weeks = derivePlayPhasePrices({ pricing: { type: 'percentOfCurrent', percent: '50', snap: 'nearest' }, phase: { duration: 'P1W', recurrenceCount: 1 }, billingPeriod: 'P1M', base: monthly, territories: 'all' });
    expect(weeks[0].flags.map((f) => f.code)).toContain('SPAN_NOT_COMPARABLE');
    expect(weeks[0].ok).toBe(false);
    expect(samePlayDuration('P1W', 'P7D')).toBe(true);
    expect(samePlayDuration('P1Y', 'P12M')).toBe(true);
  });
});

describe('planning Play offers (pure)', () => {
  const spec: OfferSpec = {
    id: 'annual-half-off',
    kind: 'play.offer',
    productRef: product,
    mode: 'PAY_UP_FRONT',
    duration: 'P1Y',
    pricing: { type: 'play.relativeDiscount', fraction: '0.5' },
    eligibility: { type: 'play.targeting', rule: { type: 'developerDetermined' } },
    tags: ['rc-ignore-offer', 'rc-customer-center'],
    territories: 'all',
    syncWithBase: false,
  };
  const input = { spec, billingPeriod: 'P1Y', base, existing: [] as StoreOffer[], regionsVersion: '2025/03' };

  it('creates the offer in every base plan region, following the base plan’s availability', () => {
    const plan = planPlayOfferChanges({ app, inputs: [input], createdAt: '2030-01-01T00:00:00Z' });
    const created = plan.changeSet.ops[0] as PlayOfferOp;
    expect(created.after!.regions).toEqual({ GB: { newSubscriberAvailability: false }, JP: { newSubscriberAvailability: true }, US: { newSubscriberAvailability: true } });
    expect(created.after!.tags).toEqual(['rc-customer-center', 'rc-ignore-offer']);
    expect(plan.entries[0].warnings.join()).toMatch(/GB: the base plan is closed to new subscribers/);
    expect(plan.entries[0].play!.changes.map((c) => c.region)).toEqual(['GB', 'JP', 'US']);
  });

  it('refuses without a regions version, without eligibility, and a two-phase offer it would have to restructure', () => {
    const noVersion = planPlayOfferChanges({ app, inputs: [{ ...input, regionsVersion: undefined }] });
    expect(noVersion.entries[0].refusals[0]).toMatchObject({ code: 'MISSING_SETTINGS', message: expect.stringMatching(/regionsVersion/) });
    const noEligibility = planPlayOfferChanges({ app, inputs: [{ ...input, spec: { ...spec, eligibility: undefined } }] });
    expect(noEligibility.entries[0].refusals[0].code).toBe('MISSING_SETTINGS');
    const twoPhases = state({ phases: [{ duration: 'P1W', recurrenceCount: 1, regions: { US: { type: 'free' }, GB: { type: 'free' } } }, state().phases[0]] });
    const refused = planPlayOfferChanges({ app, inputs: [{ ...input, existing: [store(twoPhases)] }] });
    expect(refused.entries[0].refusals[0].code).toBe('TERMS_IMMUTABLE');
    expect(refused.changeSet.ops).toEqual([]);
  });
});
