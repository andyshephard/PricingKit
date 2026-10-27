import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';
import { appleKeyConnection } from '@/lib/token-source';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return {
    ...actual,
    appleApiRequest: (...args: unknown[]) => appleApiRequest(...args),
    getAppIdForBundleId: vi.fn(async () => {
      throw new Error('not expected');
    }),
  };
});

import { AppleAdapter } from '../apple';
import { FakeOfferStore } from './fake-apple-offer-store';
import {
  applyChangeSet,
  buildUndoChangeSet,
  ConfirmationRequiredError,
  introOfferKey,
  parseChangeSet,
  parseOfferPlanSpec,
  parseRun,
  serializeChangeSet,
  serializeRun,
  summarizeRun,
  type ApplyRun,
  type OfferOp,
  type OfferSpec,
  type ProductRef,
} from '@/lib/pricing';
import { RequestBudget } from '@/lib/utils/request-budget';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.app',
};
const connection = appleKeyConnection(credentials);
const app = { bundleId: 'com.example.app' };
const ANNUAL = '9100000001';
const ANNUAL_ALT = '9100000002';
const annual: ProductRef = { platform: 'apple', type: 'subscription', id: ANNUAL, productId: 'com.example.app.pro.annual' };
const annualAlt: ProductRef = { platform: 'apple', type: 'subscription', id: ANNUAL_ALT, productId: 'com.example.app.pro.annual.alt' };
const NOW = new Date('2030-03-01T12:00:00Z');

let store: FakeOfferStore;
beforeEach(() => {
  store = new FakeOfferStore()
    .addSubscription(
      ANNUAL,
      'ONE_YEAR',
      { USA: '49.99', GBR: '44.99', DEU: '49.99', JPN: '7800' },
      { USA: ['19.99', '24.99', '25.99', '49.99'], GBR: ['21.99', '22.99', '44.99'], DEU: ['24.99', '25.99', '49.99'], JPN: ['3800', '3900', '7800'] }
    )
    .addSubscription(ANNUAL_ALT, 'ONE_YEAR', { USA: '39.99', GBR: '34.99' }, { USA: ['19.99', '20.99', '39.99'], GBR: ['16.99', '17.99', '34.99'] });
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation(store.handle);
});

const adapter = (budget?: RequestBudget) => new AppleAdapter({ ...connection, budget: budget ?? new RequestBudget(), now: () => NOW });

/** 50% of each territory's own annual price, 1 year, paid up front */
const halfOffAnnual = (product: ProductRef, code: string): OfferSpec => ({
  id: code,
  name: `Half off ${code}`,
  productRef: product,
  kind: 'apple.promo',
  mode: 'PAY_UP_FRONT',
  duration: 'P1Y',
  pricing: { type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'nearest' },
  territories: 'all',
  syncWithBase: true,
});

const promoPrices = (subId: string, code: string) => {
  const offer = store.offers.find((o) => o.subscriptionId === subId && o.attributes.offerCode === code);
  return offer ? Object.fromEntries(offer.prices.map((p) => [p.alpha3, store.points.get(p.pointId!)!.customerPrice])) : undefined;
};

async function planBoth() {
  const spec = parseOfferPlanSpec({
    kind: 'pricingkit.offerPlanSpec',
    schemaVersion: 1,
    app,
    offers: [halfOffAnnual(annual, 'example_annual_50'), halfOffAnnual(annualAlt, 'example_annual_alt_50')],
  });
  return adapter().planOffers({ app: spec.app, offers: spec.offers, createdAt: '2030-03-01T12:00:00Z', id: 'plan-both' });
}

describe('offer plans (dry run)', () => {
  it('one call plans a 50% 1-year pay-up-front promo for two annual products, each with its own code, reading only', async () => {
    const plan = await planBoth();
    expect(store.writes()).toEqual([]);
    expect(plan.entries.map((e) => [e.product.platform === 'apple' && e.product.id, e.key, e.action])).toEqual([
      [ANNUAL, 'example_annual_50', 'create'],
      [ANNUAL_ALT, 'example_annual_alt_50', 'create'],
    ]);
    const [a, b] = plan.changeSet.ops as OfferOp[];
    expect(Object.fromEntries(Object.entries(a.after!.prices).map(([t, p]) => [t, p.amount]))).toEqual({ US: '24.99', GB: '22.99', DE: '24.99', JP: '3900' });
    expect(a.after!.prices.US.pricePointId).toBe(store.point(ANNUAL, 'USA', '24.99'));
    expect(Object.fromEntries(Object.entries(b.after!.prices).map(([t, p]) => [t, p.amount]))).toEqual({ US: '19.99', GB: '17.99' });
    // The preview carries the derivation rows: current price, exact target, snapped price, deviation
    const gb = plan.entries[0].derivation!.rows.find((r) => r.territory === 'GB')!;
    expect(gb).toMatchObject({ currentPrice: '44.99', exactTarget: '22.495', snappedPrice: '22.99', ok: true });
    // The plan is an ordinary reviewable file
    expect(parseChangeSet(serializeChangeSet(plan.changeSet))).toEqual(plan.changeSet);
  });

  it('refuses the same promo code on two products (Apple needs it unique across the group)', () => {
    expect(() =>
      parseOfferPlanSpec({ kind: 'pricingkit.offerPlanSpec', schemaVersion: 1, app, offers: [halfOffAnnual(annual, 'same'), halfOffAnnual(annualAlt, 'same')] })
    ).toThrow(/unique across a subscription group/);
  });

  it('refuses a plan for another app than the session', async () => {
    await expect(adapter().planOffers({ app: { bundleId: 'com.example.other' }, offers: [halfOffAnnual(annual, 'x')] })).rejects.toMatchObject({ code: 'APP_MISMATCH' });
  });
});

describe('applying offer plans', () => {
  it('needs the plan hash as confirm, and sends nothing without it', async () => {
    const plan = await planBoth();
    const calls = appleApiRequest.mock.calls.length;
    await expect(applyChangeSet(plan.changeSet, { adapter: adapter() })).rejects.toBeInstanceOf(ConfirmationRequiredError);
    await expect(applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: 'not-the-hash' })).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(appleApiRequest.mock.calls.length).toBe(calls);
  });

  it('creates both offers, verifies them, and applying twice changes nothing', async () => {
    const plan = await planBoth();
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, verify: true });
    expect(run.status).toBe('completed');
    expect(run.ops.map((r) => [r.status, r.verified])).toEqual([
      ['ok', true],
      ['ok', true],
    ]);
    expect(store.writes()).toEqual(['POST /subscriptionPromotionalOffers', 'POST /subscriptionPromotionalOffers']);
    expect(promoPrices(ANNUAL, 'example_annual_50')).toEqual({ USA: '24.99', GBR: '22.99', DEU: '24.99', JPN: '3900' });
    expect(parseRun(serializeRun(run))).toEqual(run);

    const writes = store.writes().length;
    const again = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(again.ops.map((r) => [r.status, r.skipReason])).toEqual([
      ['skipped', 'ALREADY_AT_TARGET'],
      ['skipped', 'ALREADY_AT_TARGET'],
    ]);
    expect(store.writes()).toHaveLength(writes);
    // Re-planning finds nothing to do
    const replan = await planBoth();
    expect(replan.changeSet.ops).toEqual([]);
    expect(replan.entries.map((e) => e.action)).toEqual(['none', 'none']);
  });

  it('a create that took effect but answered 5xx is found by its code on resume, not sent again', async () => {
    const plan = await planBoth();
    store.failures.push({ method: 'POST', path: /^\/subscriptionPromotionalOffers$/, status: 504, afterWrite: true });
    let saved: ApplyRun | undefined;
    const first = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, concurrency: 1, onUpdate: (r) => void (saved = r) });
    expect(first.status).toBe('incomplete');
    expect(first.ops[0]).toMatchObject({ status: 'failed', attempts: 1, error: { status: 504 } });
    expect(first.ops[1].status).toBe('ok');
    expect(store.offers).toHaveLength(2); // the "failed" create exists

    const resumed = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, run: parseRun(serializeRun(saved!)) });
    expect(resumed.status).toBe('completed');
    expect(resumed.ops[0]).toMatchObject({ status: 'ok', response: { confirmedOnResume: true } });
    expect(store.writes().filter((w) => w.startsWith('POST'))).toHaveLength(2);
    expect(store.offers).toHaveLength(2);
  });

  it('a create that answered 500 having created nothing is created once on resume (seen on a real account)', async () => {
    const plan = await planBoth();
    store.failures.push({ method: 'POST', path: /^\/subscriptionPromotionalOffers$/, status: 500 });
    let saved: ApplyRun | undefined;
    const first = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, concurrency: 1, onUpdate: (r) => void (saved = r) });
    expect(first.ops[0]).toMatchObject({ status: 'failed', attempts: 1, error: { status: 500 } });
    expect(store.offers).toHaveLength(1); // nothing was created for the failed op

    const resumed = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, run: parseRun(serializeRun(saved!)) });
    expect(resumed.status).toBe('completed');
    expect(resumed.ops[0]).toMatchObject({ status: 'ok', attempts: 2 });
    expect(resumed.ops[0].response?.confirmedOnResume).toBeUndefined();
    // Three POSTs in all: the refused one, the other product's, and exactly one on resume
    expect(store.writes().filter((w) => w.startsWith('POST'))).toHaveLength(3);
    expect(store.offers.filter((o) => o.subscriptionId === ANNUAL)).toHaveLength(1);
  });

  it('undo deletes the created offers only with force, and says what it cannot undo', async () => {
    const plan = await planBoth();
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    const undo = buildUndoChangeSet(plan.changeSet, run, { createdAt: '2030-03-02T00:00:00Z' });
    expect(undo.ops.map((op) => op.kind)).toEqual(['deleteOffer', 'deleteOffer']);
    expect(undo.notReversible?.[0].reason).toMatch(/redemptions/);

    const blocked = await applyChangeSet(undo, { adapter: adapter(), confirm: (await import('@/lib/pricing')).changeSetHash(undo) });
    expect(blocked.ops.map((r) => r.error?.code)).toEqual(['REDEMPTIONS_UNCHECKED', 'REDEMPTIONS_UNCHECKED']);
    expect(store.writes().filter((w) => w.startsWith('DELETE'))).toEqual([]);

    const hash = (await import('@/lib/pricing')).changeSetHash(undo);
    const forced = await applyChangeSet(undo, { adapter: adapter(), confirm: hash, run: blocked, force: { deleteOffers: true } });
    expect(forced.status).toBe('completed');
    expect(store.offers).toEqual([]);
  });

  it("won't start an op the request budget can't cover", async () => {
    const plan = await planBoth();
    // Reads: app checks (app, its groups, each subscription's group) = 4, offers of both
    // products (4 lists each, no prices yet) = 8; then one POST each
    const budget = new RequestBudget({ limit: 13 });
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(budget), confirm: plan.hash, budget, concurrency: 1 });
    expect(run.status).toBe('incomplete');
    expect(run.stoppedReason).toBe('BUDGET_EXCEEDED');
    expect(summarizeRun(run)).toMatchObject({ ok: 1, pending: 1 });
    expect(store.writes()).toHaveLength(1);
  });
});

describe('re-pricing a promotional offer', () => {
  it('replaces only the drifted territories, keeping the others by price ID; applying twice changes nothing', async () => {
    const seeded = store.seedPromo(ANNUAL, 'example_annual_50', { name: 'Half' }, { USA: '24.99', GBR: '21.99', DEU: '25.99', JPN: '3900' });
    const keptIds = seeded.prices.filter((p) => p.alpha3 === 'USA' || p.alpha3 === 'JPN').map((p) => p.id);
    const plan = await adapter().planOffers({ app, offers: [halfOffAnnual(annual, 'example_annual_50')] });
    expect(plan.entries[0].action).toBe('updatePrices');
    expect(plan.entries[0].changes.map((c) => [c.territory, c.before?.amount, c.after.amount])).toEqual([
      ['DE', '25.99', '24.99'],
      ['GB', '21.99', '22.99'],
    ]);
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(run.ops[0]).toMatchObject({ status: 'ok', response: { kept: 2, replaced: 2 } });
    const patch = store.calls.find((c) => c.method === 'PATCH')!.body as { data: { relationships: { prices: { data: Array<{ id: string }> } } } };
    expect(patch.data.relationships.prices.data.map((p) => p.id)).toEqual(expect.arrayContaining([...keptIds, '${price-DEU}', '${price-GBR}']));
    expect(promoPrices(ANNUAL, 'example_annual_50')).toEqual({ USA: '24.99', GBR: '22.99', DEU: '24.99', JPN: '3900' });

    const again = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(again.ops[0].status).toBe('skipped');
    expect(store.writes()).toEqual(['PATCH /subscriptionPromotionalOffers/' + seeded.id]);

    // Undo puts the old prices back
    const undo = buildUndoChangeSet(plan.changeSet, run);
    const { changeSetHash } = await import('@/lib/pricing');
    await applyChangeSet(undo, { adapter: adapter(), confirm: changeSetHash(undo) });
    expect(promoPrices(ANNUAL, 'example_annual_50')).toEqual({ USA: '24.99', GBR: '21.99', DEU: '25.99', JPN: '3900' });
  });

  it('explains Apple refusing the new prices', async () => {
    store.seedPromo(ANNUAL, 'example_annual_50', {}, { USA: '24.99', GBR: '21.99' });
    const plan = await adapter().planOffers({ app, offers: [halfOffAnnual(annual, 'example_annual_50')] });
    store.failures.push({ method: 'PATCH', path: /^\/subscriptionPromotionalOffers\//, status: 409 });
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(run.ops[0].error?.message).toMatch(/Apple refused to change the prices of the promotional offer "example_annual_50".*duration, mode and number of periods can't be edited/);
  });
});

describe('refusals before anything is sent', () => {
  it('refuses changing an existing promotional offer’s duration', async () => {
    store.seedPromo(ANNUAL, 'example_annual_50', { duration: 'SIX_MONTHS' }, { USA: '24.99' });
    const plan = await adapter().planOffers({ app, offers: [halfOffAnnual(annual, 'example_annual_50')] });
    expect(plan.changeSet.ops).toEqual([]);
    expect(plan.entries[0].refusals[0]).toMatchObject({ code: 'TERMS_IMMUTABLE', message: expect.stringMatching(/doesn't allow changing an existing offer's duration/) });
  });

  it('refuses an eleventh promotional offer', async () => {
    for (let i = 0; i < 10; i++) store.seedPromo(ANNUAL, `example_${i}`, {}, { USA: '24.99' });
    const plan = await adapter().planOffers({ app, offers: [halfOffAnnual(annual, 'example_new')] });
    expect(plan.entries[0].refusals[0]).toMatchObject({ code: 'PROMO_OFFER_CAP' });
    expect(plan.changeSet.ops).toEqual([]);
  });

  it('a create refused by Apple says why (e.g. the cap, or a code used elsewhere in the group)', async () => {
    const plan = await planBoth();
    store.failures.push({ method: 'POST', path: /^\/subscriptionPromotionalOffers$/, status: 409, times: 2 });
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(run.ops[0].error?.message).toMatch(/at most 10 promotional offers.*unique across its subscription group/);
    expect(run.ops[0].error?.status).toBe(409);
  });
});

describe('introductory offers', () => {
  const freeWeek: OfferSpec = {
    id: 'trial',
    productRef: annual,
    kind: 'apple.intro',
    mode: 'FREE_TRIAL',
    duration: 'P1W',
    pricing: { type: 'free' },
    territories: 'all',
    schedule: { start: '2030-04-01' },
    syncWithBase: false,
  };

  it('creates one resource per territory (free trial: no price point), skipping territories with an overlapping offer', async () => {
    store.seedIntro(ANNUAL, 'GBR', { duration: 'ONE_MONTH', offerMode: 'FREE_TRIAL', startDate: null, endDate: null }, null);
    const plan = await adapter().planOffers({ app, offers: [freeWeek] });
    expect(plan.changeSet.skipped).toEqual([expect.objectContaining({ territory: 'GB', reason: 'OFFER_CONFLICT', detail: expect.stringMatching(/one introductory offer per territory/) })]);
    const op = plan.changeSet.ops[0] as OfferOp;
    expect(op.target.offer.key).toBe(introOfferKey({ mode: 'FREE_TRIAL', duration: 'P1W', start: '2030-04-01' }));
    expect(Object.keys(op.after!.prices)).toEqual(['DE', 'JP', 'US']);

    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, verify: true });
    expect(run.ops[0]).toMatchObject({ status: 'ok', verified: true });
    const posts = store.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(3);
    for (const post of posts) expect((post.body as { data: { relationships: object } }).data.relationships).not.toHaveProperty('subscriptionPricePoint');
  });

  it('a run stopped part-way resumes with only the missing territories', async () => {
    const plan = await adapter().planOffers({ app, offers: [freeWeek] });
    // The first create (DE) succeeds, the second fails
    let n = 0;
    appleApiRequest.mockImplementation(async (c: unknown, endpoint: string, options: Record<string, unknown> = {}) => {
      if (options.method === 'POST' && ++n === 2) {
        const { AppleApiError } = await import('@/lib/apple-connect/client');
        throw new AppleApiError(500, 'UNEXPECTED_ERROR', 'Error', 'down');
      }
      return store.handle(c, endpoint, options);
    });
    const first = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(first.ops[0]).toMatchObject({ status: 'failed', error: { message: expect.stringMatching(/after 1 of 4 territories were written \(DE\).*Resume/) } });
    expect(store.intros.map((i) => i.alpha3)).toEqual(['DEU']);

    appleApiRequest.mockImplementation(store.handle);
    const resumed = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, run: first });
    expect(resumed.status).toBe('completed');
    expect(store.intros.map((i) => i.alpha3).sort()).toEqual(['DEU', 'GBR', 'JPN', 'USA']);
    expect(store.calls.filter((c) => c.method === 'POST').length).toBe(4); // DE once, never re-sent

    // Ending it sets the end date on every territory; undo restores it
    const end = await adapter().planOfferLifecycle({ app, product: annual, kind: 'apple.intro', key: introOfferKey({ mode: 'FREE_TRIAL', duration: 'P1W', start: '2030-04-01' }), action: 'deactivate', endDate: '2030-05-01' });
    const ended = await applyChangeSet(end.changeSet, { adapter: adapter(), confirm: end.hash });
    expect(ended.status).toBe('completed');
    expect(store.intros.every((i) => i.attributes.endDate === '2030-05-01')).toBe(true);
    const undo = buildUndoChangeSet(end.changeSet, ended);
    const { changeSetHash } = await import('@/lib/pricing');
    await applyChangeSet(undo, { adapter: adapter(), confirm: changeSetHash(undo) });
    expect(store.intros.every((i) => i.attributes.endDate === null)).toBe(true);
  });

  it('budgets every territory of an intro create before starting it', async () => {
    const plan = await adapter().planOffers({ app, offers: [freeWeek] });
    const budget = new RequestBudget({ limit: 3 + 4 + 3 }); // 3 app checks + 4 offer list reads + 3 of the 4 creates
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(budget), confirm: plan.hash, budget });
    expect(run.stoppedReason).toBe('BUDGET_EXCEEDED');
    expect(run.ops[0].status).toBe('pending');
    expect(store.intros).toEqual([]);
  });
});

describe('offer codes and win-back offers', () => {
  it('creates an offer code, deactivates it, and refuses to delete it', async () => {
    const spec: OfferSpec = {
      id: 'EXAMPLE-SPRING',
      productRef: annual,
      kind: 'apple.offerCode',
      mode: 'PAY_UP_FRONT',
      duration: 'P1Y',
      pricing: { type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'nearest' },
      eligibility: { type: 'apple.offerCode', customerEligibilities: ['NEW', 'EXPIRED'], offerEligibility: 'STACK_WITH_INTRO_OFFERS' },
      territories: ['US', 'GB'],
      syncWithBase: false,
    };
    const plan = await adapter().planOffers({ app, offers: [spec] });
    await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(store.offers[0]).toMatchObject({ type: 'subscriptionOfferCodes', attributes: { name: 'EXAMPLE-SPRING', active: true } });

    const off = await adapter().planOfferLifecycle({ app, product: annual, kind: 'apple.offerCode', key: 'EXAMPLE-SPRING', action: 'deactivate' });
    const run = await applyChangeSet(off.changeSet, { adapter: adapter(), confirm: off.hash });
    expect(run.status).toBe('completed');
    expect(store.offers[0].attributes.active).toBe(false);
    await expect(adapter().planOfferLifecycle({ app, product: annual, kind: 'apple.offerCode', key: 'EXAMPLE-SPRING', action: 'delete' })).rejects.toThrow(/can't delete an offer code/);

    // Undo of the create deactivates (codes can't be deleted) and says redeemed codes stay redeemed
    const undo = buildUndoChangeSet(plan.changeSet, (await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash })) as ApplyRun);
    expect(undo.ops).toEqual([]); // the second run changed nothing, so there is nothing to undo
    const created = buildUndoChangeSet(plan.changeSet, { ...run, changeSetId: plan.changeSet.id, changeSetHash: plan.hash, ops: [{ ...run.ops[0], opId: 'op-0001', idempotencyKey: plan.changeSet.ops[0].idempotencyKey, status: 'ok' }] });
    expect(created.ops.map((o) => o.kind)).toEqual(['deactivateOffer']);
    expect(created.notReversible?.[0].reason).toMatch(/already redeemed keep their offer/);

    // A different price for an existing offer code is refused: Apple can't re-price codes
    const repriced = await adapter().planOffers({ app, offers: [{ ...spec, pricing: { ...spec.pricing, percent: '40' } as OfferSpec['pricing'] }] });
    expect(repriced.entries[0].refusals[0]).toMatchObject({ code: 'PRICES_IMMUTABLE' });
  });

  it('creates, ends and deletes a win-back offer', async () => {
    const spec: OfferSpec = {
      id: 'example_winback',
      name: 'Come back',
      productRef: annual,
      kind: 'apple.winBack',
      mode: 'PAY_UP_FRONT',
      duration: 'P1Y',
      pricing: { type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'nearest' },
      eligibility: { type: 'apple.winBack', paidSubscriptionDurationInMonths: 3, timeSinceLastSubscribedInMonths: { minimum: 1, maximum: 12 } },
      schedule: { start: '2030-04-01' },
      apple: { priority: 'HIGH' },
      territories: ['US'],
      syncWithBase: false,
    };
    const plan = await adapter().planOffers({ app, offers: [spec] });
    await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(store.offers[0]).toMatchObject({ type: 'winBackOffers', attributes: { offerId: 'example_winback', referenceName: 'Come back', priority: 'HIGH', startDate: '2030-04-01' } });

    const end = await adapter().planOfferLifecycle({ app, product: annual, kind: 'apple.winBack', key: 'example_winback', action: 'deactivate', endDate: '2030-06-01' });
    await applyChangeSet(end.changeSet, { adapter: adapter(), confirm: end.hash });
    expect(store.offers[0].attributes.endDate).toBe('2030-06-01');

    const del = await adapter().planOfferLifecycle({ app, product: annual, kind: 'apple.winBack', key: 'example_winback', action: 'delete' });
    const run = await applyChangeSet(del.changeSet, { adapter: adapter(), confirm: del.hash, force: { deleteOffers: true } });
    expect(run.status).toBe('completed');
    expect(store.offers).toEqual([]);
  });

  it('refuses a win-back offer without a start date before reading any price', async () => {
    const plan = await adapter().planOffers({
      app,
      offers: [
        {
          id: 'wb',
          productRef: annual,
          kind: 'apple.winBack',
          mode: 'PAY_UP_FRONT',
          duration: 'P1Y',
          pricing: { type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'nearest' },
          eligibility: { type: 'apple.winBack', paidSubscriptionDurationInMonths: 3, timeSinceLastSubscribedInMonths: { minimum: 1, maximum: 12 } },
          territories: 'all',
          syncWithBase: false,
        },
      ],
    });
    expect(plan.entries[0].refusals[0]).toMatchObject({ code: 'MISSING_SETTINGS', message: expect.stringMatching(/start date/) });
  });
});

describe('one API key, two apps', () => {
  const STAGING_SUB = '9100000009';
  const stagingCredentials = { ...credentials, bundleId: 'com.example.app.staging' };
  const stagingApp = { bundleId: 'com.example.app.staging' };
  const staging = () => new AppleAdapter({ ...appleKeyConnection(stagingCredentials), budget: new RequestBudget(), now: () => NOW });

  beforeEach(() => {
    store.apps.set('com.example.app.staging', { id: 'app-2', groups: ['group-2'] });
    store.addSubscription(STAGING_SUB, 'ONE_YEAR', { USA: '49.99' }, { USA: ['24.99', '49.99'] }, 'group-2');
  });

  it("planning refuses another app's subscription before reading its offers or prices", async () => {
    await expect(staging().planOffers({ app: stagingApp, offers: [halfOffAnnual(annual, 'example_annual_50')] })).rejects.toMatchObject({ status: 409, code: 'APP_MISMATCH' });
    expect(store.calls.map((c) => c.endpoint).filter((e) => e.includes('Offers') || e.endsWith('/prices') || e.endsWith('/pricePoints'))).toEqual([]);
    // Its own subscription plans fine
    const own = await staging().planOffers({ app: stagingApp, offers: [halfOffAnnual({ platform: 'apple', type: 'subscription', id: STAGING_SUB }, 'example_staging_50')] });
    expect(own.entries[0].action).toBe('create');
  });

  it("the executor refuses a plan naming another app's subscription before reading or writing anything", async () => {
    // A plan for the staging app that names a production subscription (e.g. a copied ID)
    const plan = await adapter().planOffers({ app, offers: [halfOffAnnual(annual, 'example_annual_50')] });
    const crafted = { ...plan.changeSet, app: stagingApp };
    const { changeSetHash } = await import('@/lib/pricing');
    store.calls = [];
    const run = await applyChangeSet(crafted, { adapter: staging(), confirm: changeSetHash(crafted) });
    expect(run.ops[0]).toMatchObject({ status: 'failed', error: { code: 'APP_MISMATCH', status: 409 } });
    expect(store.writes()).toEqual([]);
    expect(store.calls.some((c) => c.endpoint.includes('promotionalOffers'))).toBe(false);
  });

  it('matches the bundle ID exactly (a prefix match is not the app)', async () => {
    store.apps.set('com.example.app.staging.extra', { id: 'app-3', groups: ['group-1'] });
    await expect(staging().planOffers({ app: stagingApp, offers: [halfOffAnnual(annual, 'x')] })).rejects.toMatchObject({ code: 'APP_MISMATCH' });
  });
});

describe('intro offers whose start date App Store Connect fills in on read', () => {
  const trial: OfferSpec = {
    id: 'trial',
    productRef: annual,
    kind: 'apple.intro',
    mode: 'FREE_TRIAL',
    duration: 'P1W',
    pricing: { type: 'free' },
    territories: ['US', 'GB'],
    syncWithBase: false,
  };
  const hashOf = async (cs: Parameters<typeof applyChangeSet>[0]) => (await import('@/lib/pricing')).changeSetHash(cs);

  it('records the created resources, never treats a re-dated offer as done, and undo deletes exactly what the run created', async () => {
    store.fillIntroStartDate = '2030-03-01';
    // An unrelated intro offer in another territory that the run must never touch
    const unrelated = store.seedIntro(ANNUAL, 'DEU', { duration: 'ONE_MONTH', offerMode: 'FREE_TRIAL' }, null);
    const plan = await adapter().planOffers({ app, offers: [trial] });
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, verify: true });
    expect(run.ops[0].status).toBe('ok');
    const createdIds = run.ops[0].response!.createdIds as Record<string, string>;
    expect(Object.keys(createdIds).sort()).toEqual(['GB', 'US']);
    expect(store.intros.filter((i) => i.attributes.startDate === '2030-03-01')).toHaveLength(2);
    // The run's own read-back finds them by the recorded IDs; a fresh run, which has no IDs and
    // reads a start date the plan didn't have, reports a conflict rather than "already done" or sending again
    expect(run.ops[0].verified).toBe(true);
    const again = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(again.ops[0]).toMatchObject({ status: 'failed', error: { code: 'STATE_CHANGED' } });
    expect(store.writes().filter((w) => w.startsWith('POST'))).toHaveLength(2);

    // Deleting by terms alone finds nothing with these terms but an overlapping offer: drift, not done
    const op = plan.changeSet.ops[0] as OfferOp;
    const { computeOfferIdempotencyKey } = await import('@/lib/pricing');
    const byTerms = { ...op, id: 'op-0001', kind: 'deleteOffer' as const, before: op.after, after: null };
    const deleteByTerms = { ...plan.changeSet, id: 'del', ops: [{ ...byTerms, idempotencyKey: computeOfferIdempotencyKey(byTerms) }] };
    const blind = await applyChangeSet(deleteByTerms, { adapter: adapter(), confirm: await hashOf(deleteByTerms), force: { deleteOffers: true } });
    expect(blind.ops[0]).toMatchObject({ status: 'failed', error: { code: 'STATE_CHANGED', message: expect.stringMatching(/start date App Store Connect filled in/) } });
    expect(store.writes().filter((w) => w.startsWith('DELETE'))).toEqual([]);

    // Undo uses the recorded resource IDs
    const undo = buildUndoChangeSet(plan.changeSet, run);
    expect((undo.ops[0] as OfferOp).before!.storeRefs).toEqual(createdIds);
    const undone = await applyChangeSet(undo, { adapter: adapter(), confirm: await hashOf(undo), force: { deleteOffers: true } });
    expect(undone.status).toBe('completed');
    expect(store.intros).toEqual([unrelated]);
  });

  it('undo of a partly failed intro create deletes only the territories that run created', async () => {
    const plan = await adapter().planOffers({ app, offers: [{ ...trial, territories: ['DE', 'GB', 'JP', 'US'] }] });
    let n = 0;
    appleApiRequest.mockImplementation(async (c: unknown, endpoint: string, options: Record<string, unknown> = {}) => {
      if (options.method === 'POST' && ++n === 3) {
        const { AppleApiError } = await import('@/lib/apple-connect/client');
        throw new AppleApiError(500, 'UNEXPECTED_ERROR', 'Error', 'down');
      }
      return store.handle(c, endpoint, options);
    });
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(run.ops[0]).toMatchObject({ status: 'failed', attempts: 1, response: { createdIds: { DE: expect.any(String), GB: expect.any(String) } } });
    appleApiRequest.mockImplementation(store.handle);
    // Someone else creates an intro offer in US with the same terms before the undo
    const foreign = store.seedIntro(ANNUAL, 'USA', { duration: 'ONE_WEEK', offerMode: 'FREE_TRIAL' }, null);

    const undo = buildUndoChangeSet(plan.changeSet, run);
    const del = undo.ops[0] as OfferOp;
    expect(Object.keys(del.before!.prices)).toEqual(['DE', 'GB']);
    expect(undo.notReversible?.[0].reason).toMatch(/No created resource was recorded for JP, US/);
    const undone = await applyChangeSet(undo, { adapter: adapter(), confirm: await hashOf(undo), force: { deleteOffers: true } });
    expect(undone.status).toBe('completed');
    expect(store.intros).toEqual([foreign]);
  });

  it('a resume after a partial create uses the recorded IDs and creates only the rest', async () => {
    store.fillIntroStartDate = '2030-03-01';
    const plan = await adapter().planOffers({ app, offers: [trial] });
    let n = 0;
    appleApiRequest.mockImplementation(async (c: unknown, endpoint: string, options: Record<string, unknown> = {}) => {
      if (options.method === 'POST' && ++n === 2) {
        const { AppleApiError } = await import('@/lib/apple-connect/client');
        throw new AppleApiError(500, 'UNEXPECTED_ERROR', 'Error', 'down');
      }
      return store.handle(c, endpoint, options);
    });
    const first = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(first.ops[0].status).toBe('failed');
    appleApiRequest.mockImplementation(store.handle);
    const resumed = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, run: first });
    expect(resumed.status).toBe('completed');
    expect(Object.keys(resumed.ops[0].response!.createdIds as object).sort()).toEqual(['GB', 'US']);
    expect(store.intros).toHaveLength(2);
  });
});

describe('undo after a refused create', () => {
  it('leaves out creates the store refused with a 4xx', async () => {
    const plan = await planBoth();
    store.failures.push({ method: 'POST', path: /^\/subscriptionPromotionalOffers$/, status: 409 });
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, concurrency: 1 });
    expect(run.ops.map((r) => r.status)).toEqual(['failed', 'ok']);
    const undo = buildUndoChangeSet(plan.changeSet, run);
    expect(undo.ops.map((op) => (op as OfferOp).target.offer.key)).toEqual(['example_annual_alt_50']);
  });
});

describe('undo after an attempt that may have taken effect', () => {
  it('keeps a create in undo when a timeout was followed by a 409', async () => {
    const plan = await planBoth();
    store.failures.push({ method: 'POST', path: /^\/subscriptionPromotionalOffers$/, status: 504 });
    const first = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, concurrency: 1 });
    expect(first.ops[0]).toMatchObject({ status: 'failed', attempts: 1, error: { status: 504 } });
    store.failures.push({ method: 'POST', path: /^\/subscriptionPromotionalOffers$/, status: 409 });
    const second = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, run: first });
    expect(second.ops[0]).toMatchObject({ status: 'failed', attempts: 2, error: { status: 409 } });
    // The 409 doesn't prove the timed-out attempt wrote nothing: the create stays in the undo plan
    const undo = buildUndoChangeSet(plan.changeSet, second);
    expect(undo.ops.map((op) => [(op as OfferOp).kind, (op as OfferOp).target.offer.key])).toEqual([
      ['deleteOffer', 'example_annual_alt_50'],
      ['deleteOffer', 'example_annual_50'],
    ]);
  });

  it('a resume records the intro resource a timed-out create left behind, so undo can delete it', async () => {
    const trial: OfferSpec = { id: 'trial', productRef: annual, kind: 'apple.intro', mode: 'FREE_TRIAL', duration: 'P1W', pricing: { type: 'free' }, territories: ['GB', 'US'], schedule: { start: '2030-04-01' }, syncWithBase: false };
    const plan = await adapter().planOffers({ app, offers: [trial] });
    // The first create (GB) takes effect but answers 504: no ID comes back
    store.failures.push({ method: 'POST', path: /^\/subscriptionIntroductoryOffers$/, status: 504, afterWrite: true });
    const first = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(first.ops[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(first.ops[0].response?.createdIds).toBeUndefined();

    const resumed = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, run: first });
    expect(resumed.status).toBe('completed');
    const ids = resumed.ops[0].response!.createdIds as Record<string, string>;
    expect(Object.keys(ids).sort()).toEqual(['GB', 'US']);
    expect(store.intros.map((i) => i.id).sort()).toEqual(Object.values(ids).sort());
    expect(store.calls.filter((c) => c.method === 'POST')).toHaveLength(2); // GB never sent again

    const undo = buildUndoChangeSet(plan.changeSet, resumed);
    expect(undo.notReversible?.filter((n) => /No created resource/.test(n.reason)) ?? []).toEqual([]);
    const { changeSetHash } = await import('@/lib/pricing');
    await applyChangeSet(undo, { adapter: adapter(), confirm: changeSetHash(undo), force: { deleteOffers: true } });
    expect(store.intros).toEqual([]);
  });
});
