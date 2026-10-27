// The CLI commands end to end, in-process, against the adapter fakes: the
// App Store client (appleApiRequest) and the Google Play client
// (googlePlayFetch) are mocked, so nothing leaves the process.
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

import { FakeAppleServer, SUB_ID } from '@/lib/adapters/__tests__/fake-apple';
import { OFFER_SUB_ID, type FakeOfferServer } from '@/lib/adapters/__tests__/fake-apple-offers';
import { parseChangeSet, parseStateSnapshot, PRICING_SPEC_KIND } from '@/lib/pricing';
import { APPLE_ENV_FAKE, FakePlay, offerServer, run, tempDir, throwawayRsaPem } from './fixtures';

const BUNDLE = 'com.example.app';
const PKG = 'com.example.app';

let apple: FakeAppleServer;
let offers: FakeOfferServer;
let play: FakePlay;
let googleEnv: Record<string, string>;
let tmp: ReturnType<typeof tempDir>;

beforeEach(async () => {
  apple = new FakeAppleServer();
  apple.seed('US', '24.99');
  apple.seed('GB', '24.99');
  apple.seed('DE', '27.99');
  offers = offerServer();
  play = new FakePlay();
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation((credentials: unknown, endpoint: string, options?: Record<string, unknown>) =>
    endpoint.includes(OFFER_SUB_ID) || endpoint.startsWith('/subscriptionPromotionalOffers') ? offers.handle(credentials, endpoint, options) : apple.handle(credentials, endpoint, options)
  );
  googlePlayFetch.mockReset();
  googlePlayFetch.mockImplementation(play.handle);
  googleEnv = {
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account',
      client_email: 'robot@example-project.iam.gserviceaccount.com',
      private_key_id: 'abcdef0123456789',
      private_key: await throwawayRsaPem(),
    }),
  };
  tmp = tempDir();
});

afterEach(() => {
  tmp.cleanup();
});

function writeSpec(spec: unknown, name = 'spec.json'): string {
  const path = join(tmp.dir, name);
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

const appleSpec = (targets: unknown, extra: Record<string, unknown> = {}) => ({
  kind: PRICING_SPEC_KIND,
  schemaVersion: 1,
  app: { bundleId: BUNDLE },
  products: [{ product: { platform: 'apple', type: 'subscription', id: SUB_ID }, targets, ...extra }],
});

describe('export', () => {
  it('prints an App Store subscription as a state snapshot with --json', async () => {
    const r = await run(['export', '--bundle-id', BUNDLE, '--subscription', SUB_ID, '--json'], { env: APPLE_ENV_FAKE });
    expect(r.code).toBe(0);
    const snapshot = parseStateSnapshot(r.stdout);
    expect(snapshot.kind).toBe('pricingkit.state');
    expect(snapshot.app).toEqual({ bundleId: BUNDLE });
    expect(snapshot.capturedAt).toBe('2030-01-01T00:00:00.000Z');
    expect(snapshot.products[0].territories.GB.current).toMatchObject({ currency: 'GBP', amount: '24.99' });
    expect(apple.writes()).toEqual([]);
  });

  it('prints a table without --json and writes the snapshot with --out', async () => {
    const r = await run(['export', '--bundle-id', BUNDLE, '--subscription', SUB_ID, '--out', 'state.json'], { env: APPLE_ENV_FAKE, cwd: tmp.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/DE\s+27\.99 EUR/);
    expect(() => JSON.parse(r.stdout)).toThrow();
    const written = parseStateSnapshot(readFileSync(join(tmp.dir, 'state.json'), 'utf8'));
    expect(Object.keys(written.products[0].territories).sort()).toEqual(['DE', 'GB', 'US']);
  });

  it('reads a Google Play base plan', async () => {
    const r = await run(['export', '--package-name', PKG, '--subscription', 'pro', '--base-plan', 'annual', '--json'], { env: googleEnv });
    expect(r.code).toBe(0);
    const snapshot = parseStateSnapshot(r.stdout);
    expect(snapshot.app).toEqual({ packageName: PKG });
    expect(snapshot.products[0].product).toEqual({ platform: 'google', type: 'subscription', productId: 'pro', basePlanId: 'annual' });
    expect(snapshot.products[0].territories.US.current).toEqual({ currency: 'USD', amount: '29.99' });
  });

  it('needs --base-plan on Google Play and a numeric subscription ID on the App Store', async () => {
    expect((await run(['export', '--package-name', PKG, '--subscription', 'pro'], { env: googleEnv })).code).toBe(1);
    const r = await run(['export', '--bundle-id', BUNDLE, '--subscription', 'com.example.app.pro'], { env: APPLE_ENV_FAKE });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/numeric App Store Connect subscription ID/);
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('charges every request to the run budget and stops when it is spent', async () => {
    const r = await run(['export', '--bundle-id', BUNDLE, '--subscription', SUB_ID, '--budget', '1'], { env: APPLE_ENV_FAKE });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('1 of 1 store requests used');

    const offersRun = await run(['offers', '--bundle-id', BUNDLE, '--subscription', OFFER_SUB_ID, '--budget', '2', '--json'], { env: APPLE_ENV_FAKE });
    expect(offersRun.code).toBe(1);
    expect(JSON.parse(offersRun.stdout).error).toMatchObject({ code: 'BUDGET_EXCEEDED', status: 429 });
  });

  it('keeps store client logging off stdout, so --json stays parseable', async () => {
    appleApiRequest.mockImplementationOnce(async (...args: unknown[]) => {
      console.log('[Apple API] 503 on GET ... Retry 1/3');
      return apple.handle(...(args as Parameters<FakeAppleServer['handle']>));
    });
    const r = await run(['export', '--bundle-id', BUNDLE, '--subscription', SUB_ID, '--json'], { env: APPLE_ENV_FAKE });
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stderr).toContain('Retry 1/3');
  });
});

describe('plan', () => {
  it('writes and prints a ChangeSet, exits 2 when there are ops, and sends only reads', async () => {
    const spec = writeSpec(appleSpec({ type: 'fixed', prices: { US: '29.99', GB: '26.50', DE: '27.99' } }));
    const r = await run(['plan', '--spec', spec, '--out', 'plan.json', '--json'], { env: APPLE_ENV_FAKE, cwd: tmp.dir });
    expect(r.code).toBe(2);
    const printed = parseChangeSet(r.stdout);
    const written = parseChangeSet(readFileSync(join(tmp.dir, 'plan.json'), 'utf8'));
    expect(written).toEqual(printed);
    expect(printed.app).toEqual({ bundleId: BUNDLE });
    expect(printed.ops.map((op) => [op.target.territory, op.kind, op.before?.amount, op.after?.amount])).toEqual([
      ['GB', 'setPrice', '24.99', '26.99'],
      ['US', 'setPrice', '24.99', '29.99'],
    ]);
    expect(printed.ops[0].after?.pricePointId).toBe(apple.point('GB', '26.99'));
    expect(printed.skipped).toEqual([expect.objectContaining({ territory: 'DE', reason: 'ALREADY_AT_TARGET' })]);
    // Dry run: GETs only, and adapter writes never reached
    expect(apple.calls.length).toBeGreaterThan(0);
    expect(apple.writes()).toEqual([]);
  });

  it('exits 0 with an empty plan when everything is at target', async () => {
    const spec = writeSpec(appleSpec({ type: 'fixed', prices: { US: '24.99', DE: '27.99' } }));
    const r = await run(['plan', '--spec', spec, '--out', 'plan.json'], { env: APPLE_ENV_FAKE, cwd: tmp.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No changes');
    expect(r.stdout).toContain('Dry run');
    expect(parseChangeSet(readFileSync(join(tmp.dir, 'plan.json'), 'utf8')).ops).toEqual([]);
  });

  it('plans percent-of-current targets snapped to each territory, scheduled when the spec says so', async () => {
    const spec = writeSpec(appleSpec({ type: 'percentOfCurrent', percent: '120', territories: ['US', 'GB'] }, { startDate: '2030-06-01', snap: 'floor' }));
    const r = await run(['plan', '--spec', spec, '--json', '--state-out', 'state.json'], { env: APPLE_ENV_FAKE, cwd: tmp.dir });
    expect(r.code).toBe(2);
    const plan = parseChangeSet(r.stdout);
    // 24.99 x 1.2 = 29.988. Floor: GB's ladder gives 26.99; US's next point is 29.99 (above), so 24.99,
    // which is still an op: it schedules a future price
    expect(plan.ops.map((op) => [op.target.territory, op.kind, op.after?.amount, op.after?.startDate])).toEqual([
      ['GB', 'schedulePrice', '26.99', '2030-06-01'],
      ['US', 'schedulePrice', '24.99', '2030-06-01'],
    ]);
    // The file holds exactly what was printed
    expect(readFileSync(join(tmp.dir, 'pricingkit-plan.json'), 'utf8')).toBe(r.stdout);
    expect(parseStateSnapshot(readFileSync(join(tmp.dir, 'state.json'), 'utf8')).products).toHaveLength(1);
    expect(apple.writes()).toEqual([]);
  });

  it('plans Google Play base plan prices with only reads (price conversion is a read-only call)', async () => {
    const spec = writeSpec({
      kind: PRICING_SPEC_KIND,
      schemaVersion: 1,
      app: { packageName: PKG },
      products: [{ product: { platform: 'google', type: 'subscription', productId: 'pro', basePlanId: 'annual' }, targets: { type: 'fixed', prices: { GB: '27.99', US: '29.99' } } }],
    });
    const r = await run(['plan', '--spec', spec, '--json'], { env: googleEnv, cwd: tmp.dir });
    expect(r.code).toBe(2);
    const plan = parseChangeSet(r.stdout);
    expect(plan.ops.map((op) => [op.target.territory, op.before?.amount, op.after?.amount])).toEqual([['GB', '24.99', '27.99']]);
    expect(play.calls.length).toBeGreaterThan(0);
    expect(play.writes()).toEqual([]);
  });

  it('refuses an invalid spec, naming the problem', async () => {
    const spec = writeSpec(appleSpec({ type: 'fixed', prices: { GBR: 4.99 } }));
    const r = await run(['plan', '--spec', spec, '--json'], { env: APPLE_ENV_FAKE, cwd: tmp.dir });
    expect(r.code).toBe(1);
    const error = JSON.parse(r.stdout).error;
    expect(error.code).toBe('INVALID_SPEC');
    expect(error.message).toMatch(/products\.0\.targets\.prices\.GBR/);
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('refuses a command-line app that differs from the spec', async () => {
    const spec = writeSpec(appleSpec({ type: 'fixed', prices: { US: '29.99' } }));
    const r = await run(['plan', '--spec', spec, '--bundle-id', 'com.example.other'], { env: APPLE_ENV_FAKE, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not the app in the spec/);
  });
});

describe('diff', () => {
  async function makePlan(prices: Record<string, string>): Promise<string> {
    const spec = writeSpec(appleSpec({ type: 'fixed', prices }));
    await run(['plan', '--spec', spec, '--out', 'plan.json'], { env: APPLE_ENV_FAKE, cwd: tmp.dir });
    return join(tmp.dir, 'plan.json');
  }

  it('summarises a plan for people, with no store requests and no credentials', async () => {
    const plan = await makePlan({ US: '29.99', GB: '26.50', DE: '27.99' });
    appleApiRequest.mockClear();
    const r = await run(['diff', plan], { cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('2 changes (setPrice 2)');
    expect(r.stdout).toMatch(/US\s+setPrice\s+24\.99 USD\s+29\.99 USD\s+\+20\.01%/);
    expect(r.stdout).toContain('Skipped 1 territories (ALREADY_AT_TARGET 1)');
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('prints a planSummary with --json and exits 0 for an empty plan', async () => {
    const plan = await makePlan({ US: '24.99' });
    const r = await run(['diff', '--plan', plan, '--json']);
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary).toMatchObject({ kind: 'pricingkit.planSummary', schemaVersion: 1, opCount: 0, byKind: {}, products: [] });
    expect(summary.changeSetHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('groups ops per product in the JSON summary', async () => {
    const plan = await makePlan({ US: '29.99', GB: '26.50' });
    const summary = JSON.parse((await run(['diff', plan, '--json'])).stdout);
    expect(summary.opCount).toBe(2);
    expect(summary.products).toHaveLength(1);
    expect(summary.products[0].key).toBe(`apple:subscription:${SUB_ID}`);
    expect(summary.products[0].ops[0]).toMatchObject({ id: 'op-0001', kind: 'setPrice', territory: 'GB', change: '+8%' });
  });

  it('refuses a tampered plan', async () => {
    const plan = await makePlan({ US: '29.99' });
    const parsed = JSON.parse(readFileSync(plan, 'utf8'));
    parsed.ops[0].after.amount = '1.00';
    writeFileSync(plan, JSON.stringify(parsed));
    const r = await run(['diff', plan, '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'INVALID_PLAN' });
  });

  it('needs a plan file that exists', async () => {
    expect((await run(['diff'])).code).toBe(1);
    const r = await run(['diff', 'missing.json'], { cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Can't read plan file missing\.json \(ENOENT\)/);
  });
});

describe('offers', () => {
  it('lists the offers with prices per territory', async () => {
    const r = await run(['offers', '--bundle-id', BUNDLE, '--subscription', OFFER_SUB_ID], { env: APPLE_ENV_FAKE });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('apple.promo  example_half "Half price year"  PAY_UP_FRONT P1Y x1  (id promo-1)');
    expect(r.stdout).toMatch(/GB\s+13\.99 GBP/);
    expect(offers.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('prints a pricingkit.offers document with --json and filters by --kind', async () => {
    const r = await run(['offers', '--bundle-id', BUNDLE, '--subscription', OFFER_SUB_ID, '--json', '--kind', 'apple.promo'], { env: APPLE_ENV_FAKE });
    expect(r.code).toBe(0);
    const list = JSON.parse(r.stdout);
    expect(list).toMatchObject({ kind: 'pricingkit.offers', schemaVersion: 1, app: { bundleId: BUNDLE }, product: { platform: 'apple', type: 'subscription', id: OFFER_SUB_ID } });
    expect(list.offers.map((o: { key: string }) => o.key)).toEqual(['example_half']);
    expect(list.offers[0].prices.US).toMatchObject({ currency: 'USD', amount: '29.99' });

    const none = JSON.parse((await run(['offers', '--bundle-id', BUNDLE, '--subscription', OFFER_SUB_ID, '--json', '--kind', 'apple.winBack'], { env: APPLE_ENV_FAKE })).stdout);
    expect(none.offers).toEqual([]);
  });

  it('is App Store only and checks --kind', async () => {
    expect((await run(['offers', '--package-name', PKG, '--subscription', 'pro'], { env: googleEnv })).stderr).toMatch(/App Store only/);
    expect((await run(['offers', '--bundle-id', BUNDLE, '--subscription', OFFER_SUB_ID, '--kind', 'promo'], { env: APPLE_ENV_FAKE })).code).toBe(1);
  });
});

describe('drift', () => {
  const args = ['drift', '--bundle-id', BUNDLE, '--subscription', OFFER_SUB_ID, '--kind', 'apple.promo', '--offer', 'example_half', '--percent', '50', '--basis', 'perPeriod'];

  it('exits 0 and prints an in-sync offerDrift report when every territory matches', async () => {
    const r = await run([...args, '--json'], { env: APPLE_ENV_FAKE });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ kind: 'pricingkit.offerDrift', schemaVersion: 1, inSync: true, billingPeriod: 'P1Y', summary: { match: 2, mismatch: 0 } });
    expect(report.rule).toEqual({ type: 'percentOfCurrent', percent: '50', basis: 'perPeriod', snap: 'nearest' });
    expect(offers.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('exits 2 when the offer has drifted, and says where', async () => {
    offers = offerServer({ gbPoint: 'pp-gbr-1299' });
    const json = await run([...args, '--json'], { env: APPLE_ENV_FAKE });
    expect(json.code).toBe(2);
    const report = JSON.parse(json.stdout);
    expect(report.inSync).toBe(false);
    expect(report.territories.find((t: { territory: string }) => t.territory === 'GB')).toMatchObject({ status: 'mismatch' });

    const text = await run(args, { env: APPLE_ENV_FAKE });
    expect(text.code).toBe(2);
    expect(text.stdout).toContain('DRIFT');
    expect(text.stdout).toMatch(/GB\s+mismatch\s+12\.99 GBP\s+13\.99 GBP/);
  });

  it('defaults the basis from the offer, and limits territories', async () => {
    // A 1-year pay-up-front offer on an annual subscription: totalOverDuration = 1 x 50%, same prices
    const r = await run(['drift', '--bundle-id', BUNDLE, '--subscription', OFFER_SUB_ID, '--kind', 'apple.promo', '--offer', 'example_half', '--percent', '50', '--territories', 'us', '--json'], {
      env: APPLE_ENV_FAKE,
    });
    const report = JSON.parse(r.stdout);
    expect(report.rule.basis).toBe('totalOverDuration');
    expect(report.territories.map((t: { territory: string; status: string }) => `${t.territory}:${t.status}`)).toEqual(['GB:extra', 'US:match']);
    expect(r.code).toBe(2);
  });

  it('exits 1 for an unknown offer, a bad rule or a missing flag', async () => {
    const missing = await run([...args.slice(0, 8), 'nope', ...args.slice(9), '--json'], { env: APPLE_ENV_FAKE });
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).error).toMatchObject({ code: 'NOT_FOUND' });

    const badPercent = await run([...args.slice(0, 10), '150'], { env: APPLE_ENV_FAKE });
    expect(badPercent.code).toBe(1);
    expect(badPercent.stderr).toMatch(/percent must be above 0 and below 100/);

    appleApiRequest.mockClear();
    const noOffer = await run(['drift', '--bundle-id', BUNDLE, '--subscription', OFFER_SUB_ID, '--kind', 'apple.promo', '--percent', '50'], { env: APPLE_ENV_FAKE });
    expect(noOffer.code).toBe(1);
    expect(noOffer.stderr).toMatch(/--offer is required/);
    expect(appleApiRequest).not.toHaveBeenCalled();
  });
});
