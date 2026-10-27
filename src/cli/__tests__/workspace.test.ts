// Workspaces end to end: plan, diff, apply, undo and parity across an
// App Store app, a second App Store app and a Google Play app, against the
// in-memory stores. Both store clients are mocked and every request records
// the app its credentials were made for, so the tests can check each op ran
// with its own app's adapter only.
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
import { FakePlayOffers, PKG, PRODUCT } from '@/lib/adapters/__tests__/fake-play-offers';
import { basePriceOps, buildWorkspacePlan, changeSetHash, parseChangeSet, parseWorkspacePlan, serializeWorkspacePlan } from '@/lib/pricing';
import { fakeAppleEnv, run, tempDir, throwawayRsaPem } from './fixtures';

const MAIN = 'com.example.app';
const OTHER = 'com.example.other';
const A = '9700000001'; // MAIN's annual subscription
const C = '9700000003'; // OTHER's subscription

let store: FakeOfferStore;
let play: FakePlayOffers;
let env: Record<string, string>;
let tmp: ReturnType<typeof tempDir>;
/** Every store request with the app its credentials were for */
let requests: Array<{ app: string; method: string; endpoint: string }>;

const write = (name: string, value: unknown) => writeFileSync(join(tmp.dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const read = (name: string) => readFileSync(join(tmp.dir, name), 'utf8');
const storeWrites = () => requests.filter((r) => r.method !== 'GET' && !r.endpoint.endsWith(':convertRegionPrices'));

const parity = {
  id: 'annual',
  apple: { bundleId: MAIN, subscription: A },
  play: { packageName: PKG, subscription: PRODUCT, basePlan: 'annual' },
  target: { type: 'fixed', prices: { US: '54.99', GB: '49.99' } },
};
const workspace = (extra: object = {}) => ({
  kind: 'pricingkit.workspace',
  schemaVersion: 1,
  apps: [
    { id: 'ios', app: { bundleId: MAIN } },
    { id: 'android', app: { packageName: PKG } },
    { id: 'other', app: { bundleId: OTHER }, products: [{ product: { platform: 'apple', type: 'subscription', id: C }, targets: { type: 'fixed', prices: { US: '10.99' } } }] },
  ],
  parity: [parity],
  ...extra,
});

beforeEach(async () => {
  store = new FakeOfferStore()
    .addSubscription(A, 'ONE_YEAR', { USA: '49.99', GBR: '44.99' }, { USA: ['24.99', '44.99', '49.99', '54.99'], GBR: ['22.99', '44.99', '49.99'] })
    .addSubscription(C, 'ONE_MONTH', { USA: '9.99' }, { USA: ['9.99', '10.99'] }, 'group-2');
  store.apps.set(OTHER, { id: 'app-2', groups: ['group-2'] });
  play = new FakePlayOffers();
  requests = [];
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation((credentials: { bundleId: string }, endpoint: string, options: { method?: string } = {}) => {
    requests.push({ app: `apple:${credentials.bundleId}`, method: options.method ?? 'GET', endpoint });
    return store.handle(credentials, endpoint, options);
  });
  googlePlayFetch.mockReset();
  googlePlayFetch.mockImplementation((credentials: unknown, path: string, options: { method?: string } = {}) => {
    requests.push({ app: `google:${decodeURIComponent(path.split('/applications/')[1]?.split('/')[0] ?? '')}`, method: options.method ?? 'GET', endpoint: path });
    return play.handle(credentials, path, options as never);
  });
  env = { ...(await fakeAppleEnv()), GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: await throwawayRsaPem(), private_key_id: 'kid' }) };
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

async function planWorkspace(ws: object = workspace(), extra: string[] = []) {
  write('workspace.json', ws);
  return run(['plan', '--workspace', 'workspace.json', ...extra], { env, cwd: tmp.dir });
}

describe('plan --workspace', () => {
  it('writes one plan per app, each for its own app only, an index with one hash, and parity on the planned prices', async () => {
    const r = await planWorkspace();
    expect(r.stderr).not.toMatch(/error/);
    expect(r.code).toBe(2);
    const ios = parseChangeSet(read('pricingkit-plans/ios.json'));
    const android = parseChangeSet(read('pricingkit-plans/android.json'));
    const other = parseChangeSet(read('pricingkit-plans/other.json'));
    expect(ios.app).toEqual({ bundleId: MAIN });
    expect(android.app).toEqual({ packageName: PKG });
    expect(other.app).toEqual({ bundleId: OTHER });
    // One target, snapped by each store separately
    expect(basePriceOps(ios).map((op) => [op.target.territory, op.after!.amount])).toEqual([
      ['GB', '49.99'],
      ['US', '54.99'],
    ]);
    expect(basePriceOps(android).map((op) => [op.target.territory, op.after!.amount])).toEqual([['US', '54.99']]);
    expect(basePriceOps(other).map((op) => [op.target.territory, (op.target.product as { id: string }).id])).toEqual([['US', C]]);

    const index = parseWorkspacePlan(read('pricingkit-plans/workspace-plan.json'));
    expect(index.plans.map((p) => [p.appId, p.part, p.file, p.hash])).toEqual([
      ['ios', 'prices', 'ios.json', changeSetHash(ios)],
      ['android', 'prices', 'android.json', changeSetHash(android)],
      ['other', 'prices', 'other.json', changeSetHash(other)],
    ]);
    expect(index.parity).toMatchObject({ basis: 'plan', inParity: true });
    expect(r.stdout).toContain(`Workspace plan hash: ${index.hash}`);
    expect(r.stdout).toContain(`pricingkit apply --workspace-plan ${join('pricingkit-plans', 'workspace-plan.json')} --confirm <the workspace plan hash> --allow-base-prices`);
    expect(r.stdout).toMatch(/Parity \(prices once the plans are applied\): in parity/);
    expect(storeWrites()).toEqual([]);
    // Every request went out with the credentials of the app it was about
    expect(new Set(requests.filter((q) => q.endpoint.includes(C)).map((q) => q.app))).toEqual(new Set([`apple:${OTHER}`]));
    expect(new Set(requests.filter((q) => q.endpoint.includes(A)).map((q) => q.app))).toEqual(new Set([`apple:${MAIN}`]));
  });

  it("refuses a product that belongs to another app before reading its prices", async () => {
    const ws = workspace();
    ws.apps[2] = { id: 'other', app: { bundleId: OTHER }, products: [{ product: { platform: 'apple', type: 'subscription', id: A }, targets: { type: 'fixed', prices: { US: '54.99' } } }] };
    const r = await planWorkspace(ws, ['--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe('APP_MISMATCH');
    expect(existsSync(join(tmp.dir, 'pricingkit-plans', 'workspace-plan.json'))).toBe(false);
  });

  it('never replaces earlier plans without --force', async () => {
    expect((await planWorkspace()).code).toBe(2);
    const again = await planWorkspace();
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already has workspace-plan\.json, ios\.json, android\.json, other\.json/);
    expect((await planWorkspace(workspace(), ['--force'])).code).toBe(2);
  });

  it('checks the PRICINGKIT_EXPECT_* pins (lists) for every app before anything is read', async () => {
    write('workspace.json', workspace());
    const pinned = await run(['plan', '--workspace', 'workspace.json', '--json'], { env: { ...env, PRICINGKIT_EXPECT_BUNDLE_ID: MAIN }, cwd: tmp.dir });
    expect(pinned.code).toBe(1);
    expect(JSON.parse(pinned.stdout).error).toMatchObject({ code: 'APP_NOT_EXPECTED', message: expect.stringContaining(OTHER) });
    expect(requests).toEqual([]);
    const listed = await run(['plan', '--workspace', 'workspace.json'], { env: { ...env, PRICINGKIT_EXPECT_BUNDLE_ID: `${MAIN}, ${OTHER}`, PRICINGKIT_EXPECT_PACKAGE: PKG }, cwd: tmp.dir });
    expect(listed.code).toBe(2);
  });

  it('reads spec and rules files the workspace names, YAML included, and refuses paths outside it', async () => {
    write('ios.yaml', `kind: pricingkit.spec\nschemaVersion: 1\napp: { bundleId: ${MAIN} }\nproducts:\n  - product: { platform: apple, type: subscription, id: "${A}" }\n    targets: { type: fixed, prices: { US: 54.99 } }\n`);
    const ws = workspace({ parity: [] });
    ws.apps[0] = { id: 'ios', app: { bundleId: MAIN }, spec: 'ios.yaml' } as never;
    const r = await planWorkspace(ws);
    expect(r.code).toBe(2);
    expect(parseChangeSet(read('pricingkit-plans/ios.json')).ops).toHaveLength(1);

    ws.apps[0] = { id: 'ios', app: { bundleId: MAIN }, spec: '../ios.yaml' } as never;
    const outside = await planWorkspace(ws, ['--json', '--force']);
    expect(JSON.parse(outside.stdout).error.message).toMatch(/stay inside the workspace/);

    // A spec file for another app is refused
    write('wrong.json', { kind: 'pricingkit.spec', schemaVersion: 1, app: { bundleId: OTHER }, products: [{ product: { platform: 'apple', type: 'subscription', id: C }, targets: { type: 'fixed', prices: { US: '10.99' } } }] });
    ws.apps[0] = { id: 'ios', app: { bundleId: MAIN }, spec: 'wrong.json' } as never;
    const wrong = await planWorkspace(ws, ['--json', '--force']);
    expect(JSON.parse(wrong.stdout).error.message).toMatch(/is for com\.example\.other \(App Store\), not com\.example\.app/);
  });
});

describe('diff, apply and undo --workspace-plan', () => {
  async function planned() {
    expect((await planWorkspace()).code).toBe(2);
    return parseWorkspacePlan(read('pricingkit-plans/workspace-plan.json'));
  }

  it('diff shows every app and the workspace hash; diff of several plans says how many apps they change', async () => {
    const index = await planned();
    const r = await run(['diff', '--workspace-plan', 'pricingkit-plans/workspace-plan.json'], { env: {}, cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/It changes 3 apps, one plan file each \(plus offer plans\): ios com\.example\.app \(App Store\), android com\.example\.app \(Google Play\), other com\.example\.other \(App Store\)/);
    expect(r.stdout).toContain('== android: com.example.app (Google Play), prices (android.json)');
    expect(r.stdout).toContain(`Workspace plan hash: ${index.hash}`);
    const many = await run(['diff', 'pricingkit-plans/ios.json', 'pricingkit-plans/android.json'], { env: {}, cwd: tmp.dir });
    expect(many.stdout).toMatch(/^These 2 plans change 2 apps: com\.example\.app \(App Store\), com\.example\.app \(Google Play\)/);
  });

  it('applies each plan with its own app, logs each run, then refuses to replace the logs; --resume-runs skips completed plans', async () => {
    const index = await planned();
    const before = requests.length;
    const wrong = await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.json', '--confirm', 'f'.repeat(16), '--allow-base-prices', '--json'], { env, cwd: tmp.dir });
    expect(JSON.parse(wrong.stdout).error.code).toBe('CONFIRM_MISMATCH');
    expect(`${wrong.stdout}${wrong.stderr}`).not.toContain(index.hash);
    const noOptIn = await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.json', '--confirm', index.hash], { env, cwd: tmp.dir });
    expect(noOptIn.stderr).toMatch(/Pass --allow-base-prices/);
    expect(requests.length).toBe(before);

    const r = await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.json', '--confirm', index.hash, '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(r.code).toBe(0);
    expect(store.subs.get(A)!.base).toEqual({ USA: '54.99', GBR: '49.99' });
    expect(store.subs.get(C)!.base).toEqual({ USA: '10.99' });
    expect(storeWrites().map((w) => `${w.app} ${w.method}`)).toEqual([
      `apple:${MAIN} POST`,
      `apple:${MAIN} POST`,
      `google:${PKG} PATCH`,
      `apple:${OTHER} POST`,
    ]);
    for (const file of ['ios', 'android', 'other']) expect(JSON.parse(read(`pricingkit-plans/${file}.run.json`)).status).toBe('completed');

    const again = await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.json', '--confirm', index.hash, '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(again.stderr).toMatch(/Run logs already exist/);
    const resumed = await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.json', '--confirm', index.hash, '--allow-base-prices', '--resume-runs'], { env, cwd: tmp.dir });
    expect(resumed.code).toBe(0);
    expect(resumed.stdout.match(/Already completed/g)).toHaveLength(3);
    expect(storeWrites()).toHaveLength(4);

    // Undo: one undo plan per applied plan, newest first, applied the same way
    const undo = await run(['undo', '--workspace-plan', 'pricingkit-plans/workspace-plan.json'], { env: {}, cwd: tmp.dir });
    expect(undo.code).toBe(2);
    const undoIndex = parseWorkspacePlan(read('pricingkit-plans/workspace-plan.undo.json'));
    expect(undoIndex.plans.map((p) => p.file)).toEqual(['other.undo.json', 'android.undo.json', 'ios.undo.json']);
    const undone = await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.undo.json', '--confirm', undoIndex.hash, '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(undone.code).toBe(0);
    expect(store.subs.get(A)!.base).toEqual({ USA: '49.99', GBR: '44.99' });
    expect(store.subs.get(C)!.base).toEqual({ USA: '9.99' });
    expect(JSON.parse(JSON.stringify(play.subscription)).basePlans[0].regionalConfigs[0].price).toMatchObject({ currencyCode: 'USD', units: '59' });
  });

  it('never reports a changed plan as already completed: re-planning moves old logs aside, and a log of another plan is refused', async () => {
    const first = await planned();
    const applied = await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.json', '--confirm', first.hash, '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(applied.code).toBe(0);
    expect(store.subs.get(C)!.base).toEqual({ USA: '10.99' });

    // The reviewer's sequence: change a target, plan again
    const changed = workspace();
    changed.apps[2] = { id: 'other', app: { bundleId: OTHER }, products: [{ product: { platform: 'apple', type: 'subscription', id: C }, targets: { type: 'fixed', prices: { US: '9.99' } } }] };
    const refused = await planWorkspace(changed);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/ios\.run\.json, android\.run\.json, other\.run\.json/);
    const replanned = await planWorkspace(changed, ['--force']);
    expect(replanned.code).toBe(2);
    expect(replanned.stdout).toMatch(/Moved aside the run logs and undo plans of the earlier plans .*other\.run\.json -> other\.run\.json\.stale-20300101000000/);
    expect(existsSync(join(tmp.dir, 'pricingkit-plans', 'other.run.json'))).toBe(false);
    expect(existsSync(join(tmp.dir, 'pricingkit-plans', 'other.run.json.stale-20300101000000'))).toBe(true);
    const second = parseWorkspacePlan(read('pricingkit-plans/workspace-plan.json'));

    const resumed = await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.json', '--confirm', second.hash, '--allow-base-prices', '--resume-runs'], { env, cwd: tmp.dir });
    expect(resumed.stdout).not.toMatch(/Already completed/);
    expect(resumed.code).toBe(0);
    expect(store.subs.get(C)!.base).toEqual({ USA: '9.99' });

    // A stale log put back next to a new plan is refused before anything is read or sent
    const third = await planWorkspace(workspace(), ['--force']);
    expect(third.code).toBe(2);
    // The second run's log (a different plan for the same file) was moved aside under a free name
    expect(third.stdout).toContain('other.run.json -> other.run.json.stale-20300101000000-2');
    write('pricingkit-plans/other.run.json', read('pricingkit-plans/other.run.json.stale-20300101000000-2'));
    const index = parseWorkspacePlan(read('pricingkit-plans/workspace-plan.json'));
    const before = requests.length;
    const mixed = await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.json', '--confirm', index.hash, '--allow-base-prices', '--resume-runs', '--json'], { env, cwd: tmp.dir });
    expect(mixed.code).toBe(1);
    expect(JSON.parse(mixed.stdout).error).toMatchObject({ code: 'INVALID_RUN', message: expect.stringMatching(/other\.run\.json is the run log of a different plan than other\.json/) });
    expect(requests.length).toBe(before);
    expect(store.subs.get(C)!.base).toEqual({ USA: '9.99' });
  });

  it('undo writes its index next to the input, never over it', async () => {
    const index = await planned();
    expect((await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.json', '--confirm', index.hash, '--allow-base-prices'], { env, cwd: tmp.dir })).code).toBe(0);
    expect((await run(['undo', '--workspace-plan', 'pricingkit-plans/workspace-plan.json'], { env: {}, cwd: tmp.dir })).code).toBe(2);
    const undoIndex = parseWorkspacePlan(read('pricingkit-plans/workspace-plan.undo.json'));
    expect((await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.undo.json', '--confirm', undoIndex.hash, '--allow-base-prices'], { env, cwd: tmp.dir })).code).toBe(0);
    const inputBefore = read('pricingkit-plans/workspace-plan.undo.json');
    const redo = await run(['undo', '--workspace-plan', 'pricingkit-plans/workspace-plan.undo.json'], { env: {}, cwd: tmp.dir });
    expect(redo.code).toBe(2);
    expect(read('pricingkit-plans/workspace-plan.undo.json')).toBe(inputBefore);
    expect(parseWorkspacePlan(read('pricingkit-plans/workspace-plan.undo.undo.json')).plans.map((p) => p.file)).toEqual(['ios.undo.undo.json', 'android.undo.undo.json', 'other.undo.undo.json']);
  });

  it("stops at a plan file swapped for another app's plan, before any request", async () => {
    await planned();
    write('pricingkit-plans/other.json', read('pricingkit-plans/ios.json'));
    const index = parseWorkspacePlan(read('pricingkit-plans/workspace-plan.json'));
    const before = requests.length;
    const r = await run(['apply', '--workspace-plan', 'pricingkit-plans/workspace-plan.json', '--confirm', index.hash, '--allow-base-prices', '--json'], { env, cwd: tmp.dir });
    expect(JSON.parse(r.stdout).error.code).toBe('APP_MISMATCH');
    expect(requests.length).toBe(before);
  });

  it("never applies an op on app A's product through app B's adapter", async () => {
    // A plan for OTHER naming MAIN's subscription, made with the single-app planner (which doesn't check ownership)
    write('stray.json', { kind: 'pricingkit.spec', schemaVersion: 1, app: { bundleId: OTHER }, products: [{ product: { platform: 'apple', type: 'subscription', id: A }, targets: { type: 'fixed', prices: { US: '54.99' } } }] });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmp.dir, 'plans'));
    expect((await run(['plan', '--spec', 'stray.json', '--out', 'plans/stray.json'], { env, cwd: tmp.dir })).code).toBe(2);
    const plan = parseChangeSet(read('plans/stray.json'));
    const index = buildWorkspacePlan({
      createdAt: '2030-01-01T00:00:00Z',
      plans: [{ appId: 'other', app: { bundleId: OTHER }, part: 'prices', file: 'stray.json', hash: changeSetHash(plan), ops: 1, baseOps: 1, offerOps: 0, manualActions: 0 }],
    });
    write('plans/workspace-plan.json', serializeWorkspacePlan(index));
    const r = await run(['apply', '--workspace-plan', 'plans/workspace-plan.json', '--confirm', index.hash, '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/failed\s+op-0001 .* doesn't belong to com\.example\.other/);
    expect(JSON.parse(read('plans/stray.run.json')).ops[0].error.code).toBe('APP_MISMATCH');
    expect(storeWrites()).toEqual([]);
    expect(store.subs.get(A)!.base.USA).toBe('49.99');
  });
});

describe('parity --workspace', () => {
  it('parity is NOT CHECKED (exit 1) when nothing could be compared, and lists one-store territories', async () => {
    write('workspace.json', workspace({ parity: [{ ...parity, territories: ['JP'] }] }));
    const r = await run(['parity', '--workspace', 'workspace.json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^Parity \(current prices\): NOT CHECKED across 1 mapping; priced on one store only: 1 Google Play only/);
    expect(r.stdout).not.toMatch(/in parity/i);
  });

  it('parity reports the current gaps per territory, read-only', async () => {
    write('workspace.json', workspace());
    const r = await run(['parity', '--workspace', 'workspace.json', '--json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ kind: 'pricingkit.parity', basis: 'current', inParity: false });
    expect(report.mappings[0].rows.map((row: { territory: string; status: string; ratio?: string }) => [row.territory, row.status, row.ratio])).toEqual([
      ['GB', 'gap', '0.1111'],
      ['JP', 'playOnly', undefined],
      ['US', 'gap', '0.2'],
    ]);
    expect(storeWrites()).toEqual([]);
    const text = await run(['parity', '--workspace', 'workspace.json'], { env, cwd: tmp.dir });
    expect(text.stdout).toMatch(/annual: App Store com\.example\.app subscription 9700000001 vs Google Play com\.example\.app com\.example\.pro\/annual/);
    expect(text.stdout).toMatch(/GB\s+gap\s+44\.99 GBP\s+49\.99 GBP\s+5\s+11\.11%/);
    const unknown = await run(['parity', '--workspace', 'workspace.json', '--mapping', 'nope'], { env, cwd: tmp.dir });
    expect(unknown.stderr).toMatch(/no parity mapping "nope"/);
  });

});

describe('prices CSV in the CLI', () => {
  it('export then import plans no changes (App Store and Google Play, base prices and offers)', async () => {
    store.seedPromo(A, 'retention', {}, { USA: '24.99', GBR: '22.99' });
    const apple = await run(['export', '--bundle-id', MAIN, '--subscription', A, '--format', 'csv', '--offers', '--out', 'apple.csv'], { env, cwd: tmp.dir });
    expect(apple.code).toBe(0);
    expect(read('apple.csv').split('\r\n').slice(0, 3)).toEqual([
      '# pricingkit.prices v1',
      'app,platform,product_type,product,base_plan,offer_kind,offer_key,territory,currency,price,proceeds',
      `${MAIN},apple,subscription,${A},,,,GB,GBP,44.99,38.24`,
    ]);
    expect(read('apple.csv')).toContain(`${MAIN},apple,subscription,${A},,apple.promo,retention,US,USD,24.99,`);
    const google = await run(['export', '--package-name', PKG, '--subscription', PRODUCT, '--base-plan', 'annual', '--format', 'csv'], { env, cwd: tmp.dir });
    expect(google.code).toBe(0);
    write('play.csv', `${google.stdout.trimEnd()}\n`);

    write('apple-spec.json', { kind: 'pricingkit.spec', schemaVersion: 1, app: { bundleId: MAIN }, products: [{ product: { platform: 'apple', type: 'subscription', id: A }, targets: { type: 'fixed', pricesFile: 'apple.csv' } }] });
    const base = await run(['plan', '--spec', 'apple-spec.json', '--out', 'a.json'], { env, cwd: tmp.dir });
    expect(base.code).toBe(0);
    expect(base.stdout).toMatch(/CSV import: 2 rows, 2 exact, 0 snapped to another price, 0 not imported/);

    write('play-spec.json', { kind: 'pricingkit.spec', schemaVersion: 1, app: { packageName: PKG }, products: [{ product: { platform: 'google', type: 'subscription', productId: PRODUCT, basePlanId: 'annual' }, targets: { type: 'fixed', pricesFile: 'play.csv' } }] });
    const playPlan = await run(['plan', '--spec', 'play-spec.json', '--out', 'p.json'], { env, cwd: tmp.dir });
    expect(playPlan.code).toBe(0);
    expect(playPlan.stdout).toMatch(/CSV import: 3 rows, 3 exact/);

    write('offers-spec.json', {
      kind: 'pricingkit.offerPlanSpec',
      schemaVersion: 1,
      app: { bundleId: MAIN },
      offers: [{ id: 'retention', productRef: { platform: 'apple', type: 'subscription', id: A }, kind: 'apple.promo', mode: 'PAY_UP_FRONT', duration: 'P1Y', pricing: { type: 'fixed', pricesFile: 'apple.csv' }, territories: 'all', syncWithBase: false }],
    });
    const offers = await run(['plan', '--spec', 'offers-spec.json', '--out', 'o.json'], { env, cwd: tmp.dir });
    expect(offers.stdout).toMatch(/already matches its spec/);
    expect(offers.stdout).toMatch(/CSV import: 2 rows, 2 exact/);
    expect(offers.code).toBe(0);
    expect(storeWrites()).toEqual([]);
  });

  it('reports rows that do not snap exactly, as plan warnings too', async () => {
    const lines = ['# pricingkit.prices v1', 'app,platform,product,territory,currency,price', `${MAIN},apple,${A},US,USD,54.95`, `${MAIN},apple,${A},GB,GBP,49.99`, `${MAIN},apple,${A},DE,EUR,49.99`];
    write('prices.csv', lines.join('\n'));
    write('spec.json', { kind: 'pricingkit.spec', schemaVersion: 1, app: { bundleId: MAIN }, products: [{ product: { platform: 'apple', type: 'subscription', id: A }, targets: { type: 'fixed', pricesFile: 'prices.csv' } }] });
    const r = await run(['plan', '--spec', 'spec.json', '--out', 'plan.json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/CSV import: 3 rows, 1 exact, 1 snapped to another price, 1 not imported/);
    expect(r.stdout).toMatch(/line 3 \(US\): 54\.95 USD -> 54\.99 USD/);
    expect(r.stdout).toMatch(/line 5 \(DE\): not imported, UNRESOLVED_PRICE_POINT/);
    const plan = parseChangeSet(read('plan.json'));
    expect(plan.warnings?.map((w) => w.message)).toEqual(expect.arrayContaining([expect.stringMatching(/CSV prices\.csv line 3 \(US\): 54\.95 USD is not a valid store price; planned as 54\.99 USD/)]));
  });

  it('reads the CSV like multipliersFile: inside the working directory, a regular file, size-capped; errors give line and column only', async () => {
    const spec = (file: string) => write('spec.json', { kind: 'pricingkit.spec', schemaVersion: 1, app: { bundleId: MAIN }, products: [{ product: { platform: 'apple', type: 'subscription', id: A }, targets: { type: 'fixed', pricesFile: file } }] });
    const plan = async () => JSON.parse((await run(['plan', '--spec', 'spec.json', '--out', 'plan.json', '--json'], { env, cwd: tmp.dir })).stdout).error;

    spec('../prices.csv');
    expect((await plan()).message).toMatch(/pricesFile: a relative \.csv path/);
    const { symlinkSync, mkdirSync } = await import('node:fs');
    const outside = tempDir();
    try {
      writeFileSync(join(outside.dir, 'p.csv'), '# pricingkit.prices v1\n');
      symlinkSync(join(outside.dir, 'p.csv'), join(tmp.dir, 'linked.csv'));
      spec('linked.csv');
      expect((await plan()).message).toMatch(/linked\.csv is outside the working directory/);
    } finally {
      outside.cleanup();
    }
    mkdirSync(join(tmp.dir, 'dir.csv'));
    spec('dir.csv');
    expect((await plan()).message).toMatch(/dir\.csv is not a regular file/);
    writeFileSync(join(tmp.dir, 'big.csv'), Buffer.alloc(5_000_001, 0x20));
    spec('big.csv');
    expect((await plan()).message).toMatch(/big\.csv is larger than 5000000 bytes/);

    write('bad.csv', ['# pricingkit.prices v1', 'app,platform,product,territory,currency,price', `${MAIN},apple,${A},TOPSECRET,USD,54.99`, `${MAIN},apple,${A},GB,GBP,TOPSECRET`].join('\n'));
    spec('bad.csv');
    const error = await plan();
    expect(error.code).toBe('INVALID_CSV');
    expect(error.message).toContain('line 3, column "territory"');
    expect(error.message).toContain('line 4, column "price"');
    expect(error.message).not.toContain('TOPSECRET');
    expect(requests).toEqual([]);

    write('other.csv', ['# pricingkit.prices v1', 'app,platform,product,territory,currency,price', `${OTHER},apple,${C},US,USD,10.99`].join('\n'));
    spec('other.csv');
    expect((await plan()).message).toMatch(/other\.csv has no base price rows for apple:subscription:9700000001 of this app/);
  });

  it('refuses an offer row in the wrong currency before writing a plan', async () => {
    store.seedPromo(A, 'retention', {}, { USA: '24.99', GBR: '22.99' });
    write('offers.csv', ['# pricingkit.prices v1', 'app,platform,product,offer_kind,offer_key,territory,currency,price', `${MAIN},apple,${A},apple.promo,retention,GB,EUR,24.99`].join('\n'));
    write('offers-spec.json', {
      kind: 'pricingkit.offerPlanSpec',
      schemaVersion: 1,
      app: { bundleId: MAIN },
      offers: [{ id: 'retention', productRef: { platform: 'apple', type: 'subscription', id: A }, kind: 'apple.promo', mode: 'PAY_UP_FRONT', duration: 'P1Y', pricing: { type: 'fixed', pricesFile: 'offers.csv' }, territories: 'all', syncWithBase: false }],
    });
    // GB 24.99 isn't a GBP price point here; use a valid one so the op exists and carries GBP
    write('offers.csv', read('offers.csv').replace('24.99', '22.99').replace('GB,EUR', 'GB,EUR'));
    store.offers[0].prices = store.offers[0].prices.filter((p) => p.alpha3 !== 'GBR');
    const r = await run(['plan', '--spec', 'offers-spec.json', '--out', 'o.json', '--json'], { env, cwd: tmp.dir });
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'CSV_CURRENCY_MISMATCH', message: expect.stringContaining('line 3, column "currency"') });
    expect(existsSync(join(tmp.dir, 'o.json'))).toBe(false);
  });

  it('checks the currency of an offer row the plan leaves unchanged', async () => {
    store.seedPromo(A, 'retention', {}, { USA: '24.99', GBR: '22.99' });
    write('offers-spec.json', {
      kind: 'pricingkit.offerPlanSpec',
      schemaVersion: 1,
      app: { bundleId: MAIN },
      offers: [{ id: 'retention', productRef: { platform: 'apple', type: 'subscription', id: A }, kind: 'apple.promo', mode: 'PAY_UP_FRONT', duration: 'P1Y', pricing: { type: 'fixed', pricesFile: 'offers.csv' }, territories: 'all', syncWithBase: false }],
    });
    const rows = (gbCurrency: string) => ['# pricingkit.prices v1', 'app,platform,product,offer_kind,offer_key,territory,currency,price', `${MAIN},apple,${A},apple.promo,retention,GB,${gbCurrency},22.99`, `${MAIN},apple,${A},apple.promo,retention,US,USD,24.99`].join('\n');
    write('offers.csv', rows('EUR'));
    const r = await run(['plan', '--spec', 'offers-spec.json', '--out', 'o.json', '--json'], { env, cwd: tmp.dir });
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'CSV_CURRENCY_MISMATCH', message: expect.stringContaining('line 3, column "currency"') });
    write('offers.csv', rows('GBP'));
    const ok = await run(['plan', '--spec', 'offers-spec.json', '--out', 'o.json'], { env, cwd: tmp.dir });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/CSV import: 2 rows, 2 exact/);
  });

  it('exports every product of a workspace to one CSV, each through its own app', async () => {
    write('workspace.json', workspace());
    const r = await run(['export', '--workspace', 'workspace.json', '--format', 'csv', '--out', 'all.csv'], { env, cwd: tmp.dir });
    expect(r.code).toBe(0);
    const rows = read('all.csv').trim().split('\r\n').slice(2).map((l) => l.split(',').slice(0, 10).join(','));
    expect(rows).toEqual([
      `${MAIN},apple,subscription,${A},,,,GB,GBP,44.99`,
      `${MAIN},apple,subscription,${A},,,,US,USD,49.99`,
      `${OTHER},apple,subscription,${C},,,,US,USD,9.99`,
      `${PKG},google,basePlan,${PRODUCT},annual,,,GB,GBP,49.99`,
      `${PKG},google,basePlan,${PRODUCT},annual,,,JP,JPY,9800`,
      `${PKG},google,basePlan,${PRODUCT},annual,,,US,USD,59.99`,
    ]);
    expect(new Set(requests.filter((q) => q.endpoint.includes(C)).map((q) => q.app))).toEqual(new Set([`apple:${OTHER}`]));
  });
});
