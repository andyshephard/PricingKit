// AppleAdapter sync from a rules file, against the in-memory offer
// store. The App Store client is mocked: nothing leaves the process.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';
import { appleKeyConnection } from '@/lib/key-token-source';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});

import { AppleAdapter } from '../apple';
import { FakeOfferStore } from './fake-apple-offer-store';
import { applyChangeSet, buildChangeSet, parseOfferRules, type OfferOp, type ProductRef } from '@/lib/pricing';
import { RequestBudget } from '@/lib/utils/request-budget';
import { getSupportedAppleTerritories } from '@/lib/apple-connect/territories';

const credentials: AppleConnectCredentials = { privateKey: 'unused', keyId: 'TESTKEY123', issuerId: '00000000-0000-0000-0000-000000000000', bundleId: 'com.example.app' };
const connection = appleKeyConnection(credentials);
const app = { bundleId: 'com.example.app' };
const A = '9500000001';
const B = '9500000002';
const subA: ProductRef = { platform: 'apple', type: 'subscription', id: A };
const subB: ProductRef = { platform: 'apple', type: 'subscription', id: B };

let store: FakeOfferStore;
beforeEach(() => {
  store = new FakeOfferStore()
    .addSubscription(A, 'ONE_YEAR', { USA: '49.99', GBR: '44.99' }, { USA: ['24.99', '27.99', '49.99', '54.99'], GBR: ['21.99', '22.99', '24.99', '44.99', '49.99'] })
    .addSubscription(B, 'ONE_YEAR', { USA: '39.99' }, { USA: ['19.99', '20.99', '39.99'] });
  // A's promo matches 50%; B's promo is out of step (USA 20.99, the rule gives 19.99); so is A's offer code
  store.seedPromo(A, 'example_annual_50', {}, { USA: '24.99', GBR: '22.99' });
  store.seedPromo(B, 'example_annual_alt_50', {}, { USA: '20.99' });
  store.offers.push({
    id: 'code-1',
    subscriptionId: A,
    type: 'subscriptionOfferCodes',
    attributes: { name: 'CODE50', duration: 'ONE_YEAR', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, active: true, customerEligibilities: ['NEW'], offerEligibility: 'STACK_WITH_INTRO_OFFERS' },
    prices: [{ id: 'cp-1', alpha3: 'USA', pointId: store.point(A, 'USA', '27.99') }],
  });
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation(store.handle);
});

const adapter = () => new AppleAdapter({ ...connection, budget: new RequestBudget(), now: () => new Date('2030-03-01T12:00:00Z') });
const half = { type: 'percentOfCurrent', percent: '50', snap: 'nearest' };
const rules = (extra: object[] = []) =>
  parseOfferRules({
    kind: 'pricingkit.offerRules',
    schemaVersion: 1,
    app,
    offers: [
      { product: subA, kind: 'apple.promo', key: 'example_annual_50', pricing: half, syncWithBase: true },
      { product: subB, kind: 'apple.promo', key: 'example_annual_alt_50', pricing: half, syncWithBase: true },
      { product: subA, kind: 'apple.offerCode', key: 'CODE50', pricing: half, syncWithBase: true },
      ...extra,
    ],
  });

describe('AppleAdapter.planOfferSync', () => {
  it("refuses a rules file for another app and a product outside the session's app", async () => {
    await expect(adapter().planOfferSync({ rules: { ...rules(), app: { bundleId: 'com.example.other' } } })).rejects.toMatchObject({ code: 'APP_MISMATCH' });
    store.addSubscription('9500000009', 'ONE_YEAR', { USA: '9.99' }, { USA: ['4.99'] }, 'group-elsewhere');
    const foreign = parseOfferRules({ kind: 'pricingkit.offerRules', schemaVersion: 1, app, offers: [{ product: { platform: 'apple', type: 'subscription', id: '9500000009' }, kind: 'apple.promo', key: 'x', pricing: half, syncWithBase: true }] });
    await expect(adapter().planOfferSync({ rules: foreign })).rejects.toMatchObject({ code: 'APP_MISMATCH' });
    expect(store.writes()).toEqual([]);
  });

  it('refuses every app when the credentials name none', async () => {
    const noApp = new AppleAdapter({ ...connection, bundleId: '', budget: new RequestBudget() });
    await expect(noApp.planOfferSync({ rules: rules() })).rejects.toMatchObject({ code: 'APP_MISMATCH' });
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('on demand: re-prices the out-of-step promo, lists the offer code for manual action, and the plan applies', async () => {
    const plan = await adapter().planOfferSync({ rules: rules(), id: 'sync' });
    expect(plan.changeSet.ops.map((op) => [op.kind, (op as OfferOp).target.offer.key])).toEqual([['updateOfferPrices', 'example_annual_alt_50']]);
    expect(plan.manualActions).toEqual([expect.objectContaining({ code: 'PRICES_IMMUTABLE', offer: { kind: 'apple.offerCode', key: 'CODE50' }, territories: ['US'] })]);
    expect(store.writes()).toEqual([]);

    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(run.status).toBe('completed');
    const promo = store.offers.find((o) => o.attributes.offerCode === 'example_annual_alt_50')!;
    expect(promo.prices.map((p) => store.points.get(p.pointId!)!.customerPrice)).toEqual(['19.99']);
    // The offer code was never touched
    expect(store.writes()).toEqual([`PATCH /subscriptionPromotionalOffers/${promo.id}`]);
  });

  it("with a base plan: derives against the plan's target prices and puts the base ops first", async () => {
    const a = adapter();
    const state = await a.fetchState(subA);
    const base = buildChangeSet({
      app,
      products: [{ state, targets: { US: { currency: 'USD', amount: '54.99', pricePointId: store.point(A, 'USA', '54.99') }, GB: { currency: 'GBP', amount: '49.99', pricePointId: store.point(A, 'GBR', '49.99') } } }],
      createdAt: '2030-03-01T12:00:00Z',
    });
    const reads = appleApiRequest.mock.calls.filter(([, path]) => String(path).endsWith(`/subscriptions/${A}/prices`)).length;
    const plan = await a.planOfferSync({ rules: rules(), base, states: [state] });
    // The base plan's state was reused, not read again
    expect(appleApiRequest.mock.calls.filter(([, path]) => String(path).endsWith(`/subscriptions/${A}/prices`)).length).toBe(reads);
    expect(plan.changeSet.ops.map((op) => op.kind)).toEqual(['setPrice', 'setPrice', 'updateOfferPrices', 'updateOfferPrices']);
    const promoA = plan.changeSet.ops.find((op) => (op as OfferOp).target.offer?.key === 'example_annual_50') as OfferOp;
    // 50% of the new 54.99 / 49.99, not of today's 49.99 / 44.99
    expect(promoA.after!.prices.US.amount).toBe('27.99');
    expect(promoA.after!.prices.GB.amount).toBe('24.99');
    expect(promoA.dependsOn).toEqual(['op-0001', 'op-0002']);
    // B has no base change: re-derived against its current price, with nothing to wait for
    const promoB = plan.changeSet.ops.find((op) => (op as OfferOp).target.offer?.key === 'example_annual_alt_50') as OfferOp;
    expect(promoB.dependsOn).toBeUndefined();
    // The offer code (27.99) is out of step today but matches 50% of the new 54.99: nothing to do once the base ships
    expect(plan.entries.find((e) => e.key === 'CODE50')).toMatchObject({ action: 'none', pricedAgainst: 'planTargets' });
    expect(plan.manualActions).toEqual([]);
    expect(store.writes()).toEqual([]);
  });
});

describe('requests spent reading a rules file', () => {
  const pricePointReads = () => appleApiRequest.mock.calls.filter(([, path]) => String(path).endsWith('/pricePoints'));

  it('reads no price points for missing or free-trial offers, and sync skips products without syncWithBase rules', async () => {
    store.seedIntro(B, 'USA', { offerMode: 'FREE_TRIAL', duration: 'ONE_WEEK' }, null);
    const r = parseOfferRules({
      kind: 'pricingkit.offerRules',
      schemaVersion: 1,
      app,
      offers: [
        { product: subA, kind: 'apple.promo', key: 'example_annual_50', pricing: half, syncWithBase: false },
        { product: subB, kind: 'apple.promo', key: 'no_such_offer', pricing: half, syncWithBase: true },
        { product: subB, kind: 'apple.intro', key: 'intro:FREE_TRIAL:ONE_WEEK:1::', pricing: half, syncWithBase: true },
      ],
    });
    const plan = await adapter().planOfferSync({ rules: r });
    expect(plan.entries.map((e) => [e.key, e.action, e.manual?.code])).toEqual([
      ['example_annual_50', 'notSynced', undefined],
      ['no_such_offer', 'manual', 'OFFER_NOT_FOUND'],
      ['intro:FREE_TRIAL:ONE_WEEK:1::', 'manual', 'RULE_NOT_APPLICABLE'],
    ]);
    // A has only a syncWithBase: false rule: not read at all; B has nothing priceable: no price points
    expect(appleApiRequest.mock.calls.some(([, path]) => String(path).includes(A))).toBe(false);
    expect(pricePointReads()).toEqual([]);
  });

  it("reads price points only for the offer's territories; sync never adds a base territory the offer lacks", async () => {
    store.offers = store.offers.filter((o) => o.subscriptionId !== A);
    store.seedPromo(A, 'example_annual_50', {}, { USA: '24.99' }); // no GBR price
    const plan = await adapter().planOfferSync({
      rules: parseOfferRules({ kind: 'pricingkit.offerRules', schemaVersion: 1, app, offers: [{ product: subA, kind: 'apple.promo', key: 'example_annual_50', pricing: half, syncWithBase: true }] }),
    });
    expect(pricePointReads().map(([, , options]) => (options as { queryParams: Record<string, string> }).queryParams['filter[territory]'])).toEqual(['USA']);
    expect(plan.changeSet.ops).toEqual([]);
    expect(plan.entries[0]).toMatchObject({ action: 'none', changes: [] });
  });

  it('one subscription in 175 territories: on-demand sync sends 25 requests', async () => {
    const territories = getSupportedAppleTerritories();
    expect(territories).toHaveLength(175);
    const big = new FakeOfferStore().addTerritories(territories);
    const SUB = '9500000175';
    big.addSubscription(
      SUB,
      'ONE_YEAR',
      Object.fromEntries(territories.map((t) => [t.alpha3, '9.99'])),
      Object.fromEntries(territories.map((t) => [t.alpha3, ['4.99', '9.99']]))
    );
    big.seedPromo(SUB, 'example_annual_50', {}, Object.fromEntries(territories.map((t) => [t.alpha3, '4.99'])));
    appleApiRequest.mockImplementation(big.handle);
    const r = parseOfferRules({
      kind: 'pricingkit.offerRules',
      schemaVersion: 1,
      app,
      offers: [{ product: { platform: 'apple', type: 'subscription', id: SUB }, kind: 'apple.promo', key: 'example_annual_50', pricing: half, syncWithBase: true }],
    });

    const syncBudget = new RequestBudget();
    const plan = await new AppleAdapter({ ...connection, budget: syncBudget, now: () => new Date('2030-03-01T12:00:00Z') }).planOfferSync({ rules: r });
    expect(plan.changeSet.ops).toEqual([]);
    expect(plan.entries[0]).toMatchObject({ action: 'none' });
    // 3 app ownership + 1 billing period + 1 base prices + 2 offer list and prices + 18 price point reads (10 territories each)
    expect(pricePointReads()).toHaveLength(18);
    expect(syncBudget.used).toBe(25);
    expect(big.writes()).toEqual([]);
  });
});
