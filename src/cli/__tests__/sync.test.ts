// pricingkit plan --rules, drift --rules, diff of a sync plan and apply,
// end to end against the in-memory offer store. The App Store client is
// mocked: nothing leaves the process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});

import { FakeOfferStore } from '@/lib/adapters/__tests__/fake-apple-offer-store';
import { changeSetHash, parseChangeSet, type OfferOp } from '@/lib/pricing';
import { fakeAppleEnv, run, tempDir } from './fixtures';

const BUNDLE = 'com.example.app';
const A = '9600000001';
const B = '9600000002';
const subA = { platform: 'apple', type: 'subscription', id: A };
const subB = { platform: 'apple', type: 'subscription', id: B };
const half = { type: 'percentOfCurrent', percent: '50', snap: 'nearest' };

let store: FakeOfferStore;
let env: Record<string, string>;
let tmp: ReturnType<typeof tempDir>;

function writeJson(name: string, value: unknown) {
  writeFileSync(join(tmp.dir, name), JSON.stringify(value));
}

const rulesFile = (offers: object[]) => ({ kind: 'pricingkit.offerRules', schemaVersion: 1, app: { bundleId: BUNDLE }, offers });
const promoRules = [
  { product: subA, kind: 'apple.promo', key: 'example_annual_50', pricing: half, syncWithBase: true },
  { product: subB, kind: 'apple.promo', key: 'example_annual_alt_50', pricing: half, syncWithBase: true },
];

beforeEach(async () => {
  store = new FakeOfferStore()
    .addSubscription(A, 'ONE_YEAR', { USA: '49.99', GBR: '44.99' }, { USA: ['24.99', '27.99', '49.99', '54.99'], GBR: ['22.99', '24.99', '44.99', '49.99'] })
    .addSubscription(B, 'ONE_YEAR', { USA: '39.99' }, { USA: ['19.99', '20.99', '39.99'] });
  store.seedPromo(A, 'example_annual_50', {}, { USA: '24.99', GBR: '22.99' }); // in step
  store.seedPromo(B, 'example_annual_alt_50', {}, { USA: '20.99' }); // drifted: the rule gives 19.99
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation(store.handle);
  env = await fakeAppleEnv();
  tmp = tempDir();
  writeJson('rules.json', rulesFile(promoRules));
});
afterEach(() => tmp.cleanup());

describe('pricingkit drift --rules', () => {
  it('checks every offer in the file, prints one report and exits 2 on drift', async () => {
    const r = await run(['drift', '--rules', 'rules.json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/DRIFT: 2 offers: 1 in sync, 1 drifted, 0 not found, 0 not checkable/);
    expect(r.stdout).toMatch(/9600000002\s+apple\.promo\s+example_annual_alt_50\s+drifted/);
    expect(r.stdout).not.toMatch(/Not checked/);
    const json = await run(['drift', '--rules', 'rules.json', '--json'], { env, cwd: tmp.dir });
    const report = JSON.parse(json.stdout);
    expect(report).toMatchObject({ kind: 'pricingkit.rulesDrift', inSync: false, summary: { offers: 2, inSync: 1, drifted: 1 } });
    expect(report.offers[1].report.kind).toBe('pricingkit.offerDrift');
    expect(store.writes()).toEqual([]);
  });

  it('exits 0 when every offer is in sync, 2 when one is missing, 1 when one only can’t be checked', async () => {
    writeJson('ok.json', rulesFile([promoRules[0]]));
    expect((await run(['drift', '--rules', 'ok.json'], { env, cwd: tmp.dir })).code).toBe(0);

    writeJson('missing.json', rulesFile([promoRules[0], { ...promoRules[0], key: 'nope' }]));
    const missing = await run(['drift', '--rules', 'missing.json'], { env, cwd: tmp.dir });
    expect(missing.code).toBe(2);
    expect(missing.stdout).toMatch(/nope\s+notFound/);

    store.seedIntro(A, 'USA', { offerMode: 'FREE_TRIAL', duration: 'ONE_WEEK' }, null);
    writeJson('trial.json', rulesFile([promoRules[0], { product: subA, kind: 'apple.intro', key: 'intro:FREE_TRIAL:ONE_WEEK:1::', pricing: half, syncWithBase: false }]));
    const trial = await run(['drift', '--rules', 'trial.json'], { env, cwd: tmp.dir });
    expect(trial.code).toBe(1);
    expect(trial.stdout).toMatch(/^NOT CHECKED: 2 offers/m);
    expect(trial.stdout).toMatch(/^ERRORS: 1 offer could not be checked:\n  9600000001 apple\.intro "intro:FREE_TRIAL:ONE_WEEK:1::": .*free trial/m);

    // Drift and an error: exit 2 for the drift, and the error is still printed up front
    writeJson('both.json', rulesFile([promoRules[1], { product: subA, kind: 'apple.intro', key: 'intro:FREE_TRIAL:ONE_WEEK:1::', pricing: half, syncWithBase: false }]));
    const both = await run(['drift', '--rules', 'both.json'], { env, cwd: tmp.dir });
    expect(both.code).toBe(2);
    expect(both.stdout).toMatch(/^DRIFT: 2 offers: 0 in sync, 1 drifted, 0 not found, 1 not checkable\nERRORS: 1 offer could not be checked \(the exit code reports the drift; fix these too\):/m);
  });

  it('refuses single-offer flags with --rules, an invalid rules file, and Play rules', async () => {
    const mixed = await run(['drift', '--rules', 'rules.json', '--percent', '50'], { env, cwd: tmp.dir });
    expect(mixed.code).toBe(1);
    expect(mixed.stderr).toMatch(/drop --percent/);
    writeJson('bad.json', { ...rulesFile(promoRules), schemaVersion: 2 });
    const bad = await run(['drift', '--rules', 'bad.json', '--json'], { env, cwd: tmp.dir });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout).error.code).toBe('INVALID_RULES');
    writeJson('play.json', { ...rulesFile(promoRules), app: { packageName: BUNDLE } });
    expect((await run(['drift', '--rules', 'play.json'], { env, cwd: tmp.dir })).stderr).toMatch(/a Google Play app \(packageName\) has play\.offer rules only/);
    const other = await run(['drift', '--rules', 'rules.json', '--bundle-id', 'com.example.other'], { env, cwd: tmp.dir });
    expect(other.stderr).toMatch(/not the app in the rules file/);
    expect(appleApiRequest).not.toHaveBeenCalled();
  });
});

describe('pricingkit plan --rules (on demand)', () => {
  it('writes an offer-only plan that re-prices the drifted offer, and apply applies it', async () => {
    const r = await run(['plan', '--rules', 'rules.json', '--out', 'sync.json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/example_annual_alt_50\s+op-0001: re-price 1 territories \(against current base prices\)/);
    expect(r.stdout).toMatch(/example_annual_50\s+in step with its rule/);
    expect(store.writes()).toEqual([]);
    const plan = parseChangeSet(readFileSync(join(tmp.dir, 'sync.json'), 'utf8'));
    expect(plan.ops.map((op) => op.kind)).toEqual(['updateOfferPrices']);

    const applied = await run(['apply', 'sync.json', '--confirm', changeSetHash(plan)], { env, cwd: tmp.dir });
    expect(applied.code).toBe(0);
    expect((await run(['drift', '--rules', 'rules.json'], { env, cwd: tmp.dir })).code).toBe(0);
  });

  it('lists offers the store cannot re-price as manual actions, in plan and diff', async () => {
    store.offers.push({
      id: 'code-1',
      subscriptionId: B,
      type: 'subscriptionOfferCodes',
      attributes: { name: 'CODE50', duration: 'ONE_YEAR', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, active: true, customerEligibilities: ['NEW'], offerEligibility: 'STACK_WITH_INTRO_OFFERS' },
      prices: [{ id: 'cp-1', alpha3: 'USA', pointId: store.point(B, 'USA', '20.99') }],
    });
    writeJson('codes.json', rulesFile([{ product: subB, kind: 'apple.offerCode', key: 'CODE50', pricing: half, syncWithBase: true }]));
    const r = await run(['plan', '--rules', 'codes.json', '--out', 'codes-plan.json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/No changes the plan can make itself/);
    expect(r.stdout).toMatch(/Needs manual action \(1 offers[\s\S]*CODE50 \(PRICES_IMMUTABLE\): .*create a new offer code/);
    const diff = await run(['diff', 'codes-plan.json', '--json'], { env: {}, cwd: tmp.dir });
    expect(diff.code).toBe(2);
    expect(JSON.parse(diff.stdout).manualActions).toEqual([expect.objectContaining({ code: 'PRICES_IMMUTABLE', territories: ['US'] })]);
  });
});

describe('pricingkit plan --spec <base> --rules', () => {
  const baseSpec = (extra: object = {}) => ({
    kind: 'pricingkit.spec',
    schemaVersion: 1,
    app: { bundleId: BUNDLE },
    products: [{ product: subA, targets: { type: 'fixed', prices: { US: '54.99', GB: '49.99' } }, ...extra }],
  });

  it('plans base prices and the offers derived from them in one plan; diff groups them; apply needs --allow-base-prices', async () => {
    writeJson('base.json', baseSpec());
    const r = await run(['plan', '--spec', 'base.json', '--rules', 'rules.json', '--out', 'both.json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/example_annual_50\s+op-0003: re-price 2 territories \(against this plan's base prices\)/);
    expect(r.stdout).toMatch(/"pricingkit apply" applies it only with --allow-base-prices/);
    const plan = parseChangeSet(readFileSync(join(tmp.dir, 'both.json'), 'utf8'));
    expect(plan.ops.map((op) => op.kind)).toEqual(['setPrice', 'setPrice', 'updateOfferPrices', 'updateOfferPrices']);
    const offerA = plan.ops[2] as OfferOp;
    expect(offerA.after!.prices.US.amount).toBe('27.99'); // 50% of the new 54.99, not of 49.99
    expect(offerA.dependsOn).toEqual(['op-0001', 'op-0002']);

    const diff = await run(['diff', 'both.json'], { env: {}, cwd: tmp.dir });
    expect(diff.stdout).toMatch(/Base prices \(2 changes, applied first\)[\s\S]*Offers \(2 ops, applied after the base prices\)/);
    expect(diff.stdout).toMatch(/Applied only once its base prices are: op-0003 after op-0001, op-0002/);
    const summary = JSON.parse((await run(['diff', 'both.json', '--json'], { env: {}, cwd: tmp.dir })).stdout);
    expect(summary.byGroup).toEqual({ basePrices: 2, offers: 2 });

    const apply = await run(['apply', 'both.json', '--confirm', changeSetHash(plan)], { env, cwd: tmp.dir });
    expect(apply.code).toBe(1);
    expect(apply.stderr).toMatch(/Pass --allow-base-prices/);
    expect(store.writes()).toEqual([]);

    const allowed = await run(['apply', 'both.json', '--confirm', changeSetHash(plan), '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(allowed.code).toBe(0);
    // Base prices first; B's offer (no base change) in the same round after them; A's offer, derived
    // from the new base prices, only in the next round
    expect(store.writes()).toEqual(['POST /subscriptionPrices', 'POST /subscriptionPrices', `PATCH /subscriptionPromotionalOffers/${store.offers[1].id}`, `PATCH /subscriptionPromotionalOffers/${store.offers[0].id}`]);
    expect(allowed.stdout).toMatch(/not yet confirmed on a test app/);
    expect((await run(['drift', '--rules', 'rules.json'], { env, cwd: tmp.dir })).code).toBe(0);
  });

  it('holds offers over base prices scheduled for later, unless --scheduled-base now', async () => {
    writeJson('later.json', baseSpec({ startDate: '2030-06-01' }));
    const held = await run(['plan', '--spec', 'later.json', '--rules', 'rules.json', '--out', 'held.json', '--json'], { env, cwd: tmp.dir });
    const heldOut = JSON.parse(held.stdout);
    expect(heldOut.changeSet.ops.map((op: { kind: string }) => op.kind)).toEqual(['schedulePrice', 'schedulePrice', 'updateOfferPrices']);
    expect(heldOut.manualActions).toEqual([expect.objectContaining({ code: 'BASE_SCHEDULED', offer: { kind: 'apple.promo', key: 'example_annual_50' } })]);

    const now = await run(['plan', '--spec', 'later.json', '--rules', 'rules.json', '--scheduled-base', 'now', '--out', 'now.json', '--json'], { env, cwd: tmp.dir });
    const nowOut = JSON.parse(now.stdout);
    expect(nowOut.manualActions).toEqual([]);
    expect(nowOut.changeSet.warnings).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/before the base prices change/) }));

    const bad = await run(['plan', '--rules', 'rules.json', '--scheduled-base', 'later'], { env, cwd: tmp.dir });
    expect(bad.stderr).toMatch(/--scheduled-base must be hold \(default\) or now/);
    const noRules = await run(['plan', '--spec', 'later.json', '--scheduled-base', 'now'], { env, cwd: tmp.dir });
    expect(noRules.stderr).toMatch(/--scheduled-base goes with --rules/);
  });

  it('refuses an offer plan spec or a spec for another app with --rules', async () => {
    writeJson('offers.json', { kind: 'pricingkit.offerPlanSpec', schemaVersion: 1, app: { bundleId: BUNDLE }, offers: [] });
    expect((await run(['plan', '--spec', 'offers.json', '--rules', 'rules.json'], { env, cwd: tmp.dir })).stderr).toMatch(/base-price spec/);
    writeJson('other.json', { ...baseSpec(), app: { bundleId: 'com.example.other' } });
    expect((await run(['plan', '--spec', 'other.json', '--rules', 'rules.json'], { env, cwd: tmp.dir })).stderr).toMatch(/different apps/);
    expect(store.writes()).toEqual([]);
  });
});
