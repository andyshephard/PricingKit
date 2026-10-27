// pricingkit offer deactivate|activate|delete: lifecycle plans for App Store
// and Google Play offers, applied with the usual apply --confirm, against the
// in-memory stores. Both store clients are mocked: nothing leaves the process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});
const googlePlayFetch = vi.fn();
vi.mock('@/lib/google-play/client', () => ({ googlePlayFetch: (...args: unknown[]) => googlePlayFetch(...args) }));

import { FakeOfferStore } from '@/lib/adapters/__tests__/fake-apple-offer-store';
import { FakePlayOffers, PKG, PRODUCT, retentionOfferResource } from '@/lib/adapters/__tests__/fake-play-offers';
import { changeSetHash, parseChangeSet } from '@/lib/pricing';
import { fakeAppleEnv, run, tempDir, throwawayRsaPem } from './fixtures';

const BUNDLE = 'com.example.app';
const A = '9800000001';
let tmp: ReturnType<typeof tempDir>;
const readPlan = (name: string) => parseChangeSet(readFileSync(join(tmp.dir, name), 'utf8'));

beforeEach(() => {
  appleApiRequest.mockReset();
  googlePlayFetch.mockReset();
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

describe('pricingkit offer (App Store)', () => {
  let store: FakeOfferStore;
  let env: Record<string, string>;
  const apple = (action: string, ...rest: string[]) => ['offer', action, '--bundle-id', BUNDLE, '--subscription', A, ...rest];

  beforeEach(async () => {
    store = new FakeOfferStore().addSubscription(A, 'ONE_YEAR', { USA: '49.99' }, { USA: ['19.99', '24.99', '49.99'] });
    store.offers.push({
      id: 'code-1',
      subscriptionId: A,
      type: 'subscriptionOfferCodes',
      attributes: { name: 'CODE50', duration: 'ONE_YEAR', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, active: true, customerEligibilities: ['NEW'], offerEligibility: 'STACK_WITH_INTRO_OFFERS' },
      prices: [{ id: 'cp-1', alpha3: 'USA', pointId: store.point(A, 'USA', '24.99') }],
    });
    store.seedPromo(A, 'example_half', {}, { USA: '24.99' });
    appleApiRequest.mockImplementation(store.handle);
    env = await fakeAppleEnv();
  });

  it('deactivate writes a plan (no store writes), apply switches the code off, undo switches it back on', async () => {
    const r = await run([...apple('deactivate', '--kind', 'apple.offerCode', '--offer', 'CODE50', '--out', 'off.json')], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    const plan = readPlan('off.json');
    const hash = changeSetHash(plan);
    expect(plan.ops.map((op) => op.kind)).toEqual(['deactivateOffer']);
    expect(r.stdout).toContain(`pricingkit apply off.json --confirm ${hash}`);
    expect(r.stdout).toContain('Dry run: nothing was changed in the store.');
    expect(store.writes()).toEqual([]);

    expect((await run(['apply', 'off.json', '--confirm', hash], { env, cwd: tmp.dir })).code).toBe(0);
    expect(store.writes()).toEqual(['PATCH /subscriptionOfferCodes/code-1']);
    expect(store.offers.find((o) => o.id === 'code-1')!.attributes.active).toBe(false);

    const undo = await run(['undo', 'off.json', 'off.run.json'], { env: {}, cwd: tmp.dir });
    expect(undo.code).toBe(2);
    const undoPlan = readPlan('off.undo.json');
    expect(undoPlan.ops.map((op) => op.kind)).toEqual(['activateOffer']);
    expect((await run(['apply', 'off.undo.json', '--confirm', changeSetHash(undoPlan)], { env, cwd: tmp.dir })).code).toBe(0);
    expect(store.offers.find((o) => o.id === 'code-1')!.attributes.active).toBe(true);

    // Already active: nothing to plan, refused with the reason
    const again = await run([...apple('activate', '--kind', 'apple.offerCode', '--offer', 'CODE50', '--out', 'on.json', '--json')], { env, cwd: tmp.dir });
    expect(again.code).toBe(1);
    expect(JSON.parse(again.stdout).error).toMatchObject({ code: 'OFFER_LIFECYCLE_REFUSED', message: expect.stringMatching(/already active/) });
    expect(existsSync(join(tmp.dir, 'on.json'))).toBe(false);
  });

  it('delete needs --force-delete at apply, and prints it in the apply command', async () => {
    const r = await run([...apple('delete', '--kind', 'apple.promo', '--offer', 'example_half', '--out', 'del.json')], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    const hash = changeSetHash(readPlan('del.json'));
    expect(r.stdout).toContain(`pricingkit apply del.json --confirm ${hash} --force-delete`);
    const refused = await run(['apply', 'del.json', '--confirm', hash, '--json'], { env, cwd: tmp.dir });
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout).ops[0].error.code).toBe('REDEMPTIONS_UNCHECKED');
    expect(store.writes()).toEqual([]);
    const forced = await run(['apply', 'del.json', '--confirm', hash, '--force-delete', '--run-out', 'del2.run.json'], { env, cwd: tmp.dir });
    expect(forced.code).toBe(0);
    expect(store.writes()).toEqual([expect.stringMatching(/^DELETE \/subscriptionPromotionalOffers\/promo-\d+$/)]);
    expect(store.offers.some((o) => o.attributes.offerCode === 'example_half')).toBe(false);
  });

  it("refuses what the store doesn't allow, with the reason, and writes no plan", async () => {
    const promo = await run([...apple('deactivate', '--kind', 'apple.promo', '--offer', 'example_half', '--out', 'x.json')], { env, cwd: tmp.dir });
    expect(promo.code).toBe(1);
    expect(promo.stderr).toMatch(/promotional offers have no active switch/);
    const code = await run([...apple('delete', '--kind', 'apple.offerCode', '--offer', 'CODE50', '--out', 'x.json')], { env, cwd: tmp.dir });
    expect(code.stderr).toMatch(/can't delete an offer code/);
    const missing = await run([...apple('delete', '--kind', 'apple.promo', '--offer', 'nope', '--out', 'x.json')], { env, cwd: tmp.dir });
    expect(missing.stderr).toMatch(/No promotional offer "nope"/);
    expect(existsSync(join(tmp.dir, 'x.json'))).toBe(false);
    expect(store.writes()).toEqual([]);
  });

  it('intro and win-back deactivation set an end date, which --end-date must give', async () => {
    store.seedIntro(A, 'USA', { offerMode: 'PAY_UP_FRONT', duration: 'ONE_YEAR' }, '19.99');
    const key = 'intro:PAY_UP_FRONT:P1Y:1:';
    const usage = await run([...apple('deactivate', '--kind', 'apple.intro', '--offer', key)], { env, cwd: tmp.dir });
    expect(usage.code).toBe(1);
    expect(usage.stderr).toMatch(/pass --end-date/);
    const badDate = await run([...apple('deactivate', '--kind', 'apple.intro', '--offer', key, '--end-date', 'June')], { env, cwd: tmp.dir });
    expect(badDate.stderr).toMatch(/--end-date must be a date/);
    const wrongKind = await run([...apple('deactivate', '--kind', 'apple.offerCode', '--offer', 'CODE50', '--end-date', '2030-06-01')], { env, cwd: tmp.dir });
    expect(wrongKind.stderr).toMatch(/--end-date goes with deactivate, for introductory and win-back offers/);

    const r = await run([...apple('deactivate', '--kind', 'apple.intro', '--offer', key, '--end-date', '2030-06-01', '--out', 'end.json')], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    const plan = readPlan('end.json');
    expect((await run(['apply', 'end.json', '--confirm', changeSetHash(plan)], { env, cwd: tmp.dir })).code).toBe(0);
    expect(store.intros[0].attributes.endDate).toBe('2030-06-01');
  });

  it('never replaces the default plan file without --force, and checks its arguments', async () => {
    writeFileSync(join(tmp.dir, 'pricingkit-plan.json'), 'keep');
    const kept = await run([...apple('deactivate', '--kind', 'apple.offerCode', '--offer', 'CODE50')], { env, cwd: tmp.dir });
    expect(kept.stderr).toMatch(/already exists/);
    expect(readFileSync(join(tmp.dir, 'pricingkit-plan.json'), 'utf8')).toBe('keep');
    const forced = await run([...apple('deactivate', '--kind', 'apple.offerCode', '--offer', 'CODE50', '--force')], { env, cwd: tmp.dir });
    expect(forced.code).toBe(2);

    expect((await run(['offer', 'pause', '--bundle-id', BUNDLE], { env, cwd: tmp.dir })).stderr).toMatch(/Give an action: pricingkit offer deactivate\|activate\|delete/);
    expect((await run([...apple('delete', '--offer', 'x', '--out', 'y.json')], { env, cwd: tmp.dir })).stderr).toMatch(/--kind is required/);
    expect((await run([...apple('delete', '--kind', 'apple.promo', '--out', 'y.json')], { env, cwd: tmp.dir })).stderr).toMatch(/--offer is required/);
    const pinned = await run([...apple('delete', '--kind', 'apple.promo', '--offer', 'x', '--out', 'y.json', '--json')], { env: { ...env, PRICINGKIT_EXPECT_BUNDLE_ID: 'com.example.other' }, cwd: tmp.dir });
    expect(JSON.parse(pinned.stdout).error.code).toBe('APP_NOT_EXPECTED');
  });

  it('refuses a subscription of another app before reading its offers', async () => {
    store.subs.get(A)!.group = 'group-of-another-app';
    const r = await run([...apple('deactivate', '--kind', 'apple.offerCode', '--offer', 'CODE50', '--json')], { env, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe('APP_MISMATCH');
    expect(store.calls.some((c) => c.endpoint.endsWith('/offerCodes'))).toBe(false);
  });
});

describe('pricingkit offer (Google Play)', () => {
  let store: FakePlayOffers;
  let env: Record<string, string>;
  const play = (action: string, ...rest: string[]) => ['offer', action, '--package-name', PKG, '--subscription', PRODUCT, '--base-plan', 'annual', ...rest];

  beforeEach(async () => {
    store = new FakePlayOffers();
    store.seed('annual', retentionOfferResource('ACTIVE'));
    googlePlayFetch.mockImplementation(store.handle);
    env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        type: 'service_account',
        client_email: 'robot@example-project.iam.gserviceaccount.com',
        private_key_id: 'abcdef0123456789',
        private_key: await throwawayRsaPem(),
      }),
    };
  });

  it('deactivates an active offer through apply, and undo re-activates it', async () => {
    const r = await run([...play('deactivate', '--offer', 'annual-half-off', '--out', 'off.json')], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/State: ACTIVE -> INACTIVE/);
    expect(store.writes()).toEqual([]);
    const plan = readPlan('off.json');
    expect((await run(['apply', 'off.json', '--confirm', changeSetHash(plan)], { env, cwd: tmp.dir })).code).toBe(0);
    expect(store.offer('annual', 'annual-half-off')!.state).toBe('INACTIVE');
    await run(['undo', 'off.json', 'off.run.json'], { env: {}, cwd: tmp.dir });
    const undo = readPlan('off.undo.json');
    expect((await run(['apply', 'off.undo.json', '--confirm', changeSetHash(undo)], { env, cwd: tmp.dir })).code).toBe(0);
    expect(store.offer('annual', 'annual-half-off')!.state).toBe('ACTIVE');
  });

  it('deletes drafts only, and only with --force-delete', async () => {
    const active = await run([...play('delete', '--offer', 'annual-half-off', '--out', 'x.json')], { env, cwd: tmp.dir });
    expect(active.code).toBe(1);
    expect(active.stderr).toMatch(/deletes only draft offers/);

    store.seed('annual', { ...retentionOfferResource('DRAFT'), offerId: 'draft-offer' });
    const r = await run([...play('delete', '--offer', 'draft-offer', '--out', 'del.json')], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    const hash = changeSetHash(readPlan('del.json'));
    expect(r.stdout).toContain(`--confirm ${hash} --force-delete`);
    expect((await run(['apply', 'del.json', '--confirm', hash], { env, cwd: tmp.dir })).code).toBe(1);
    expect(store.offer('annual', 'draft-offer')).toBeDefined();
    expect((await run(['apply', 'del.json', '--confirm', hash, '--force-delete', '--run-out', 'del2.json'], { env, cwd: tmp.dir })).code).toBe(0);
    expect(store.offer('annual', 'draft-offer')).toBeUndefined();
  });

  it('refuses App Store-only flags', async () => {
    expect((await run([...play('deactivate', '--offer', 'annual-half-off', '--end-date', '2030-01-01')], { env, cwd: tmp.dir })).stderr).toMatch(/--end-date is for App Store/);
    expect((await run([...play('deactivate', '--offer', 'annual-half-off', '--kind', 'apple.promo')], { env, cwd: tmp.dir })).stderr).toMatch(/--kind can only be play.offer/);
    expect(googlePlayFetch).not.toHaveBeenCalled();
  });
});
