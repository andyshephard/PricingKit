// pricingkit plan (offer plan spec) and pricingkit apply, end to end against
// the in-memory offer store. The App Store client is mocked: nothing leaves
// the process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});

import { FakeOfferStore } from '@/lib/adapters/__tests__/fake-apple-offer-store';
import { changeSetHash, parseChangeSet, parseRun } from '@/lib/pricing';
import { fakeAppleEnv, run, tempDir } from './fixtures';

const BUNDLE = 'com.example.app';
const A = '9300000001';
const B = '9300000002';

let store: FakeOfferStore;
let env: Record<string, string>;
let tmp: ReturnType<typeof tempDir>;

const offer = (id: string, code: string) => ({
  id: code,
  productRef: { platform: 'apple', type: 'subscription', id },
  kind: 'apple.promo',
  mode: 'PAY_UP_FRONT',
  duration: 'P1Y',
  pricing: { type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'nearest' },
  territories: 'all',
  syncWithBase: true,
});

beforeEach(async () => {
  store = new FakeOfferStore()
    .addSubscription(A, 'ONE_YEAR', { USA: '49.99', GBR: '44.99' }, { USA: ['24.99', '25.99', '49.99'], GBR: ['21.99', '22.99', '44.99'] })
    .addSubscription(B, 'ONE_YEAR', { USA: '39.99' }, { USA: ['19.99', '20.99', '39.99'] });
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation(store.handle);
  env = await fakeAppleEnv();
  tmp = tempDir();
  writeFileSync(
    join(tmp.dir, 'offers.json'),
    JSON.stringify({ kind: 'pricingkit.offerPlanSpec', schemaVersion: 1, app: { bundleId: BUNDLE }, offers: [offer(A, 'example_annual_50'), offer(B, 'example_annual_alt_50')] })
  );
});
afterEach(() => tmp.cleanup());

async function planFile() {
  const r = await run(['plan', '--spec', 'offers.json', '--out', 'plan.json'], { env, cwd: tmp.dir });
  const plan = parseChangeSet(readFileSync(join(tmp.dir, 'plan.json'), 'utf8'));
  return { r, plan, hash: changeSetHash(plan) };
}

describe('pricingkit plan with an offer plan spec', () => {
  it('writes a dry-run plan for both products and prints the hash to confirm', async () => {
    const { r, plan, hash } = await planFile();
    expect(r.code).toBe(2);
    expect(plan.ops.map((op) => op.kind)).toEqual(['createOffer', 'createOffer']);
    expect(r.stdout).toContain(`Plan hash: ${hash}`);
    expect(r.stdout).toMatch(/createOffer apple.promo example_annual_alt_50/);
    expect(r.stdout).toContain('Dry run: nothing was changed in the store.');
    expect(store.writes()).toEqual([]);
  });
});

describe('pricingkit apply', () => {
  it('refuses without --confirm or with the wrong hash, before any store request', async () => {
    await planFile();
    const calls = appleApiRequest.mock.calls.length;
    const missing = await run(['apply', 'plan.json'], { env, cwd: tmp.dir });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/--confirm is required/);
    const wrong = await run(['apply', 'plan.json', '--confirm', '0000000000000000', '--json'], { env, cwd: tmp.dir });
    expect(wrong.code).toBe(1);
    expect(JSON.parse(wrong.stdout).error.code).toBe('CONFIRM_MISMATCH');
    // The error never hands out the right hash
    expect(`${wrong.stdout}${wrong.stderr}${missing.stdout}${missing.stderr}`).not.toContain(changeSetHash(parseChangeSet(readFileSync(join(tmp.dir, 'plan.json'), 'utf8'))));
    expect(appleApiRequest.mock.calls.length).toBe(calls);
    expect(existsSync(join(tmp.dir, 'plan.run.json'))).toBe(false);
  });

  it('applies, saves the run log, and a second apply changes nothing', async () => {
    const { hash } = await planFile();
    const r = await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Run run-\S+: completed \(2 ok\)/);
    const log = parseRun(readFileSync(join(tmp.dir, 'plan.run.json'), 'utf8'));
    expect(log.status).toBe('completed');
    expect(store.writes()).toEqual(['POST /subscriptionPromotionalOffers', 'POST /subscriptionPromotionalOffers']);

    // The log is never overwritten by a new run
    const clobber = await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir });
    expect(clobber.code).toBe(1);
    expect(clobber.stderr).toMatch(/already exists/);

    // --run-out doesn't replace an existing file either, unless --force
    writeFileSync(join(tmp.dir, 'keep.json'), 'precious');
    const keep = await run(['apply', 'plan.json', '--confirm', hash, '--run-out', 'keep.json'], { env, cwd: tmp.dir });
    expect(keep.code).toBe(1);
    expect(readFileSync(join(tmp.dir, 'keep.json'), 'utf8')).toBe('precious');
    const forced = await run(['apply', 'plan.json', '--confirm', hash, '--run-out', 'keep.json', '--force'], { env, cwd: tmp.dir });
    expect(forced.code).toBe(0);
    expect(parseRun(readFileSync(join(tmp.dir, 'keep.json'), 'utf8')).status).toBe('completed');
    expect(readdirSync(tmp.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const again = await run(['apply', 'plan.json', '--confirm', hash, '--run-out', 'again.json', '--json'], { env, cwd: tmp.dir });
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout).ops.map((o: { status: string }) => o.status)).toEqual(['skipped', 'skipped']);
    expect(store.writes()).toHaveLength(2);
  });

  it('resumes from the saved log after a create that took effect but errored', async () => {
    const { hash } = await planFile();
    store.failures.push({ method: 'POST', path: /^\/subscriptionPromotionalOffers$/, status: 504, afterWrite: true });
    const first = await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir });
    expect(first.code).toBe(1);
    expect(first.stdout).toContain(`--resume plan.run.json`);
    expect(parseRun(readFileSync(join(tmp.dir, 'plan.run.json'), 'utf8')).ops[0]).toMatchObject({ status: 'failed', attempts: 1 });

    const resumed = await run(['apply', 'plan.json', '--confirm', hash, '--resume', 'plan.run.json'], { env, cwd: tmp.dir });
    expect(resumed.code).toBe(0);
    expect(store.writes().filter((w) => w.startsWith('POST'))).toHaveLength(2);
    expect(parseRun(readFileSync(join(tmp.dir, 'plan.run.json'), 'utf8')).ops[0]).toMatchObject({ status: 'ok', response: { confirmedOnResume: true } });
  });

  it('refuses a base-price plan without --allow-base-prices, before any store request', async () => {
    writeFileSync(
      join(tmp.dir, 'base.json'),
      JSON.stringify({ schemaVersion: 1, kind: 'pricingkit.changeset', id: 'b', createdAt: 'x', app: { bundleId: BUNDLE }, ops: [] })
    );
    const empty = parseChangeSet(readFileSync(join(tmp.dir, 'base.json'), 'utf8'));
    const r = await run(['apply', 'base.json', '--confirm', changeSetHash(empty)], { env, cwd: tmp.dir });
    // An empty plan is fine; a base-price op is not
    expect(r.code).toBe(0);
    const withOp = {
      ...empty,
      ops: [
        {
          id: 'op-0001',
          kind: 'setPrice',
          platform: 'apple',
          target: { product: { platform: 'apple', type: 'subscription', id: A }, territory: 'US' },
          before: { currency: 'USD', amount: '49.99', pricePointId: 'a' },
          after: { currency: 'USD', amount: '25.99', pricePointId: 'b' },
          idempotencyKey: 'setPrice|apple:subscription:9300000001|US|USD 25.99 b ',
        },
      ],
    };
    writeFileSync(join(tmp.dir, 'base2.json'), JSON.stringify(withOp));
    const callsBefore = appleApiRequest.mock.calls.length;
    const r2 = await run(['apply', 'base2.json', '--confirm', changeSetHash(parseChangeSet(withOp))], { env, cwd: tmp.dir });
    expect(r2.code).toBe(1);
    expect(r2.stderr).toMatch(/changes base prices \(1 op, e\.g\. op-0001 setPrice\)\. Pass --allow-base-prices/);
    expect(r2.stderr).toMatch(/not yet confirmed on a test app/);
    expect(store.writes()).toEqual([]);
    expect(appleApiRequest.mock.calls.length).toBe(callsBefore);
  });
});

describe('default run log and undo plan paths', () => {
  it('are next to the plan file, not in the working directory', async () => {
    const { hash } = await planFile();
    mkdirSync(join(tmp.dir, 'plans'));
    writeFileSync(join(tmp.dir, 'plans', 'offers.json'), readFileSync(join(tmp.dir, 'plan.json'), 'utf8'));
    mkdirSync(join(tmp.dir, 'elsewhere'));
    const cwd = join(tmp.dir, 'elsewhere');

    const r = await run(['apply', '../plans/offers.json', '--confirm', hash], { env, cwd });
    expect(r.code).toBe(0);
    expect(existsSync(join(tmp.dir, 'plans', 'offers.run.json'))).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
    expect(r.stdout).toContain(join(tmp.dir, 'plans', 'offers.run.json'));

    const u = await run(['undo', '../plans/offers.json', '../plans/offers.run.json'], { env: {}, cwd });
    expect(u.code).toBe(2);
    expect(existsSync(join(tmp.dir, 'plans', 'offers.undo.json'))).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);

    // A second apply finds the log next to the plan and refuses to replace it
    const again = await run(['apply', '../plans/offers.json', '--confirm', hash], { env, cwd });
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/offers\.run\.json already exists/);
  });
});

describe('pricingkit undo', () => {
  it('writes the undo plan offline, prints its hash and what needs --force-delete, and the undo applies', async () => {
    const { hash } = await planFile();
    expect((await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir })).code).toBe(0);
    const calls = appleApiRequest.mock.calls.length;

    const r = await run(['undo', 'plan.json', 'plan.run.json'], { env: {}, cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(appleApiRequest.mock.calls.length).toBe(calls); // offline, no credentials needed
    const undo = parseChangeSet(readFileSync(join(tmp.dir, 'plan.undo.json'), 'utf8'));
    expect(undo.ops.map((op) => op.kind)).toEqual(['deleteOffer', 'deleteOffer']);
    const undoHash = changeSetHash(undo);
    expect(r.stdout).toContain(`Plan hash: ${undoHash}`);
    expect(r.stdout).toMatch(/Not reversible:[\s\S]*redemptions/);
    expect(r.stdout).toContain('--force-delete');

    // Not replaced without --force
    expect((await run(['undo', 'plan.json', 'plan.run.json'], { env: {}, cwd: tmp.dir })).code).toBe(1);

    const blocked = await run(['apply', 'plan.undo.json', '--confirm', undoHash], { env, cwd: tmp.dir });
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toMatch(/REDEMPTIONS_UNCHECKED|force/);
    const applied = await run(['apply', 'plan.undo.json', '--confirm', undoHash, '--force-delete', '--run-out', 'undo.run.json'], { env, cwd: tmp.dir });
    expect(applied.code).toBe(0);
    expect(store.offers).toEqual([]);
  });

  it('refuses a run log of another plan', async () => {
    const { hash } = await planFile();
    await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir });
    writeFileSync(join(tmp.dir, 'other.json'), JSON.stringify({ schemaVersion: 1, kind: 'pricingkit.changeset', id: 'o', createdAt: 'x', app: { bundleId: BUNDLE }, ops: [] }));
    const r = await run(['undo', 'other.json', 'plan.run.json'], { env: {}, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/different plan/);
  });
});

describe('pricingkit apply at a terminal', () => {
  it('shows what the plan does and applies only when the app ID is typed back', async () => {
    const { hash } = await planFile();
    const calls = appleApiRequest.mock.calls.length;
    const cancelled = await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir, typed: 'yes' });
    expect(cancelled.code).toBe(1);
    expect(cancelled.stderr).toMatch(/Plan offers-\S+ for com\.example\.app \(App Store\): 2 ops \(createOffer 2\)/);
    expect(cancelled.stderr).toMatch(/Type the app's bundle ID \(com\.example\.app\) to apply, anything else cancels:/);
    expect(cancelled.stderr).toMatch(/Not applied: the confirmation typed did not match\. Nothing was read or sent\./);
    expect(appleApiRequest.mock.calls.length).toBe(calls);
    expect(existsSync(join(tmp.dir, 'plan.run.json'))).toBe(false);
    // End of input cancels too
    expect((await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir, typed: null })).code).toBe(1);

    const applied = await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir, typed: ' com.example.app ' });
    expect(applied.code).toBe(0);
    expect(store.writes()).toHaveLength(2);
  });

  it('--yes skips the question; without a terminal (CI) nothing is asked', async () => {
    const { hash } = await planFile();
    const yes = await run(['apply', 'plan.json', '--confirm', hash, '--yes'], { env, cwd: tmp.dir, typed: 'nope' });
    expect(yes.code).toBe(0);
    expect(yes.stderr).not.toMatch(/Type the app/);
    const { hash: again } = await planFile();
    const ci = await run(['apply', 'plan.json', '--confirm', again, '--force'], { env, cwd: tmp.dir });
    expect(ci.code).toBe(0);
    expect(ci.stderr).not.toMatch(/Type the app/);
  });
});

describe('run logs', () => {
  it('are scrubbed like printed output, and stay valid JSON', async () => {
    const { hash } = await planFile();
    const keyLine = env.ASC_PRIVATE_KEY.split('\n')[1];
    appleApiRequest.mockImplementation(async (...args: unknown[]) => {
      const options = args[2] as { method?: string } | undefined;
      if (options?.method === 'POST') throw Object.assign(new Error(`upstream echoed ${env.ASC_KEY_ID} and -----BEGIN PRIVATE KEY-----\n${keyLine}`), { status: 400 });
      return store.handle(...(args as Parameters<typeof store.handle>));
    });
    const r = await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir });
    expect(r.code).toBe(1);
    const text = readFileSync(join(tmp.dir, 'plan.run.json'), 'utf8');
    expect(text).not.toContain(env.ASC_KEY_ID);
    expect(text).not.toContain(keyLine);
    const log = parseRun(text);
    expect(log.ops.some((o) => o.error?.message.includes('[redacted]'))).toBe(true);
  });
});
