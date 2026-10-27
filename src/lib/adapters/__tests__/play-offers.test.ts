// PlayAdapter offers end to end against a stateful fake of the Play endpoints
// (googlePlayFetch is mocked): plan, preview, apply, idempotency, resume,
// undo, app ownership, budget, and sync for every Play pricing type.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/google-play/client', () => ({ googlePlayFetch: vi.fn() }));

import { googlePlayFetch } from '@/lib/google-play/client';
import { PlayAdapter } from '../play';
import { HeaderTokenSource } from '@/lib/token-source';
import {
  applyChangeSet,
  buildChangeSet,
  buildUndoChangeSet,
  changeSetHash,
  parseChangeSet,
  parseOfferRules,
  PlayOfferLifecycleError,
  type OfferSpec,
  type PlayOfferOp,
  type ProductRef,
} from '@/lib/pricing';
import { RequestBudget } from '@/lib/utils/request-budget';
import { FakePlayOffers, money, PKG, PRODUCT, retentionOfferResource, trialOfferResource } from './fake-play-offers';

const fetchMock = vi.mocked(googlePlayFetch);
const tokens = new HeaderTokenSource('google', 'test-access-token', 'test@example.iam.gserviceaccount.com');
const app = { packageName: PKG };
const annual: ProductRef = { platform: 'google', type: 'subscription', productId: PRODUCT, basePlanId: 'annual' };
const NOW = '2030-01-01T00:00:00.000Z';

let store: FakePlayOffers;
beforeEach(() => {
  store = new FakePlayOffers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(store.handle as never);
});

const adapter = (budget?: RequestBudget) => new PlayAdapter({ tokens, packageName: PKG, budget });

/** Phase 3 criterion 1: developer-determined, 50% off for a year as one payment, tagged for RevenueCat */
const retentionSpec: OfferSpec = {
  id: 'annual-half-off',
  kind: 'play.offer',
  productRef: annual,
  mode: 'PAY_UP_FRONT',
  duration: 'P1Y',
  pricing: { type: 'play.relativeDiscount', fraction: '0.5' },
  eligibility: { type: 'play.targeting', rule: { type: 'developerDetermined' } },
  tags: ['rc-customer-center', 'rc-ignore-offer'],
  territories: 'all',
  syncWithBase: false,
};

/** Phase 3 criterion 2: a free trial only for customers who never had any subscription */
const trialSpec: OfferSpec = {
  id: 'new-customer-trial',
  kind: 'play.offer',
  productRef: annual,
  mode: 'FREE_TRIAL',
  duration: 'P1W',
  pricing: { type: 'free' },
  eligibility: { type: 'play.targeting', rule: { type: 'acquisition', scope: 'anySubscriptionInApp' } },
  territories: 'all',
  syncWithBase: false,
};

async function planCriterion() {
  return adapter().planOffers({ app, offers: [retentionSpec, trialSpec], createdAt: NOW });
}

describe('Phase 3 criterion: plan, preview and apply the two offers', () => {
  it('plans a developer-determined 50%-off year tagged for RevenueCat and a new-customer free trial', async () => {
    const plan = await planCriterion();
    expect(plan.changeSet.ops.map((op) => `${op.kind} ${(op as PlayOfferOp).target.offer.key}`)).toEqual(['createOffer annual-half-off', 'createOffer new-customer-trial']);
    const [retention, trial] = plan.changeSet.ops as PlayOfferOp[];
    expect(retention.after).toEqual({
      kind: 'play.offer',
      key: 'annual-half-off',
      state: 'ACTIVE',
      phases: [{ duration: 'P1Y', recurrenceCount: 1, regions: { GB: { type: 'relativeDiscount', fraction: '0.5' }, JP: { type: 'relativeDiscount', fraction: '0.5' }, US: { type: 'relativeDiscount', fraction: '0.5' } } }],
      targeting: { type: 'developerDetermined' },
      tags: ['rc-customer-center', 'rc-ignore-offer'],
      regions: { GB: { newSubscriberAvailability: true }, JP: { newSubscriberAvailability: true }, US: { newSubscriberAvailability: true } },
    });
    expect(retention.regionsVersion).toBe('2025/03');
    expect(trial.after!.targeting).toEqual({ type: 'acquisition', scope: 'anySubscriptionInApp' });
    expect(trial.after!.phases[0]).toMatchObject({ duration: 'P1W', recurrenceCount: 1, regions: { US: { type: 'free' } } });
    // The plan file round-trips and its hash is what apply confirms
    expect(parseChangeSet(JSON.parse(JSON.stringify(plan.changeSet)))).toEqual(plan.changeSet);
    expect(plan.hash).toBe(changeSetHash(plan.changeSet));
    // Planning only reads (convertRegionPrices is read-only)
    expect(store.writes()).toEqual([]);
  });

  it("previews each offer's eligibility, phases and tags, and per region the base price, offer price and discount", async () => {
    const plan = await planCriterion();
    const [retention, trial] = plan.entries;
    expect(retention.play).toMatchObject({
      offerId: 'annual-half-off',
      state: 'ACTIVE',
      eligibility: expect.stringMatching(/^Developer-determined/),
      phases: ['P1Y x1: 50% off'],
      tags: ['rc-customer-center', 'rc-ignore-offer'],
    });
    expect(retention.play!.rows.find((r) => r.region === 'US')).toMatchObject({ basePrice: '59.99', proratedBase: '59.99', offerPrice: '30', estimated: true, discount: '29.99', discountPercent: '49.99' });
    expect(retention.play!.rows.find((r) => r.region === 'JP')).toMatchObject({ basePrice: '9800', offerPrice: '4900', discount: '4900', discountPercent: '50' });
    expect(trial.play).toMatchObject({ eligibility: 'New customer acquisition: never had any subscription in the app', phases: ['P1W x1: free'], tags: [] });
    expect(trial.play!.rows.find((r) => r.region === 'GB')).toMatchObject({ basePrice: '49.99', offerPrice: '0', config: { type: 'free' } });
  });

  it('applies only with the plan hash, creates and activates both offers, and is idempotent', async () => {
    const plan = await planCriterion();
    await expect(applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: 'wrong' })).rejects.toThrow(/confirmation doesn't match/);
    expect(store.writes()).toEqual([]);

    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, verify: true, concurrency: 1, now: () => NOW });
    expect(run.status).toBe('completed');
    expect(run.ops.every((r) => r.status === 'ok' && r.verified)).toBe(true);
    expect(store.writes()).toEqual([
      `POST ${PRODUCT}/basePlans/annual/offers`,
      `POST ${PRODUCT}/basePlans/annual/offers/annual-half-off:activate`,
      `POST ${PRODUCT}/basePlans/annual/offers`,
      `POST ${PRODUCT}/basePlans/annual/offers/new-customer-trial:activate`,
    ]);
    const create = store.calls.find((c) => c.method === 'POST' && c.path.endsWith('/offers'))!;
    expect(create.query).toEqual({ offerId: 'annual-half-off', 'regionsVersion.version': '2025/03' });
    expect(store.offer('annual', 'annual-half-off')).toMatchObject({ state: 'ACTIVE', offerTags: [{ tag: 'rc-customer-center' }, { tag: 'rc-ignore-offer' }] });
    expect(store.offer('annual', 'annual-half-off')).not.toHaveProperty('targeting');
    expect(store.offer('annual', 'new-customer-trial')).toMatchObject({ state: 'ACTIVE', targeting: { acquisitionRule: { scope: { anySubscriptionInApp: {} } } } });

    const writes = store.writes().length;
    const again = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(again.ops.map((r) => r.skipReason)).toEqual(['ALREADY_AT_TARGET', 'ALREADY_AT_TARGET']);
    expect(store.writes()).toHaveLength(writes);

    // Re-planning the same specs changes nothing
    const replan = await planCriterion();
    expect(replan.changeSet.ops).toEqual([]);
    expect(replan.entries.map((e) => e.action)).toEqual(['none', 'none']);
  });

  it('undoes the creates by deactivating (Play deletes only drafts)', async () => {
    const plan = await planCriterion();
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    const undo = buildUndoChangeSet(plan.changeSet, run);
    expect(undo.ops.map((op) => op.kind)).toEqual(['deactivateOffer', 'deactivateOffer']);
    expect(undo.notReversible?.[0].reason).toMatch(/deletes only draft offers/);
    const undone = await applyChangeSet(undo, { adapter: adapter(), confirm: changeSetHash(undo) });
    expect(undone.status).toBe('completed');
    expect(store.offer('annual', 'annual-half-off')!.state).toBe('INACTIVE');
    expect(store.offer('annual', 'new-customer-trial')!.state).toBe('INACTIVE');
  });
});

describe('resume, partial writes and conflicts', () => {
  it('resumes a create whose activation failed by activating only, and undoes the draft by deleting it', async () => {
    const plan = await adapter().planOffers({ app, offers: [retentionSpec], createdAt: NOW });
    store.failNext((c) => c.path.endsWith(':activate'), 400);
    const first = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(first.status).toBe('incomplete');
    expect(first.ops[0]).toMatchObject({ status: 'failed', attempts: 1, response: { createSent: true, created: true, activationSent: true, activated: false } });
    expect(store.offer('annual', 'annual-half-off')!.state).toBe('DRAFT');

    // Undo of the partial run deletes the draft the run left (never "deactivates" an offer that isn't active)
    const undo = buildUndoChangeSet(plan.changeSet, first);
    expect(undo.ops).toMatchObject([{ kind: 'deleteOffer', before: { state: 'DRAFT' } }]);
    const unforced = await applyChangeSet(undo, { adapter: adapter(), confirm: changeSetHash(undo) });
    expect(unforced.ops[0].error?.code).toBe('REDEMPTIONS_UNCHECKED');

    const writes = store.writes().length;
    const resumed = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, run: first });
    expect(resumed.status).toBe('completed');
    expect(store.writes().slice(writes)).toEqual([`POST ${PRODUCT}/basePlans/annual/offers/annual-half-off:activate`]);
    expect(store.offer('annual', 'annual-half-off')!.state).toBe('ACTIVE');
  });

  it('an activation without an answer leaves the state unknown: undo lists it instead of guessing', async () => {
    const plan = await adapter().planOffers({ app, offers: [retentionSpec], createdAt: NOW });
    store.failNext((c) => c.path.endsWith(':activate'), 503, { tookEffect: true });
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(run.ops[0]).toMatchObject({ status: 'failed', response: { activationSent: true, activated: 'unknown' } });
    // The client sent the activation once: no retry after a 5xx
    expect(store.writes().filter((w) => w.endsWith(':activate'))).toHaveLength(1);
    const undo = buildUndoChangeSet(plan.changeSet, run);
    expect(undo.ops).toEqual([]);
    expect(undo.notReversible?.[0].reason).toMatch(/may be ACTIVE or still a draft/);
    // A resume finds it active and confirms it
    const resumed = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, run });
    expect(resumed.ops[0]).toMatchObject({ status: 'ok', response: { confirmedOnResume: true } });
  });

  it('keeps a create that failed in undo whatever the status (it may have applied); undo then deletes at most a draft', async () => {
    const plan = await adapter().planOffers({ app, offers: [retentionSpec], createdAt: NOW });
    // A 400 to the one create request: undo still lists a delete of the (possible) draft, which is skipped if absent
    store.failNext((c) => c.method === 'POST' && c.path.endsWith('/offers'), 400);
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(run.ops[0]).toMatchObject({ status: 'failed', response: { createSent: true, activationSent: false } });
    const undo = buildUndoChangeSet(plan.changeSet, run);
    expect(undo.ops).toMatchObject([{ kind: 'deleteOffer', before: { state: 'DRAFT' } }]);
    const undone = await applyChangeSet(undo, { adapter: adapter(), confirm: changeSetHash(undo), force: { deleteOffers: true } });
    expect(undone.ops[0]).toMatchObject({ status: 'skipped', skipReason: 'ALREADY_AT_TARGET' });
    expect(store.writes().filter((w) => w.startsWith('DELETE'))).toEqual([]);
  });

  it('treats a create that answered 409 as done only when the offer that exists is exactly the planned one', async () => {
    const plan = await adapter().planOffers({ app, offers: [retentionSpec], createdAt: NOW });
    // The first attempt took effect, the answer was lost, the retry got 409
    store.failNext((c) => c.method === 'POST' && c.path.endsWith('/offers'), 409, { tookEffect: true });
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(run.ops[0]).toMatchObject({ status: 'ok', response: { foundAfterConflict: true, activated: true } });

    // A 409 for an offer that differs is a real conflict: nothing else is sent
    const other = new FakePlayOffers();
    fetchMock.mockImplementation(other.handle as never);
    const plan2 = await adapter().planOffers({ app, offers: [retentionSpec], createdAt: NOW });
    other.seed('annual', { ...retentionOfferResource('DRAFT'), offerTags: [] });
    const conflict = await applyChangeSet(plan2.changeSet, { adapter: adapter(), confirm: plan2.hash });
    expect(conflict.ops[0]).toMatchObject({ status: 'failed', error: { code: 'STATE_CHANGED', message: expect.stringMatching(/already exists with other phases/) } });
    expect(other.writes()).toEqual([]);
  });

  it('a create that failed after taking effect is confirmed on resume, never sent twice', async () => {
    const plan = await adapter().planOffers({ app, offers: [trialSpec], createdAt: NOW });
    store.failNext((c) => c.method === 'POST' && c.path.endsWith('/offers'), 500, { tookEffect: true });
    const first = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(first.ops[0]).toMatchObject({ status: 'failed', attempts: 1 });
    const resumed = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, run: first });
    expect(resumed.status).toBe('completed');
    expect(store.writes().filter((w) => w.endsWith('/offers'))).toHaveLength(1);
    expect(store.offer('annual', 'new-customer-trial')!.state).toBe('ACTIVE');
  });

  it('refuses an op whose offer changed since planning, sending nothing', async () => {
    store.seed('annual', retentionOfferResource());
    const plan = await adapter().planOfferLifecycle({ app, product: annual, key: 'annual-half-off', action: 'deactivate', createdAt: NOW });
    (store.offer('annual', 'annual-half-off')!.offerTags as unknown[]).pop();
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(run.ops[0]).toMatchObject({ status: 'failed', error: { code: 'STATE_CHANGED' } });
    expect(store.writes()).toEqual([]);
  });
});

describe('updates, activation and deletion', () => {
  it('patches tags and eligibility of an existing offer with an updateMask of the changed fields', async () => {
    store.seed('annual', retentionOfferResource());
    // A re-price spec that leaves a tag out is refused: tags are never dropped silently
    const repriced = await adapter().planOffers({ app, offers: [{ ...retentionSpec, pricing: { type: 'play.relativeDiscount', fraction: '0.4' }, tags: ['rc-customer-center'] }], createdAt: NOW });
    expect(repriced.entries[0].refusals).toMatchObject([{ code: 'TAG_REMOVAL', message: expect.stringMatching(/rc-ignore-offer.*allowTagRemoval/) }]);
    expect(repriced.changeSet.ops).toEqual([]);

    const spec = { ...retentionSpec, tags: ['rc-customer-center'], play: { allowTagRemoval: true } };
    const plan = await adapter().planOffers({ app, offers: [spec], createdAt: NOW });
    expect(plan.changeSet.ops).toMatchObject([{ kind: 'updateOffer' }]);
    expect(plan.entries[0].warnings).toContain('removes tag rc-ignore-offer');
    expect(plan.entries[0].play).toMatchObject({
      before: { state: 'ACTIVE', tags: ['rc-customer-center', 'rc-ignore-offer'] },
      tags: ['rc-customer-center'],
      tagChanges: { added: [], removed: ['rc-ignore-offer'] },
    });
    expect(plan.entries[0].warnings.join()).toMatch(/not confirmed/);
    await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    const patch = store.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.query).toEqual({ updateMask: 'offerTags', 'regionsVersion.version': '2025/03' });
    expect(store.offer('annual', 'annual-half-off')!.offerTags).toEqual([{ tag: 'rc-customer-center' }]);

    // An eligibility change is named
    const eligibility = await adapter().planOffers({
      app,
      offers: [{ ...spec, eligibility: { type: 'play.targeting', rule: { type: 'acquisition', scope: 'thisSubscription' } } }],
      createdAt: NOW,
    });
    expect(eligibility.entries[0].warnings).toContain('eligibility Developer-determined (no Play eligibility rule; the app decides who sees it) → New customer acquisition: never had this subscription');
    expect(eligibility.entries[0].play!.eligibilityChange).toBeDefined();
  });

  it('patches only prices for a price change, keeps regions the spec leaves out, and refuses changing phase terms', async () => {
    store.seed('annual', retentionOfferResource());
    const plan = await adapter().planOffers({ app, offers: [{ ...retentionSpec, pricing: { type: 'play.relativeDiscount', fraction: '0.4' }, territories: ['US'] }], createdAt: NOW });
    const op = plan.changeSet.ops[0] as PlayOfferOp;
    expect(op.kind).toBe('updateOfferPrices');
    expect(op.after!.phases[0].regions).toEqual({ GB: { type: 'relativeDiscount', fraction: '0.5' }, JP: { type: 'relativeDiscount', fraction: '0.5' }, US: { type: 'relativeDiscount', fraction: '0.4' } });
    await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash });
    expect(store.calls.find((c) => c.method === 'PATCH')!.query).toMatchObject({ updateMask: 'phases' });

    const terms = await adapter().planOffers({ app, offers: [{ ...retentionSpec, duration: 'P6M' }], createdAt: NOW });
    expect(terms.entries[0].refusals).toMatchObject([{ code: 'TERMS_IMMUTABLE' }]);
    expect(terms.changeSet.ops).toEqual([]);
  });

  it('activates a matching draft, and deletes only drafts, with force', async () => {
    store.seed('annual', retentionOfferResource('DRAFT'));
    const activate = await adapter().planOffers({ app, offers: [retentionSpec], createdAt: NOW });
    expect(activate.changeSet.ops).toMatchObject([{ kind: 'activateOffer' }]);
    expect(activate.entries[0].action).toBe('activate');

    const del = await adapter().planOfferLifecycle({ app, product: annual, key: 'annual-half-off', action: 'delete', createdAt: NOW });
    const unforced = await applyChangeSet(del.changeSet, { adapter: adapter(), confirm: del.hash });
    expect(unforced.ops[0]).toMatchObject({ status: 'failed', error: { code: 'REDEMPTIONS_UNCHECKED', message: expect.stringMatching(/irreversible/) } });
    expect(store.writes()).toEqual([]);
    const forced = await applyChangeSet(del.changeSet, { adapter: adapter(), confirm: del.hash, force: { deleteOffers: true } });
    expect(forced.status).toBe('completed');
    expect(store.offer('annual', 'annual-half-off')).toBeUndefined();
    // Undo re-creates the draft under the same ID
    const undo = buildUndoChangeSet(del.changeSet, forced);
    expect(undo.ops).toMatchObject([{ kind: 'createOffer', after: { state: 'DRAFT' }, regionsVersion: '2025/03' }]);
    await applyChangeSet(undo, { adapter: adapter(), confirm: changeSetHash(undo) });
    expect(store.offer('annual', 'annual-half-off')!.state).toBe('DRAFT');

    store.seed('annual', trialOfferResource('ACTIVE'));
    await expect(adapter().planOfferLifecycle({ app, product: annual, key: 'new-customer-trial', action: 'delete' })).rejects.toThrow(PlayOfferLifecycleError);
  });
});

describe('app ownership', () => {
  it('refuses a plan for another package before reading anything', async () => {
    const plan = await planCriterion();
    const calls = store.calls.length;
    const other = new PlayAdapter({ tokens, packageName: 'com.example.other' });
    await expect(applyChangeSet(plan.changeSet, { adapter: other, confirm: plan.hash })).rejects.toMatchObject({ code: 'APP_MISMATCH', status: 409 });
    expect(store.calls.length).toBe(calls);
    await expect(other.planOffers({ app, offers: [retentionSpec] })).rejects.toMatchObject({ code: 'APP_MISMATCH' });
    await expect(other.planOfferSync({ rules: parseOfferRules({ kind: 'pricingkit.offerRules', schemaVersion: 1, app, offers: [{ product: annual, kind: 'play.offer', key: 'x', pricing: { type: 'play.relativeDiscount', fraction: '0.5' }, syncWithBase: true }] }) })).rejects.toMatchObject({ code: 'APP_MISMATCH' });
  });

  it("fails ops on a base plan that isn't in the app, sending nothing", async () => {
    const plan = await planCriterion();
    const changeSet = structuredClone(plan.changeSet);
    const missing: ProductRef = { platform: 'google', type: 'subscription', productId: PRODUCT, basePlanId: 'quarterly' };
    for (const op of changeSet.ops as PlayOfferOp[]) {
      op.target.product = missing;
    }
    const { computePlayOfferIdempotencyKey } = await import('@/lib/pricing');
    for (const op of changeSet.ops as PlayOfferOp[]) op.idempotencyKey = computePlayOfferIdempotencyKey(op);
    const run = await applyChangeSet(changeSet, { adapter: adapter(), confirm: changeSetHash(changeSet) });
    expect(run.ops.every((r) => r.status === 'failed' && r.error?.message.match(/not found/))).toBe(true);
    expect(store.writes()).toEqual([]);
  });

  it('refuses offers on a base plan that does not renew automatically', async () => {
    const prepaid: ProductRef = { platform: 'google', type: 'subscription', productId: PRODUCT, basePlanId: 'prepaid' };
    await expect(adapter().planOffers({ app, offers: [{ ...retentionSpec, productRef: prepaid }] })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});

describe('budget', () => {
  it('charges every read and write to the budget', async () => {
    const budget = new RequestBudget({ limit: 100 });
    const a = adapter(budget);
    const plan = await a.planOffers({ app, offers: [retentionSpec, trialSpec], createdAt: NOW });
    await applyChangeSet(plan.changeSet, { adapter: a, budget, confirm: plan.hash });
    expect(budget.used).toBe(store.calls.length);
    expect(store.calls.length).toBeGreaterThan(6);
  });

  it('stops before an op the budget cannot finish and leaves it pending for a resume', async () => {
    const plan = await planCriterion();
    // Ownership check, offers read, then a create needs 3 (POST, a possible re-read, activate): only 4 left after the reads
    const budget = new RequestBudget({ limit: 6 });
    const run = await applyChangeSet(plan.changeSet, { adapter: adapter(budget), budget, confirm: plan.hash });
    expect(run.status).toBe('incomplete');
    expect(run.stoppedReason).toBe('BUDGET_EXCEEDED');
    expect(run.ops.map((r) => r.status)).toEqual(['ok', 'pending']);
    const resumed = await applyChangeSet(plan.changeSet, { adapter: adapter(), confirm: plan.hash, run });
    expect(resumed.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Sync

function rules(offers: unknown[]) {
  return parseOfferRules({ kind: 'pricingkit.offerRules', schemaVersion: 1, app, offers });
}

/** An offer whose one phase has a fixed price per region (what percentOfCurrent writes) */
function pricedOffer(offerId: string, prices: Record<string, [string, string]>, kind: 'price' | 'absoluteDiscount' = 'price') {
  const regions = Object.keys(prices).sort();
  return {
    offerId,
    state: 'ACTIVE',
    phases: [{ duration: 'P1Y', recurrenceCount: 1, regionalConfigs: regions.map((r) => ({ regionCode: r, [kind]: money(prices[r][0], prices[r][1]) })) }],
    regionalConfigs: regions.map((r) => ({ regionCode: r, newSubscriberAvailability: true })),
  };
}

describe('sync for each Play pricing type', () => {
  it('relative discount: nothing to do before or after a base change, listed as following base automatically', async () => {
    store.seed('annual', retentionOfferResource());
    const r = rules([{ product: annual, kind: 'play.offer', key: 'annual-half-off', pricing: { type: 'play.relativeDiscount', fraction: '0.5' }, syncWithBase: true }]);
    store.setBasePrice('annual', 'US', '69.99');
    const sync = await adapter().planOfferSync({ rules: r, createdAt: NOW });
    expect(sync.entries[0].action).toBe('followsBase');
    expect(sync.changeSet.ops).toEqual([]);
    // A different fraction in the store: sync puts the rule's back
    const r40 = rules([{ product: annual, kind: 'play.offer', key: 'annual-half-off', pricing: { type: 'play.relativeDiscount', fraction: '0.4' }, syncWithBase: true }]);
    expect((await adapter().planOfferSync({ rules: r40, createdAt: NOW })).changeSet.ops).toMatchObject([{ kind: 'updateOfferPrices' }]);
  });

  it('percent of current: in step until the base price changes, then sync re-prices it with Play prices', async () => {
    store.seed('annual', pricedOffer('annual-half-price', { US: ['USD', '29.99'], GB: ['GBP', '24.99'], JP: ['JPY', '4900'] }));
    const r = rules([{ product: annual, kind: 'play.offer', key: 'annual-half-price', pricing: { type: 'percentOfCurrent', percent: '50', snap: 'nearest' }, syncWithBase: true }]);
    expect((await adapter().planOfferSync({ rules: r, createdAt: NOW })).changeSet.ops).toEqual([]);

    store.setBasePrice('annual', 'US', '69.99');
    const sync = await adapter().planOfferSync({ rules: r, createdAt: NOW });
    const op = sync.changeSet.ops[0] as PlayOfferOp;
    expect(op).toMatchObject({ kind: 'updateOfferPrices', regionsVersion: '2025/03' });
    expect(op.after!.phases[0].regions.US).toEqual({ type: 'price', currency: 'USD', amount: '34.99' });
    expect(sync.entries[0].play?.changes.map((c) => c.region)).toEqual(['US']);
    await applyChangeSet(sync.changeSet, { adapter: adapter(), confirm: sync.hash });
    expect((await adapter().planOfferSync({ rules: r, createdAt: NOW })).changeSet.ops).toEqual([]);
  });

  it('percent of current with a base-price plan: offers are derived against the planned prices and wait for them', async () => {
    store.seed('annual', pricedOffer('annual-half-price', { US: ['USD', '29.99'], GB: ['GBP', '24.99'], JP: ['JPY', '4900'] }));
    const r = rules([{ product: annual, kind: 'play.offer', key: 'annual-half-price', pricing: { type: 'percentOfCurrent', percent: '50', snap: 'nearest' }, syncWithBase: true }]);
    const a = adapter();
    const state = await a.fetchState(annual);
    const base = buildChangeSet({ app, products: [{ state, targets: { US: { currency: 'USD', amount: '69.99' } } }], createdAt: NOW });
    const sync = await a.planOfferSync({ rules: r, base, states: [state], createdAt: NOW });
    expect(sync.changeSet.ops.map((op) => op.kind)).toEqual(['setPrice', 'updateOfferPrices']);
    expect(sync.changeSet.ops[1]).toMatchObject({ dependsOn: ['op-0001'], after: { phases: [{ regions: { US: { amount: '34.99' } } }] } });
    expect(sync.entries[0].pricedAgainst).toBe('planTargets');
    // Applied together: base price first, then the offer
    const run = await applyChangeSet(sync.changeSet, { adapter: a, confirm: sync.hash });
    expect(run.status).toBe('completed');
    expect(store.writes()).toEqual([`PATCH ${PRODUCT}`, `PATCH ${PRODUCT}/basePlans/annual/offers/annual-half-price`]);
  });

  it('fixed prices: re-written by sync when they differ from the rule, and flagged when no longer below the base', async () => {
    store.seed('annual', pricedOffer('annual-fixed', { US: ['USD', '39.99'], GB: ['GBP', '29.99'] }));
    const fixed = (gb: string) =>
      rules([{ product: annual, kind: 'play.offer', key: 'annual-fixed', pricing: { type: 'fixed', prices: { US: '39.99', GB: gb } }, syncWithBase: true }]);
    expect((await adapter().planOfferSync({ rules: fixed('29.99'), createdAt: NOW })).entries[0].action).toBe('none');
    const sync = await adapter().planOfferSync({ rules: fixed('27.99'), createdAt: NOW });
    expect((sync.changeSet.ops[0] as PlayOfferOp).after!.phases[0].regions.GB).toEqual({ type: 'price', currency: 'GBP', amount: '27.99' });
    // The base drops below the fixed price: that region keeps its price and is listed, not written
    store.setBasePrice('annual', 'US', '35.99');
    const lowered = await adapter().planOfferSync({ rules: fixed('29.99'), createdAt: NOW });
    expect(lowered.changeSet.ops).toEqual([]);
    expect(lowered.changeSet.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ territory: 'US', reason: 'INVALID_TARGET', detail: expect.stringMatching(/not below the base price/) })]));
  });

  it('absolute discount: keeps the amount off across base changes, re-written when the amount differs', async () => {
    store.seed('annual', pricedOffer('annual-ten-off', { US: ['USD', '10'] }, 'absoluteDiscount'));
    const r = (amount: string) =>
      rules([{ product: annual, kind: 'play.offer', key: 'annual-ten-off', pricing: { type: 'play.absoluteDiscount', amounts: { US: amount } }, territories: ['US'], syncWithBase: true }]);
    store.setBasePrice('annual', 'US', '69.99');
    expect((await adapter().planOfferSync({ rules: r('10'), createdAt: NOW })).entries[0].action).toBe('none');
    const sync = await adapter().planOfferSync({ rules: r('15'), createdAt: NOW });
    expect((sync.changeSet.ops[0] as PlayOfferOp).after!.phases[0].regions.US).toEqual({ type: 'absoluteDiscount', currency: 'USD', amount: '15' });
  });

  it('reports missing offers, free trials and offers it cannot read, and never plans from a guess', async () => {
    store.seed('annual', trialOfferResource());
    store.seed('annual', { ...retentionOfferResource(), offerId: 'odd', somethingNew: 1 });
    const r = rules([
      { product: annual, kind: 'play.offer', key: 'nope', pricing: { type: 'play.relativeDiscount', fraction: '0.5' }, syncWithBase: true },
      { product: annual, kind: 'play.offer', key: 'new-customer-trial', pricing: { type: 'play.relativeDiscount', fraction: '0.5' }, syncWithBase: true },
      { product: annual, kind: 'play.offer', key: 'odd', pricing: { type: 'play.relativeDiscount', fraction: '0.5' }, syncWithBase: true },
    ]);
    const sync = await adapter().planOfferSync({ rules: r, createdAt: NOW });
    expect(sync.manualActions.map((m) => m.code)).toEqual(['OFFER_NOT_FOUND', 'RULE_NOT_APPLICABLE', 'OFFER_UNREADABLE']);
    expect(sync.manualActions[1].message).toMatch(/free trial/);
    expect(sync.changeSet.ops).toEqual([]);
  });
});
