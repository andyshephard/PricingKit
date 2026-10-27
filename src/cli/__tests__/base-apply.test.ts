// pricingkit apply --allow-base-prices: base-price plans end to end against
// the in-memory stores (App Store and Google Play), with the offer safety
// model: confirm hash, run log, resume, undo, ownership, app pins and
// dependsOn with offers. Both store clients are mocked: nothing leaves the
// process.
//
// The App Store fake encodes two UNVERIFIED behaviours (see CLAUDE.md): an
// immediate price create replaces the territory's current price, and a
// second scheduled price can exist until the old one is deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});
const googlePlayFetch = vi.fn();
vi.mock('@/lib/google-play/client', () => ({ googlePlayFetch: (...args: unknown[]) => googlePlayFetch(...args) }));

import { FakeOfferStore } from '@/lib/adapters/__tests__/fake-apple-offer-store';
import { FakePlayOffers, PKG, PRODUCT } from '@/lib/adapters/__tests__/fake-play-offers';
import { basePriceOps, changeSetHash, parseChangeSet, parseRun } from '@/lib/pricing';
import { fakeAppleEnv, run, tempDir, throwawayRsaPem } from './fixtures';

const BUNDLE = 'com.example.app';
const A = '9700000001';
const subA = { platform: 'apple', type: 'subscription', id: A };

let store: FakeOfferStore;
let env: Record<string, string>;
let tmp: ReturnType<typeof tempDir>;

function writeJson(name: string, value: unknown) {
  writeFileSync(join(tmp.dir, name), JSON.stringify(value));
}
const readPlan = (name: string) => parseChangeSet(readFileSync(join(tmp.dir, name), 'utf8'));
const baseSpec = (prices: Record<string, string>, extra: object = {}) => ({
  kind: 'pricingkit.spec',
  schemaVersion: 1,
  app: { bundleId: BUNDLE },
  products: [{ product: subA, targets: { type: 'fixed', prices }, ...extra }],
});

async function planBase(prices: Record<string, string>, out = 'base-plan.json', extra: object = {}) {
  writeJson('base.json', baseSpec(prices, extra));
  const r = await run(['plan', '--spec', 'base.json', '--out', out], { env, cwd: tmp.dir });
  const plan = readPlan(out);
  return { r, plan, hash: changeSetHash(plan) };
}

beforeEach(async () => {
  store = new FakeOfferStore().addSubscription(A, 'ONE_YEAR', { USA: '49.99', GBR: '44.99' }, { USA: ['24.99', '27.99', '49.99', '54.99'], GBR: ['22.99', '24.99', '44.99', '49.99'] });
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation(store.handle);
  googlePlayFetch.mockReset();
  env = await fakeAppleEnv();
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

describe('apply --allow-base-prices (App Store)', () => {
  it('plan prints how to apply it; apply writes, logs the run, and a second apply changes nothing', async () => {
    const { r, plan, hash } = await planBase({ US: '54.99', GB: '49.99' });
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/applies it only with --allow-base-prices/);
    expect(r.stdout).toMatch(/not yet confirmed on a test app/);
    expect(plan.ops.map((op) => op.kind)).toEqual(['setPrice', 'setPrice']);

    const applied = await run(['apply', 'base-plan.json', '--confirm', hash, '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(applied.code).toBe(0);
    expect(store.writes()).toEqual(['POST /subscriptionPrices', 'POST /subscriptionPrices']);
    expect(store.subs.get(A)!.base).toEqual({ USA: '54.99', GBR: '49.99' });
    const log = parseRun(readFileSync(join(tmp.dir, 'base-plan.run.json'), 'utf8'));
    expect(log.ops.map((o) => [o.status, o.attempts, o.verified])).toEqual([
      ['ok', 1, true],
      ['ok', 1, true],
    ]);

    const again = await run(['apply', 'base-plan.json', '--confirm', hash, '--allow-base-prices', '--run-out', 'again.json', '--json'], { env, cwd: tmp.dir });
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout).ops.map((o: { skipReason?: string }) => o.skipReason)).toEqual(['ALREADY_AT_TARGET', 'ALREADY_AT_TARGET']);
    expect(store.writes()).toHaveLength(2);
  });

  it('checks the confirm hash before anything else, and never prints it', async () => {
    const { hash } = await planBase({ US: '54.99' });
    const calls = appleApiRequest.mock.calls.length;
    const wrong = await run(['apply', 'base-plan.json', '--confirm', 'f'.repeat(16), '--allow-base-prices', '--json'], { env, cwd: tmp.dir });
    expect(wrong.code).toBe(1);
    expect(JSON.parse(wrong.stdout).error.code).toBe('CONFIRM_MISMATCH');
    expect(`${wrong.stdout}${wrong.stderr}`).not.toContain(hash);
    expect(appleApiRequest.mock.calls.length).toBe(calls);
  });

  it('resumes after a create that took effect but errored, without sending it again', async () => {
    const { hash } = await planBase({ US: '54.99', GB: '49.99' });
    store.failures.push({ method: 'POST', path: /^\/subscriptionPrices$/, status: 504, afterWrite: true });
    const first = await run(['apply', 'base-plan.json', '--confirm', hash, '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(first.code).toBe(1);
    // The printed resume command keeps the opt-in
    expect(first.stdout).toContain(`Resume with: pricingkit apply base-plan.json --confirm ${hash} --resume base-plan.run.json --allow-base-prices`);
    const failedLog = parseRun(readFileSync(join(tmp.dir, 'base-plan.run.json'), 'utf8'));
    expect(failedLog.ops.map((o) => o.status)).toEqual(['failed', 'ok']);

    const resumed = await run(['apply', 'base-plan.json', '--confirm', hash, '--resume', 'base-plan.run.json', '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(resumed.code).toBe(0);
    expect(store.writes()).toEqual(['POST /subscriptionPrices', 'POST /subscriptionPrices']);
    const log = parseRun(readFileSync(join(tmp.dir, 'base-plan.run.json'), 'utf8'));
    expect(log.ops[0]).toMatchObject({ status: 'ok', attempts: 1, response: { confirmedOnResume: true } });
    expect(log.passes).toBe(2);

    // The resume also needs the opt-in
    const noFlag = await run(['apply', 'base-plan.json', '--confirm', hash, '--resume', 'base-plan.run.json'], { env, cwd: tmp.dir });
    expect(noFlag.stderr).toMatch(/Pass --allow-base-prices/);
  });

  it('undo builds a base-price plan that restores the old prices, applied with the same opt-in', async () => {
    const { hash } = await planBase({ US: '54.99', GB: '49.99' });
    await run(['apply', 'base-plan.json', '--confirm', hash, '--allow-base-prices'], { env, cwd: tmp.dir });
    const undo = await run(['undo', 'base-plan.json', 'base-plan.run.json'], { env: {}, cwd: tmp.dir });
    expect(undo.code).toBe(2);
    const undoPlan = readPlan('base-plan.undo.json');
    expect(undo.stdout).toContain(`pricingkit apply base-plan.undo.json --confirm <the plan hash above> --allow-base-prices`);
    // Newest first: the run wrote GB, then US
    expect(basePriceOps(undoPlan).map((op) => [op.target.territory, op.kind, op.after!.amount])).toEqual([
      ['US', 'setPrice', '49.99'],
      ['GB', 'setPrice', '44.99'],
    ]);
    const reverted = await run(['apply', 'base-plan.undo.json', '--confirm', changeSetHash(undoPlan), '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(reverted.code).toBe(0);
    expect(store.subs.get(A)!.base).toEqual({ USA: '49.99', GBR: '44.99' });
  });

  it('replaces a scheduled price create-first, delete-after, and undo puts the old one back', async () => {
    const first = await planBase({ US: '54.99' }, 'sched-1.json', { startDate: '2030-06-01' });
    expect(first.plan.ops.map((op) => op.kind)).toEqual(['schedulePrice']);
    expect((await run(['apply', 'sched-1.json', '--confirm', first.hash, '--allow-base-prices'], { env, cwd: tmp.dir })).code).toBe(0);
    const second = await planBase({ US: '27.99' }, 'sched-2.json', { startDate: '2030-06-01' });
    expect((await run(['apply', 'sched-2.json', '--confirm', second.hash, '--allow-base-prices'], { env, cwd: tmp.dir })).code).toBe(0);
    expect(store.writes()).toEqual(['POST /subscriptionPrices', 'POST /subscriptionPrices', 'DELETE /subscriptionPrices/sp-1']);
    expect(store.subs.get(A)!.scheduled).toEqual({ USA: [{ id: 'sp-2', price: '27.99', startDate: '2030-06-01' }] });

    await run(['undo', 'sched-2.json', 'sched-2.run.json'], { env: {}, cwd: tmp.dir });
    const undoPlan = readPlan('sched-2.undo.json');
    expect((await run(['apply', 'sched-2.undo.json', '--confirm', changeSetHash(undoPlan), '--allow-base-prices'], { env, cwd: tmp.dir })).code).toBe(0);
    expect(store.subs.get(A)!.scheduled!.USA.map((e) => e.price)).toEqual(['54.99']);
  });

  it('refuses a subscription of another app (ownership) before writing', async () => {
    const { hash } = await planBase({ US: '54.99' });
    store.subs.get(A)!.group = 'group-of-another-app';
    const r = await run(['apply', 'base-plan.json', '--confirm', hash, '--allow-base-prices', '--json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).ops[0]).toMatchObject({ status: 'failed', error: { code: 'APP_MISMATCH' } });
    expect(store.writes()).toEqual([]);
  });

  it('honours PRICINGKIT_EXPECT_BUNDLE_ID before anything is read', async () => {
    const { hash } = await planBase({ US: '54.99' });
    const calls = appleApiRequest.mock.calls.length;
    const r = await run(['apply', 'base-plan.json', '--confirm', hash, '--allow-base-prices', '--json'], { env: { ...env, PRICINGKIT_EXPECT_BUNDLE_ID: 'com.example.other' }, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe('APP_NOT_EXPECTED');
    expect(appleApiRequest.mock.calls.length).toBe(calls);
  });

  it('with synced offers: an offer whose base price failed is not sent (BASE_NOT_APPLIED), and resumes after the base', async () => {
    store.seedPromo(A, 'example_annual_50', {}, { USA: '24.99', GBR: '22.99' });
    writeJson('rules.json', {
      kind: 'pricingkit.offerRules',
      schemaVersion: 1,
      app: { bundleId: BUNDLE },
      offers: [{ product: subA, kind: 'apple.promo', key: 'example_annual_50', pricing: { type: 'percentOfCurrent', percent: '50', snap: 'nearest' }, syncWithBase: true }],
    });
    writeJson('base.json', baseSpec({ US: '54.99', GB: '49.99' }));
    await run(['plan', '--spec', 'base.json', '--rules', 'rules.json', '--out', 'both.json'], { env, cwd: tmp.dir });
    const plan = readPlan('both.json');
    expect(plan.ops.map((op) => [op.kind, op.dependsOn ?? []])).toEqual([
      ['setPrice', []],
      ['setPrice', []],
      ['updateOfferPrices', ['op-0001', 'op-0002']],
    ]);
    const hash = changeSetHash(plan);

    // GB's base price is refused: the offer derived from it must wait
    store.failures.push({ method: 'POST', path: /^\/subscriptionPrices$/, status: 409 });
    const first = await run(['apply', 'both.json', '--confirm', hash, '--allow-base-prices', '--json'], { env, cwd: tmp.dir });
    expect(first.code).toBe(1);
    const log = JSON.parse(first.stdout);
    expect(log.ops.map((o: { status: string; error?: { code?: string } }) => [o.status, o.error?.code])).toEqual([
      ['failed', 'ENTITY_ERROR'],
      ['ok', undefined],
      ['failed', 'BASE_NOT_APPLIED'],
    ]);
    expect(store.writes()).toEqual(['POST /subscriptionPrices', 'POST /subscriptionPrices']);

    const resumed = await run(['apply', 'both.json', '--confirm', hash, '--allow-base-prices', '--resume', 'both.run.json'], { env, cwd: tmp.dir });
    expect(resumed.code).toBe(0);
    expect(store.writes().slice(2)).toEqual(['POST /subscriptionPrices', `PATCH /subscriptionPromotionalOffers/${store.offers[0].id}`]);

    // Undo reverts the offer first, then the base prices (reversed dependencies)
    await run(['undo', 'both.json', 'both.run.json'], { env: {}, cwd: tmp.dir });
    const undo = readPlan('both.undo.json');
    const offerRevert = undo.ops.find((op) => op.kind === 'updateOfferPrices')!;
    for (const op of undo.ops.filter((o) => o.kind === 'setPrice')) expect(op.dependsOn).toEqual([offerRevert.id]);
  });
});

describe('apply --allow-base-prices (Google Play)', () => {
  let play: FakePlayOffers;

  beforeEach(async () => {
    play = new FakePlayOffers();
    googlePlayFetch.mockImplementation(play.handle);
    env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        type: 'service_account',
        client_email: 'robot@example-project.iam.gserviceaccount.com',
        private_key_id: 'abcdef0123456789',
        private_key: await throwawayRsaPem(),
      }),
    };
  });

  it('patches the base plan with the recorded regions version, is idempotent, and undo restores it', async () => {
    writeJson('play.json', {
      kind: 'pricingkit.spec',
      schemaVersion: 1,
      app: { packageName: PKG },
      products: [{ product: { platform: 'google', type: 'subscription', productId: PRODUCT, basePlanId: 'annual' }, targets: { type: 'fixed', prices: { US: '64.99' } } }],
    });
    const r = await run(['plan', '--spec', 'play.json', '--out', 'play-plan.json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).not.toMatch(/not yet confirmed on a test app/); // the caveat is App Store only
    const plan = readPlan('play-plan.json');
    const hash = changeSetHash(plan);
    expect((await run(['apply', 'play-plan.json', '--confirm', hash], { env, cwd: tmp.dir })).stderr).toMatch(/--allow-base-prices/);
    expect(play.writes()).toEqual([]);

    const applied = await run(['apply', 'play-plan.json', '--confirm', hash, '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(applied.code).toBe(0);
    expect(play.writes()).toEqual([`PATCH ${PRODUCT}`]);
    const patch = play.calls.find((c) => c.method === 'PATCH')!;
    expect((patch.query as Record<string, unknown>)['regionsVersion.version']).toBeDefined();

    const again = await run(['apply', 'play-plan.json', '--confirm', hash, '--allow-base-prices', '--run-out', 'again.json'], { env, cwd: tmp.dir });
    expect(again.code).toBe(0);
    expect(play.writes()).toHaveLength(1);

    await run(['undo', 'play-plan.json', 'play-plan.run.json'], { env: {}, cwd: tmp.dir });
    const undo = readPlan('play-plan.undo.json');
    expect((await run(['apply', 'play-plan.undo.json', '--confirm', changeSetHash(undo), '--allow-base-prices'], { env, cwd: tmp.dir })).code).toBe(0);
    const annual = (play.subscription.basePlans as Array<{ basePlanId: string; regionalConfigs: Array<{ regionCode: string; price: { units: string } }> }>).find((bp) => bp.basePlanId === 'annual')!;
    expect(annual.regionalConfigs.find((c) => c.regionCode === 'US')!.price.units).toBe('59');
  });

  it('honours PRICINGKIT_EXPECT_PACKAGE before anything is read', async () => {
    writeJson('plan.json', { schemaVersion: 1, kind: 'pricingkit.changeset', id: 'p', createdAt: 'x', app: { packageName: PKG }, ops: [] });
    const r = await run(['apply', 'plan.json', '--confirm', changeSetHash(readPlan('plan.json')), '--allow-base-prices', '--json'], {
      env: { ...env, PRICINGKIT_EXPECT_PACKAGE: 'com.example.other' },
      cwd: tmp.dir,
    });
    expect(JSON.parse(r.stdout).error.code).toBe('APP_NOT_EXPECTED');
    expect(googlePlayFetch).not.toHaveBeenCalled();
  });
});
