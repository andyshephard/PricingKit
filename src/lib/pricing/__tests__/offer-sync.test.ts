// The sync engine: rules files, re-deriving offers against a plan's target
// base prices, manual actions, scheduled base prices, the combined drift
// report and the executor's base-first ordering. Invented products and prices.
import { describe, it, expect } from 'vitest';
import {
  applyChangeSet,
  buildChangeSet,
  buildUndoChangeSet,
  changeSetHash as changeSetHashOf,
  checkChangeSetRules,
  checkRulesDrift,
  InvalidOfferRulesError,
  parseChangeSet,
  parseOfferRules,
  planOfferSync,
  projectBasePrices,
  serializeChangeSet,
  type ApplyRun,
  type ChangeSet,
  type OfferApplyContext,
  type OfferOp,
  type OfferRule,
  type OfferSyncProduct,
  type ProductPriceState,
  type StoreOffer,
  type TargetPrice,
} from '..';
import { FakeStore } from './fixtures/fake-store';
import { RequestBudget } from '@/lib/utils/request-budget';

const app = { bundleId: 'com.example.app' };
const product = { platform: 'apple' as const, type: 'subscription' as const, id: '9400000001' };
const other = { platform: 'apple' as const, type: 'subscription' as const, id: '9400000002' };

const price = (currency: string, amount: string, id: string) => ({ currency, amount, pricePointId: id });

function baseState(over: Partial<Record<string, ProductPriceState['territories'][string]>> = {}): ProductPriceState {
  return {
    product,
    capturedAt: '2030-01-01T00:00:00Z',
    territories: {
      US: { territory: 'US', currency: 'USD', current: price('USD', '59.99', 'us-5999') },
      GB: { territory: 'GB', currency: 'GBP', current: price('GBP', '49.99', 'gb-4999') },
      ...over,
    } as ProductPriceState['territories'],
  };
}

const ladders = {
  US: {
    currency: 'USD',
    points: ['29.99', '34.99', '59.99', '69.99'].map((p) => ({ id: `us-${p.replace('.', '')}`, customerPrice: p })),
  },
  GB: {
    currency: 'GBP',
    points: ['24.99', '27.99', '49.99', '54.99'].map((p) => ({ id: `gb-${p.replace('.', '')}`, customerPrice: p })),
  },
};

/** A 1-year pay-up-front offer at 50% of the current annual prices (US 29.99, GB 24.99) */
function offer(kind: StoreOffer['kind'], key: string, prices: Record<string, [string, string, string]> = { US: ['USD', '29.99', 'us-2999'], GB: ['GBP', '24.99', 'gb-2499'] }): StoreOffer {
  return {
    kind,
    storeId: `${kind}-${key}`,
    key,
    name: key,
    mode: 'PAY_UP_FRONT',
    duration: 'P1Y',
    periods: 1,
    prices: Object.fromEntries(Object.entries(prices).map(([t, [c, a, id]]) => [t, price(c, a, id)])),
  };
}

const rule = (over: Partial<OfferRule> = {}): OfferRule => ({
  product,
  kind: 'apple.promo',
  key: 'example_half',
  pricing: { type: 'percentOfCurrent', percent: '50', snap: 'nearest' },
  syncWithBase: true,
  ...over,
});

function productData(offers: StoreOffer[], base = baseState()): OfferSyncProduct {
  return { product, billingPeriod: 'P1Y', base, ladders, offers };
}

/** A base-price plan raising US to 69.99 (and GB to 54.99 unless left out) */
function basePlan(options: { gb?: boolean; startDate?: string; state?: ProductPriceState } = {}): ChangeSet {
  const targets: Record<string, TargetPrice> = { US: { currency: 'USD', amount: '69.99', pricePointId: 'us-6999', ...(options.startDate ? { startDate: options.startDate } : {}) } };
  if (options.gb !== false) targets.GB = { currency: 'GBP', amount: '54.99', pricePointId: 'gb-5499', ...(options.startDate ? { startDate: options.startDate } : {}) };
  return buildChangeSet({ app, products: [{ state: options.state ?? baseState(), targets }], createdAt: '2030-01-01T00:00:00Z' });
}

const sync = (rules: OfferRule[], offers: StoreOffer[], extra: Partial<Parameters<typeof planOfferSync>[0]> = {}) =>
  planOfferSync({ app, rules, products: [productData(offers)], createdAt: '2030-01-01T00:00:00Z', id: 'sync', ...extra });

const validRules = {
  kind: 'pricingkit.offerRules',
  schemaVersion: 1,
  app,
  offers: [{ product, kind: 'apple.promo', key: 'example_half', pricing: { type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'nearest' }, syncWithBase: true }],
};

describe('parseOfferRules', () => {
  it('accepts a rules file; the basis may be left to the offer', () => {
    const rules = parseOfferRules(JSON.stringify(validRules));
    expect(rules.offers[0].pricing).toEqual({ type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'nearest' });
    const noBasis = structuredClone(validRules) as { offers: Array<{ pricing: Record<string, unknown> }> };
    delete noBasis.offers[0].pricing.basis;
    expect((parseOfferRules(noBasis).offers[0].pricing as { basis?: string }).basis).toBeUndefined();
  });

  it('refuses Play rules in an App Store file, duplicates, bad percents and thresholds', () => {
    const bad = structuredClone(validRules) as Record<string, unknown> & { offers: Array<Record<string, unknown>> };
    bad.offers.push({ ...bad.offers[0] });
    bad.offers.push({ ...bad.offers[0], key: 'x', pricing: { type: 'percentOfCurrent', percent: '150', snap: 'nearest' } });
    bad.offers.push({ ...bad.offers[0], key: 'y', deviationThreshold: '2' });
    bad.offers.push({ ...bad.offers[0], key: 'z', kind: 'play.offer', product: { platform: 'google', type: 'subscription', productId: 'pro', basePlanId: 'annual' } });
    try {
      parseOfferRules(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidOfferRulesError);
      const problems = (error as InvalidOfferRulesError).problems.join('\n');
      expect(problems).toMatch(/offers\.1: the same offer is also offers\.0/);
      expect(problems).toMatch(/offers\.2\.pricing: percent: percent must be above 0 and below 100/);
      expect(problems).toMatch(/offers\.3\.deviationThreshold/);
      expect(problems).toMatch(/offers\.4: an App Store app \(bundleId\) has Apple offer rules only/);
    }
    expect(() => parseOfferRules({ ...validRules, app: { packageName: 'com.example.app' } })).toThrow(/a Google Play app \(packageName\) has play\.offer rules only/);
    expect(() => parseOfferRules({ ...validRules, offers: [{ ...validRules.offers[0], extra: 1 }] })).toThrow(InvalidOfferRulesError);
    expect(() => parseOfferRules({ ...validRules, offers: [{ ...validRules.offers[0], syncWithBase: undefined }] })).toThrow(/syncWithBase/);
  });

  it('never quotes the file when it is not JSON', () => {
    expect(() => parseOfferRules('{"secret": "abc"')).toThrow(/^Invalid offer rules file:\n- not valid JSON$/);
  });
});

describe('projectBasePrices', () => {
  it("applies setPrice ops' targets; scheduled ones only when derived now", () => {
    const plan = basePlan({ gb: false });
    expect(projectBasePrices(baseState(), plan.ops as never).territories.US.current).toEqual(price('USD', '69.99', 'us-6999'));
    const scheduled = basePlan({ gb: false, startDate: '2030-06-01' });
    expect(projectBasePrices(baseState(), scheduled.ops as never, 'hold').territories.US.current?.amount).toBe('59.99');
    expect(projectBasePrices(baseState(), scheduled.ops as never, 'deriveNow').territories.US.current).toEqual(price('USD', '69.99', 'us-6999'));
  });
});

describe('planOfferSync', () => {
  it("re-derives against the plan's target base prices, not the current ones, and ships base and offer ops together", () => {
    const base = basePlan();
    const result = sync([rule()], [offer('apple.promo', 'example_half')], { base });
    const ops = result.changeSet.ops;
    expect(ops.map((op) => op.kind)).toEqual(['setPrice', 'setPrice', 'updateOfferPrices']);
    // Base ops keep their IDs and come first
    expect(ops.slice(0, 2)).toEqual(base.ops);
    const offerOp = ops[2] as OfferOp;
    // 50% of the new 69.99 / 54.99 (34.99 / 27.99), not of today's 59.99 / 49.99 (29.99 / 24.99, the offer's current price)
    expect(offerOp.after!.prices).toEqual({ US: price('USD', '34.99', 'us-3499'), GB: price('GBP', '27.99', 'gb-2799') });
    expect(offerOp.before!.prices.US.amount).toBe('29.99');
    expect(offerOp.dependsOn).toEqual(['op-0001', 'op-0002']);
    expect(result.entries[0]).toMatchObject({ action: 'updatePrices', pricedAgainst: 'planTargets', opId: 'op-0003' });
    expect(result.manualActions).toEqual([]);
    // A valid, reviewable plan file that round-trips
    expect(parseChangeSet(serializeChangeSet(result.changeSet))).toEqual(result.changeSet);
  });

  it('on demand (no base plan) re-prices only a drifted offer, against current prices', () => {
    const inSync = sync([rule()], [offer('apple.promo', 'example_half')]);
    expect(inSync.changeSet.ops).toEqual([]);
    expect(inSync.entries[0]).toMatchObject({ action: 'none', pricedAgainst: 'currentPrices' });

    const drifted = sync([rule()], [offer('apple.promo', 'example_half', { US: ['USD', '34.99', 'us-3499'], GB: ['GBP', '24.99', 'gb-2499'] })]);
    const op = drifted.changeSet.ops[0] as OfferOp;
    expect(op.kind).toBe('updateOfferPrices');
    expect(op.dependsOn).toBeUndefined();
    expect(drifted.entries[0].changes).toEqual([{ territory: 'US', before: price('USD', '34.99', 'us-3499'), after: price('USD', '29.99', 'us-2999') }]);
  });

  it('lists offers whose prices are immutable as manual actions and never deletes or re-creates them', () => {
    const rules = [rule({ kind: 'apple.offerCode', key: 'CODE50' }), rule({ kind: 'apple.winBack', key: 'winback_50' })];
    const result = sync(rules, [offer('apple.offerCode', 'CODE50'), offer('apple.winBack', 'winback_50')], { base: basePlan() });
    expect(result.changeSet.ops.map((op) => op.kind)).toEqual(['setPrice', 'setPrice']);
    expect(result.manualActions.map((m) => [m.offer.kind, m.code, m.territories])).toEqual([
      ['apple.offerCode', 'PRICES_IMMUTABLE', ['GB', 'US']],
      ['apple.winBack', 'PRICES_IMMUTABLE', ['GB', 'US']],
    ]);
    expect(result.manualActions[0].message).toMatch(/create a new offer code.*deactivate this one.*never deletes or re-creates/);
    expect(result.changeSet.manualActions).toEqual(result.manualActions);
    // An immutable offer still in step needs nothing
    expect(sync(rules, [offer('apple.offerCode', 'CODE50'), offer('apple.winBack', 'winback_50')]).manualActions).toEqual([]);
  });

  it('reports offers it cannot handle instead of guessing, and leaves syncWithBase: false alone', () => {
    const trial: StoreOffer = { ...offer('apple.promo', 'trial'), mode: 'FREE_TRIAL', prices: { US: { currency: 'USD', amount: '0', free: true } } };
    const unreadable: StoreOffer = { ...offer('apple.promo', 'broken'), territoryProblems: { GB: 'price has no price point' } };
    const result = sync(
      [rule({ key: 'missing' }), rule({ key: 'trial' }), rule({ key: 'broken' }), rule({ key: 'example_half', syncWithBase: false })],
      [trial, unreadable, offer('apple.promo', 'example_half', { US: ['USD', '34.99', 'us-3499'] })]
    );
    expect(result.entries.map((e) => [e.key, e.action, e.manual?.code])).toEqual([
      ['missing', 'manual', 'OFFER_NOT_FOUND'],
      ['trial', 'manual', 'RULE_NOT_APPLICABLE'],
      ['broken', 'manual', 'OFFER_UNREADABLE'],
      ['example_half', 'notSynced', undefined],
    ]);
    expect(result.changeSet.ops).toEqual([]);
  });

  it('a territory the rule cannot price keeps its offer price and is listed as skipped', () => {
    const base = baseState({ GB: { territory: 'GB', currency: 'GBP', current: price('GBP', '49.99', 'gb-4999'), problems: { current: 'two prices' } } });
    const result = planOfferSync({
      app,
      rules: [rule()],
      products: [productData([offer('apple.promo', 'example_half', { US: ['USD', '34.99', 'us-3499'], GB: ['GBP', '24.99', 'gb-2499'] })], base)],
      createdAt: '2030-01-01T00:00:00Z',
    });
    const op = result.changeSet.ops[0] as OfferOp;
    expect(op.after!.prices.GB).toEqual(price('GBP', '24.99', 'gb-2499'));
    expect(result.changeSet.skipped).toEqual([expect.objectContaining({ territory: 'GB', reason: 'AMBIGUOUS_STATE', offerKey: 'example_half' })]);
  });

  describe('scheduled base prices', () => {
    it('hold (default): no offer op, a manual action to sync on or after the date', () => {
      const result = sync([rule()], [offer('apple.promo', 'example_half')], { base: basePlan({ startDate: '2030-06-01' }) });
      expect(result.changeSet.ops.map((op) => op.kind)).toEqual(['schedulePrice', 'schedulePrice']);
      expect(result.manualActions).toEqual([
        expect.objectContaining({ code: 'BASE_SCHEDULED', territories: ['GB', 'US'], message: expect.stringMatching(/on or after 2030-06-01.*--scheduled-base now/) }),
      ]);
    });

    it('hold with immediate and scheduled changes: re-prices the immediate territories now and holds only the scheduled ones', () => {
      const base = buildChangeSet({
        app,
        products: [
          {
            state: baseState(),
            targets: {
              US: { currency: 'USD', amount: '69.99', pricePointId: 'us-6999' },
              GB: { currency: 'GBP', amount: '54.99', pricePointId: 'gb-5499', startDate: '2030-06-01' },
            },
          },
        ],
        createdAt: '2030-01-01T00:00:00Z',
      });
      const usOp = base.ops.find((op) => op.kind === 'setPrice' && 'territory' in op.target && op.target.territory === 'US')!;
      const result = sync([rule()], [offer('apple.promo', 'example_half')], { base });
      const op = result.changeSet.ops.find((o) => o.kind === 'updateOfferPrices') as OfferOp;
      expect(op.after!.prices.US).toEqual(price('USD', '34.99', 'us-3499')); // 50% of the immediate 69.99
      expect(op.after!.prices.GB).toEqual(price('GBP', '24.99', 'gb-2499')); // held at its current price
      expect(op.dependsOn).toEqual([usOp.id]); // not the scheduled GB op
      expect(result.manualActions).toEqual([
        expect.objectContaining({ code: 'BASE_SCHEDULED', territories: ['GB'], message: expect.stringMatching(/\(GB\) from 2030-06-01.*the others are re-priced in this plan/) }),
      ]);
      expect(result.entries[0]).toMatchObject({ action: 'updatePrices', manual: { code: 'BASE_SCHEDULED' } });
      expect(result.changeSet.warnings).toContainEqual({ opId: op.id, message: expect.stringMatching(/GB keeps its offer price/) });
    });

    it('deriveNow: re-derives against the scheduled prices, with a warning that the offer changes first', () => {
      const result = sync([rule()], [offer('apple.promo', 'example_half')], { base: basePlan({ startDate: '2030-06-01' }), scheduledBase: 'deriveNow' });
      const op = result.changeSet.ops[2] as OfferOp;
      expect(op.after!.prices.US.amount).toBe('34.99');
      expect(op.dependsOn).toEqual(['op-0001', 'op-0002']);
      expect(result.changeSet.warnings).toContainEqual({ opId: op.id, message: expect.stringMatching(/apply as soon as this plan is applied, before the base prices change/) });
    });

    it('warns when the store already holds a scheduled base price the offer will drift from', () => {
      const base = baseState({
        GB: { territory: 'GB', currency: 'GBP', current: price('GBP', '49.99', 'gb-4999'), scheduled: { ...price('GBP', '54.99', 'gb-5499'), startDate: '2030-09-01' } },
      });
      const result = planOfferSync({
        app,
        rules: [rule()],
        products: [productData([offer('apple.promo', 'example_half', { US: ['USD', '34.99', 'us-3499'], GB: ['GBP', '24.99', 'gb-2499'] })], base)],
        createdAt: '2030-01-01T00:00:00Z',
      });
      expect(result.entries[0].warnings).toContainEqual(expect.stringMatching(/1 of this offer's territories already have a scheduled base price \(from 2030-09-01\)/));
    });
  });

  it('refuses a base plan for another app or one that already has offer ops', () => {
    const base = basePlan();
    expect(() => sync([rule()], [offer('apple.promo', 'example_half')], { base: { ...base, app: { bundleId: 'com.example.other' } } })).toThrow(/another app/);
    const withOffer = sync([rule()], [offer('apple.promo', 'example_half')], { base }).changeSet;
    expect(() => sync([rule()], [offer('apple.promo', 'example_half')], { base: withOffer })).toThrow(/already has offer ops/);
  });
});

describe('dependsOn validation', () => {
  const plan = () => sync([rule()], [offer('apple.promo', 'example_half')], { base: basePlan() }).changeSet;
  const withDeps = (deps: string[]) => {
    const cs = plan();
    (cs.ops[2] as OfferOp).dependsOn = deps;
    return checkChangeSetRules(cs);
  };
  it('names base-price ops of the same product in the plan', () => {
    expect(checkChangeSetRules(plan())).toEqual([]);
    expect(withDeps(['op-0009'])).toContainEqual(expect.stringMatching(/dependsOn names op-0009, which isn't in the plan/));
    expect(withDeps(['op-0003'])).toContainEqual(expect.stringMatching(/an offer op/));
    expect(withDeps(['op-0001', 'op-0001'])).toContainEqual(expect.stringMatching(/lists an op twice/));
    const cs = plan();
    cs.ops[0] = { ...cs.ops[0], target: { ...cs.ops[0].target, product: other } } as never;
    (cs.ops[0] as { idempotencyKey: string }).idempotencyKey = `setPrice|apple:subscription:${other.id}|US|USD 69.99 us-6999 `;
    expect(checkChangeSetRules(cs)).toContainEqual(expect.stringMatching(/an op on another product/));
  });
});

describe('checkRulesDrift', () => {
  it('reports every offer in the rules file in one document', () => {
    const report = checkRulesDrift({
      app,
      rules: [rule(), rule({ key: 'drifted' }), rule({ key: 'missing' }), rule({ key: 'trial', syncWithBase: false })],
      products: [
        productData([
          offer('apple.promo', 'example_half'),
          offer('apple.promo', 'drifted', { US: ['USD', '34.99', 'us-3499'], GB: ['GBP', '24.99', 'gb-2499'] }),
          { ...offer('apple.promo', 'trial'), mode: 'FREE_TRIAL', prices: { US: { currency: 'USD', amount: '0', free: true } } },
        ]),
      ],
      now: '2030-01-01T00:00:00Z',
    });
    expect(report).toMatchObject({ kind: 'pricingkit.rulesDrift', schemaVersion: 1, inSync: false, summary: { offers: 4, inSync: 1, drifted: 1, notFound: 1, errors: 1 } });
    expect(report.offers.map((o) => [o.key, o.status])).toEqual([
      ['example_half', 'inSync'],
      ['drifted', 'drifted'],
      ['missing', 'notFound'],
      ['trial', 'error'],
    ]);
    expect(report.offers[1].report!.territories.find((t) => t.territory === 'US')).toMatchObject({ status: 'mismatch' });
    expect(report.offers[3].error).toMatchObject({ code: 'OFFER_RULE', message: expect.stringMatching(/free trial/) });
    expect(report.notChecked).toBeUndefined();
  });

  it('a rules file whose offers all match is in sync', () => {
    const report = checkRulesDrift({ app, rules: [rule()], products: [productData([offer('apple.promo', 'example_half')])] });
    expect(report.inSync).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Executor: base-price ops first, offer ops only once their base ops are done

class SyncStore extends FakeStore {
  offers: StoreOffer[];
  offerWrites = 0;
  /** Fail this many offer writes (nothing written), then succeed */
  offerFailures = 0;
  constructor(state: ProductPriceState, offers: StoreOffer[], budget?: RequestBudget) {
    super('apple', [state], budget);
    this.offers = structuredClone(offers);
  }
  async fetchOffers(): Promise<StoreOffer[]> {
    return structuredClone(this.offers);
  }
  async applyOffer(op: OfferOp, _context: OfferApplyContext): Promise<Record<string, unknown>> {
    if (this.offerFailures > 0) {
      this.offerFailures--;
      throw Object.assign(new Error('Server error'), { status: 500 });
    }
    this.offerWrites++;
    this.writes.push(`offer:${op.target.offer.key}`);
    const target = this.offers.find((o) => o.key === op.target.offer.key)!;
    target.prices = structuredClone(op.after!.prices);
    return {};
  }
}

describe('applying a sync plan', () => {
  const setup = () => {
    const plan = sync([rule()], [offer('apple.promo', 'example_half')], { base: basePlan() });
    const store = new SyncStore(baseState(), [offer('apple.promo', 'example_half')]);
    return { plan, store };
  };
  /** The base op's ID for a territory (ops are numbered by territory: GB op-0001, US op-0002) */
  const US = 'op-0002';
  const GB = 'op-0001';

  it('applies the base prices before the offer prices', async () => {
    const { plan, store } = setup();
    const run = await applyChangeSet(plan.changeSet, { adapter: store, confirm: plan.hash, concurrency: 4 });
    expect(run.status).toBe('completed');
    expect(store.writes.at(-1)).toBe('offer:example_half');
    expect(store.writes.slice(0, 2).sort()).toEqual(['setPrice:GB', 'setPrice:US']);
    expect(store.offers[0].prices.US.amount).toBe('34.99');
  });

  it("doesn't apply an offer op whose base op failed, and applies it on resume once the base op is done", async () => {
    const { plan, store } = setup();
    store.failures.set('US', { times: 1, error: () => Object.assign(new Error('Server error'), { status: 500 }) });
    let saved: ApplyRun | undefined;
    const first = await applyChangeSet(plan.changeSet, { adapter: store, confirm: plan.hash, onUpdate: (r) => void (saved = r) });
    expect(first.status).toBe('incomplete');
    const byId = Object.fromEntries(first.ops.map((r) => [r.opId, r]));
    expect(byId[US]).toMatchObject({ status: 'failed' });
    expect(byId[GB]).toMatchObject({ status: 'ok' });
    expect(byId['op-0003']).toMatchObject({ status: 'failed', attempts: 0, error: { code: 'BASE_NOT_APPLIED', message: expect.stringMatching(/op-0002 failed.*Nothing was sent/) } });
    expect(store.offerWrites).toBe(0);
    expect(store.offers[0].prices.US.amount).toBe('29.99');

    const resumed = await applyChangeSet(plan.changeSet, { adapter: store, confirm: plan.hash, run: saved });
    expect(resumed.status).toBe('completed');
    expect(store.offerWrites).toBe(1);
    expect(store.offers[0].prices.US.amount).toBe('34.99');
  });

  it('a base op that drifted since planning (STATE_CHANGED) also holds back its offer op', async () => {
    const { plan } = setup();
    const moved = baseState({ US: { territory: 'US', currency: 'USD', current: price('USD', '34.99', 'us-3499') } });
    const store = new SyncStore(moved, [offer('apple.promo', 'example_half')]);
    const run = await applyChangeSet(plan.changeSet, { adapter: store, confirm: plan.hash });
    expect(run.ops.find((r) => r.opId === US)).toMatchObject({ status: 'failed', error: { code: 'STATE_CHANGED' } });
    expect(run.ops.find((r) => r.opId === 'op-0003')).toMatchObject({ status: 'failed', error: { code: 'BASE_NOT_APPLIED' } });
    expect(store.offerWrites).toBe(0);
  });

  it('a base op already at its target counts as done', async () => {
    const { plan } = setup();
    const raised = baseState({ US: { territory: 'US', currency: 'USD', current: price('USD', '69.99', 'us-6999') } });
    const store = new SyncStore(raised, [offer('apple.promo', 'example_half')]);
    const run = await applyChangeSet(plan.changeSet, { adapter: store, confirm: plan.hash });
    expect(run.status).toBe('completed');
    expect(run.ops.find((r) => r.opId === US)).toMatchObject({ status: 'skipped', skipReason: 'ALREADY_AT_TARGET' });
    expect(store.offerWrites).toBe(1);
  });

  it("on resume, an offer op whose failed base op wasn't retried in this pass stays as it was (no fresh BASE_NOT_APPLIED)", async () => {
    const plan = sync([rule()], [offer('apple.promo', 'example_half')], { base: basePlan() });
    const firstStore = new SyncStore(baseState(), [offer('apple.promo', 'example_half')]);
    firstStore.failures.set('US', { times: 1, error: () => Object.assign(new Error('Server error'), { status: 500 }) });
    const first = await applyChangeSet(plan.changeSet, { adapter: firstStore, confirm: plan.hash, now: () => '2030-01-01T00:00:00Z' });
    expect(first.ops.find((r) => r.opId === US)).toMatchObject({ status: 'failed', error: { status: 500 } });
    const before = first.ops.find((r) => r.opId === 'op-0003')!;
    expect(before.error?.code).toBe('BASE_NOT_APPLIED');

    // The resume reads the product (1 request), but the budget can't cover the US write: it isn't retried
    const budget = new RequestBudget({ limit: 2 });
    const store = new SyncStore(firstStore.state(product), firstStore.offers, budget);
    store.costPerOp = 5;
    const resumed = await applyChangeSet(plan.changeSet, { adapter: store, confirm: plan.hash, run: first, budget, now: () => '2030-01-02T00:00:00Z' });
    expect(resumed.stoppedReason).toBe('BUDGET_EXCEEDED');
    expect(resumed.ops.find((r) => r.opId === US)).toMatchObject({ status: 'failed', attempts: 1 });
    // Not re-judged in this pass: same record as the first pass left it
    expect(resumed.ops.find((r) => r.opId === 'op-0003')).toEqual(before);
    expect(store.offerWrites).toBe(0);
  });
});

describe('undoing a sync run', () => {
  async function appliedSync() {
    const plan = sync([rule()], [offer('apple.promo', 'example_half')], { base: basePlan() });
    const store = new SyncStore(baseState(), [offer('apple.promo', 'example_half')]);
    const run = await applyChangeSet(plan.changeSet, { adapter: store, confirm: plan.hash });
    expect(run.status).toBe('completed');
    store.writes.length = 0;
    return { plan, store, run, undo: buildUndoChangeSet(plan.changeSet, run, { createdAt: '2030-01-02T00:00:00Z' }) };
  }

  it('reverts the offer first; the base-price reverts wait for it', async () => {
    const { store, undo } = await appliedSync();
    const offerRevert = undo.ops.find((op) => op.kind === 'updateOfferPrices')!;
    const baseReverts = undo.ops.filter((op) => op.kind === 'setPrice');
    expect(baseReverts).toHaveLength(2);
    for (const op of baseReverts) expect(op.dependsOn).toEqual([offerRevert.id]);
    expect(offerRevert.dependsOn).toBeUndefined();
    expect(parseChangeSet(serializeChangeSet(undo))).toEqual(undo);

    const run = await applyChangeSet(undo, { adapter: store, confirm: changeSetHashOf(undo), concurrency: 4 });
    expect(run.status).toBe('completed');
    expect(store.writes[0]).toBe('offer:example_half');
    expect(store.writes.slice(1).sort()).toEqual(['setPrice:GB', 'setPrice:US']);
    expect(store.offers[0].prices.US.amount).toBe('29.99');
    expect(store.state(product).territories.US.current?.amount).toBe('59.99');
  });

  it('holds back the base-price reverts when the offer revert fails, and finishes on resume', async () => {
    const { store, undo } = await appliedSync();
    store.offerFailures = 1;
    let saved: ApplyRun | undefined;
    const first = await applyChangeSet(undo, { adapter: store, confirm: changeSetHashOf(undo), onUpdate: (r) => void (saved = r) });
    expect(first.status).toBe('incomplete');
    const offerRevert = undo.ops.find((op) => op.kind === 'updateOfferPrices')!;
    for (const record of first.ops) {
      if (record.opId === offerRevert.id) expect(record).toMatchObject({ status: 'failed', attempts: 1 });
      else expect(record).toMatchObject({ status: 'failed', attempts: 0, error: { code: 'OFFER_NOT_APPLIED' } });
    }
    // Nothing reverted: base prices stay where the offer was priced from
    expect(store.writes).toEqual([]);
    expect(store.state(product).territories.US.current?.amount).toBe('69.99');

    const resumed = await applyChangeSet(undo, { adapter: store, confirm: changeSetHashOf(undo), run: saved });
    expect(resumed.status).toBe('completed');
    expect(store.writes[0]).toBe('offer:example_half');
    expect(store.state(product).territories.US.current?.amount).toBe('59.99');
  });

  it('dependsOn changes the plan hash, so a reviewer confirms the order too', async () => {
    const { undo } = await appliedSync();
    const flat = structuredClone(undo);
    for (const op of flat.ops) delete op.dependsOn;
    expect(changeSetHashOf(flat)).not.toBe(changeSetHashOf(undo));
  });
});
