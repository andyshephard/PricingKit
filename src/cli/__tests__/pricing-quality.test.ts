// Phase 8 in the CLI: existing-subscriber classes, proceeds and tax in plans
// and diff, the no-consent guard, proceeds targets, custom multipliers from
// CSV, and reference data freshness. Store clients are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});
const googlePlayFetch = vi.fn();
vi.mock('@/lib/google-play/client', () => ({ googlePlayFetch: (...args: unknown[]) => googlePlayFetch(...args) }));

import { FakeAppleServer, SUB_ID } from '@/lib/adapters/__tests__/fake-apple';
import { canonicalJson, fnv1a64, parseChangeSet, PRICING_SPEC_KIND, type BasePriceOp } from '@/lib/pricing';
import { fakeAppleEnv, FakePlay, run, tempDir, throwawayRsaPem } from './fixtures';

const BUNDLE = 'com.example.app';
let apple: FakeAppleServer;
let play: FakePlay;
let appleEnv: Record<string, string>;
let googleEnv: Record<string, string>;
let tmp: ReturnType<typeof tempDir>;

beforeEach(async () => {
  apple = new FakeAppleServer();
  apple.seed('US', '24.99');
  apple.seed('GB', '24.99');
  apple.seed('DE', '27.99');
  play = new FakePlay();
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation(apple.handle);
  googlePlayFetch.mockReset();
  googlePlayFetch.mockImplementation(play.handle);
  appleEnv = await fakeAppleEnv();
  googleEnv = {
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: 'robot@example-project.iam.gserviceaccount.com', private_key_id: 'abcdef0123456789', private_key: await throwawayRsaPem() }),
  };
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

const product = { platform: 'apple', type: 'subscription', id: SUB_ID };
const writeSpec = (products: unknown[], extra: object = {}, app: object = { bundleId: BUNDLE }) => {
  writeFileSync(join(tmp.dir, 'spec.json'), JSON.stringify({ kind: PRICING_SPEC_KIND, schemaVersion: 1, app, products, ...extra }));
  return 'spec.json';
};
const plan = (env = appleEnv, extra: string[] = []) => run(['plan', '--spec', 'spec.json', '--out', 'plan.json', ...extra], { env, cwd: tmp.dir });
const readPlan = () => parseChangeSet(readFileSync(join(tmp.dir, 'plan.json'), 'utf8'));

describe('existing subscribers in plans and diff', () => {
  // US +40% (+10 USD, within: not over 50%), GB a decrease, DE always needs consent
  const prices = { type: 'fixed', prices: { US: '34.99', GB: '19.99', DE: '29.99' } };

  it('classifies every territory, with proceeds, and diff shows the columns', async () => {
    writeSpec([{ product, targets: prices, preserveCurrentPrice: false, consent: { billingPeriod: 'P1Y' } }]);
    const r = await plan();
    expect(r.code).toBe(2);
    const changeSet = readPlan();
    const byTerritory = Object.fromEntries((changeSet.priceChanges ?? []).map((n) => [n.territory, n]));
    expect(byTerritory.US).toMatchObject({ classification: 'increase-within-no-consent-threshold', percent: '40.02', proceeds: { before: '17.49', after: '24.49' } });
    expect(byTerritory.GB).toMatchObject({ classification: 'decrease' });
    expect(byTerritory.DE).toMatchObject({ classification: 'increase-needs-consent', reasons: [expect.stringMatching(/DE requires consent for any price increase/)] });

    const diff = await run(['diff', 'plan.json'], { cwd: tmp.dir });
    expect(diff.stdout).toMatch(/Proceeds\*\s+Existing subscribers\*/);
    expect(diff.stdout).toContain('* planner notes, not covered by the plan hash.');
    expect(diff.stdout).toContain('Planner notes (not covered by the plan hash):');
    expect(diff.stdout).not.toContain('WARNING');
    expect(diff.stdout).toMatch(/US\s+setPrice\s+24\.99 USD\s+34\.99 USD\s+\+40\.02%\s+17\.49 -> 24\.49\s+notified, no consent/);
    expect(diff.stdout).toMatch(/DE\s+setPrice.*NEEDS CONSENT/);
    expect(diff.stdout).toContain('Existing subscribers: ');
    expect(diff.stdout).toContain("Needs consent (subscribers who don't agree are lost at renewal): DE");
    expect(diff.stdout).toMatch(/Assumed \(not checked\):\n\s+- no price increase in the last 12 months/);
    const json = JSON.parse((await run(['diff', 'plan.json', '--json'], { cwd: tmp.dir })).stdout);
    expect(json.byExistingSubscribers).toEqual({ 'increase-within-no-consent-threshold': 1, decrease: 1, 'increase-needs-consent': 1 });
    expect(json.products[0].ops.find((o: { territory: string }) => o.territory === 'DE')).toMatchObject({ existingSubscribers: 'increase-needs-consent', proceeds: '20.99' });
  });

  it('diff recomputes the class from the op and warns when an edited plan left its note behind', async () => {
    writeSpec([{ product, targets: prices, preserveCurrentPrice: false }]);
    expect((await plan()).code).toBe(2);
    const changeSet = readPlan();
    const de = changeSet.ops.find((o) => (o as BasePriceOp).target.territory === 'DE') as BasePriceOp;
    expect(changeSet.priceChanges?.find((n) => n.opId === de.id)?.classification).toBe('increase-needs-consent');
    // Someone flips preserveCurrentPrice in the op (a new hash) but leaves the note as it was
    de.options = { preserveCurrentPrice: true };
    writeFileSync(join(tmp.dir, 'edited.json'), JSON.stringify(changeSet));
    const text = (await run(['diff', 'edited.json'], { cwd: tmp.dir })).stdout;
    expect(text).toMatch(/DE\s+setPrice.*new subscribers only\n/);
    expect(text).toContain(`WARNING: ${de.id} DE: the plan's note says increase-needs-consent, but the op gives increase-to-new-subscribers-only. The note was edited or is stale; the op is what applies.`);
    expect(text).not.toContain('Needs consent (subscribers');
    const json = JSON.parse((await run(['diff', 'edited.json', '--json'], { cwd: tmp.dir })).stdout);
    expect(json.noteMismatches).toEqual([{ opId: de.id, territory: 'DE', stored: 'increase-needs-consent', recomputed: 'increase-to-new-subscribers-only' }]);
    expect(json.byExistingSubscribers['increase-needs-consent']).toBeUndefined();
    // The same works the other way: a note edited to look harmless is overruled by the op
    const original = readPlan();
    for (const n of original.priceChanges ?? []) n.classification = 'decrease';
    writeFileSync(join(tmp.dir, 'whitewashed.json'), JSON.stringify(original));
    const whitewashed = (await run(['diff', 'whitewashed.json'], { cwd: tmp.dir })).stdout;
    expect(whitewashed).toMatch(/DE\s+setPrice.*NEEDS CONSENT/);
    expect(whitewashed).toMatch(/WARNING: op-\d+ DE: the plan's note says decrease, but the op gives increase-needs-consent/);
  });

  it('maxIncreaseWithoutConsent refuses the plan before writing it; preserving prices passes', async () => {
    writeSpec([{ product, targets: prices, preserveCurrentPrice: false, consent: { maxIncreaseWithoutConsent: true } }]);
    const r = await plan(appleEnv, ['--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'CONSENT_REQUIRED', message: expect.stringMatching(/1 territories would need existing subscribers' consent; no plan was written:\n\s+apple:subscription:9000000001 DE \(7\.15%\)/) });
    expect(existsSync(join(tmp.dir, 'plan.json'))).toBe(false);
    expect(apple.writes()).toEqual([]);

    // Default preserveCurrentPrice: existing subscribers keep their price, nothing needs consent
    writeSpec([{ product, targets: prices, consent: { maxIncreaseWithoutConsent: true } }]);
    expect((await plan()).code).toBe(2);
    expect(readPlan().priceChanges?.find((n) => n.territory === 'DE')?.classification).toBe('increase-to-new-subscribers-only');
  });
});

describe('plan schema versions', () => {
  it('versions 1 and 2 keep their old FNV confirm hash and still apply, with a warning; version 3 plans use SHA-256', async () => {
    writeSpec([{ product, targets: { type: 'fixed', prices: { US: '29.99' } } }]);
    expect((await plan()).code).toBe(2);
    const v3 = readPlan();
    expect(v3.schemaVersion).toBe(3);
    const sha = JSON.parse((await run(['diff', 'plan.json', '--json'], { cwd: tmp.dir })).stdout).changeSetHash;
    expect(sha).toMatch(/^[0-9a-f]{32}$/);
    const fnv = fnv1a64(canonicalJson({ app: v3.app, ops: v3.ops }));

    const { priceChanges: _notes, dataFreshness: _data, ...rest } = v3;
    writeFileSync(join(tmp.dir, 'v1.json'), JSON.stringify({ ...rest, schemaVersion: 1 }));
    writeFileSync(join(tmp.dir, 'v2.json'), JSON.stringify({ ...v3, schemaVersion: 2 }));
    for (const file of ['v1.json', 'v2.json']) {
      const diff = await run(['diff', file], { cwd: tmp.dir });
      expect(diff.stdout).toContain(`Plan hash: ${fnv}`);
      expect(diff.stdout).toMatch(/WARNING: .*old FNV-1a confirm hash/);
    }
    // The SHA-256 hash of the same ops doesn't confirm an old plan, and the old hash doesn't confirm a new one
    expect((await run(['apply', 'v2.json', '--confirm', sha, '--allow-base-prices'], { env: appleEnv, cwd: tmp.dir })).code).toBe(1);
    expect((await run(['apply', 'plan.json', '--confirm', fnv, '--allow-base-prices'], { env: appleEnv, cwd: tmp.dir })).code).toBe(1);
    const applied = await run(['apply', 'v1.json', '--confirm', fnv, '--allow-base-prices'], { env: appleEnv, cwd: tmp.dir });
    expect(applied.code).toBe(0);
    expect(applied.stderr).toMatch(/WARNING: .*old FNV-1a confirm hash/);
    writeFileSync(join(tmp.dir, 'v9.json'), JSON.stringify({ ...rest, schemaVersion: 9 }));
    const newer = await run(['diff', 'v9.json', '--json'], { cwd: tmp.dir });
    expect(newer.code).toBe(1);
    expect(JSON.parse(newer.stdout).error.message).toMatch(/written by a newer PricingKit .*; upgrade PricingKit/);
  });
});

describe('proceeds targets', () => {
  it('App Store: the price point whose proceeds are nearest, noted on the op', async () => {
    // The fake's proceeds are 70% of the price: 29.99 -> 20.99
    writeSpec([{ product, targets: { type: 'fixed', prices: { US: '21' } }, measure: 'proceeds' }]);
    expect((await plan()).code).toBe(2);
    const changeSet = readPlan();
    const op = changeSet.ops[0] as BasePriceOp;
    expect(op.after).toMatchObject({ amount: '29.99', proceeds: '20.99' });
    expect(op.note).toBe('target proceeds 21 USD, proceeds 20.99 at price 29.99 (-0.01, 0.0005)');
    expect(changeSet.priceChanges?.[0]).toMatchObject({ target: { measure: 'proceeds', amount: '21' }, proceeds: { after: '20.99' } });
  });

  it('Google Play: estimated proceeds and tax in the notes, never in the op', async () => {
    writeSpec(
      [{ product: { platform: 'google', type: 'subscription', productId: 'pro', basePlanId: 'annual' }, targets: { type: 'fixed', prices: { US: '25.50' } }, measure: 'proceeds', commission: '0.15', consent: { billingPeriod: 'P1Y' } }],
      {},
      { packageName: 'com.example.app' }
    );
    expect((await plan(googleEnv)).code).toBe(2);
    const changeSet = readPlan();
    const op = changeSet.ops[0] as BasePriceOp;
    // 25.50 / 0.85 = 30 USD tax-exclusive; the fake has no tax
    expect(op.after).toEqual({ currency: 'USD', amount: '30' });
    expect(changeSet.priceChanges?.[0]).toMatchObject({ tax: '0', proceeds: { after: '25.5', estimated: true, commission: '0.15' }, classification: 'increase-to-new-subscribers-only', ifMigrated: 'opt-out-possible' });
    const diff = await run(['diff', 'plan.json'], { cwd: tmp.dir });
    expect(diff.stdout).toMatch(/Proceeds\*\s+Tax\*\s+Existing subscribers\*/);
    expect(diff.stdout).toMatch(/25\.5 \(est\.\)\s+0\s+new subscribers only \(migrating: opt-out possible\)/);
    expect(diff.stdout).toContain('Google Play proceeds are estimates: (price - tax) x (1 - commission), commission 0.15.');
    expect(play.writes()).toEqual([]);
  });
});

describe('custom multipliers from CSV', () => {
  const custom = (targets: object) => [{ product, targets: { type: 'strategy', strategy: 'custom', base: { territory: 'US', amount: '24.99' }, ...targets } }];

  it('reads the table from a CSV next to the spec (export columns plus "multiplier")', async () => {
    mkdirSync(join(tmp.dir, 'pricing'));
    writeFileSync(join(tmp.dir, 'pricing', 'm.csv'), 'territory,currency,amount,multiplier\nUS,USD,24.99,1\nDE,EUR,27.99,1.5\nGB,GBP,24.99,\n');
    writeFileSync(join(tmp.dir, 'pricing', 'spec.json'), JSON.stringify({ kind: PRICING_SPEC_KIND, schemaVersion: 1, app: { bundleId: BUNDLE }, products: custom({ multipliersFile: 'm.csv' }) }));
    const r = await run(['plan', '--spec', 'pricing/spec.json', '--out', 'plan.json'], { env: appleEnv, cwd: tmp.dir });
    expect(r.code).toBe(2);
    const ops = readPlan().ops as BasePriceOp[];
    // DE: 24.99 USD x 1.5 in EUR, snapped; GB has no multiplier and isn't priced; US is already at 24.99
    expect(ops.map((o) => o.target.territory)).toEqual(['DE']);
  });

  it('refuses a CSV outside the working directory, a bad table, or both forms', async () => {
    writeSpec(custom({ multipliersFile: '../m.csv' }));
    expect((await plan(appleEnv, ['--json'])).stdout).toMatch(/multipliersFile: a relative \.csv path/);
    writeSpec(custom({ multipliersFile: 'm.txt' }));
    expect((await plan(appleEnv, ['--json'])).stdout).toMatch(/a relative \.csv path/);
    writeFileSync(join(tmp.dir, 'm.csv'), 'territory,multiplier\nGB,lots\n');
    writeSpec(custom({ multipliersFile: 'm.csv' }));
    const bad = JSON.parse((await plan(appleEnv, ['--json'])).stdout).error;
    expect(bad).toMatchObject({ code: 'INVALID_SPEC', message: expect.stringMatching(/line 2: the multiplier must be a plain decimal/) });
    expect(bad.message).not.toContain('lots');
    expect(bad.message).not.toContain('GB');
    // A regular file of at most 1 MB
    mkdirSync(join(tmp.dir, 'dir.csv'));
    writeSpec(custom({ multipliersFile: 'dir.csv' }));
    expect((await plan(appleEnv, ['--json'])).stdout).toMatch(/dir\.csv is not a regular file/);
    writeFileSync(join(tmp.dir, 'big.csv'), `territory,multiplier\n${'GB,1\n'.repeat(250_001)}`);
    writeSpec(custom({ multipliersFile: 'big.csv' }));
    expect((await plan(appleEnv, ['--json'])).stdout).toMatch(/big\.csv is larger than 1000000 bytes/);
    writeSpec(custom({ multipliersFile: 'm.csv', multipliers: { GB: '1' } }));
    expect((await plan(appleEnv, ['--json'])).stdout).toMatch(/give multipliers or multipliersFile, not both/);
    writeSpec(custom({ multipliersFile: 'missing.csv' }));
    expect((await plan(appleEnv, ['--json'])).stdout).toMatch(/can't read missing\.csv/);
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('a file whose name starts with ".." is inside the working directory', async () => {
    writeFileSync(join(tmp.dir, '..x.csv'), 'territory,multiplier\nDE,1.5\n');
    writeSpec(custom({ multipliersFile: '..x.csv' }));
    expect((await plan()).code).toBe(2);
  });

  it('inline multipliers work in YAML specs', async () => {
    writeFileSync(join(tmp.dir, 'spec.yaml'), `kind: pricingkit.spec\nschemaVersion: 1\napp: { bundleId: ${BUNDLE} }\nproducts:\n  - product: { platform: apple, type: subscription, id: "${SUB_ID}" }\n    targets: { type: strategy, strategy: custom, base: { territory: US, amount: 24.99 }, multipliers: { DE: 1.50 } }\n`);
    expect((await run(['plan', '--spec', 'spec.yaml', '--out', 'plan.json'], { env: appleEnv, cwd: tmp.dir })).code).toBe(2);
  });
});

describe('reference data freshness', () => {
  const ppp = (extra: object = {}) => [{ product, targets: { type: 'strategy', strategy: 'ppp', base: { territory: 'US', amount: '24.99' }, ...extra } }];

  it('records the data used and its age; PPP data from 2024 is capped in 2030', async () => {
    writeSpec(ppp());
    const r = await plan(appleEnv, ['--json']);
    expect(r.code).toBe(0);
    const changeSet = parseChangeSet(r.stdout);
    expect(changeSet.ops).toEqual([]);
    expect(new Set(changeSet.skipped?.map((s) => s.reason))).toEqual(new Set(['STALE_REFERENCE_DATA']));
    expect(changeSet.dataFreshness?.map((f) => `${f.id}:${f.stale}`)).toEqual(['ppp:true', 'fallbackExchangeRates:true']);
    expect(changeSet.warnings?.map((w) => w.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^Reference data: PPP index/)]));
    const text = await run(['diff', 'plan.json'], { cwd: tmp.dir });
    expect(text.stdout).toMatch(/Reference data:\n\s+STALE PPP index \(World Bank PA\.NUS\.PPP, static\): as of 2024-12-31/);
  });

  it('refuseStale stops the plan; larger limits and spec rates with a date pass', async () => {
    writeSpec(ppp(), { freshness: { refuseStale: true } });
    const refused = await plan(appleEnv, ['--json']);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout).error.code).toBe('STALE_REFERENCE_DATA');
    expect(existsSync(join(tmp.dir, 'plan.json'))).toBe(false);

    writeSpec(ppp({ strategy: 'direct', exchangeRates: { GBP: '0.8', EUR: '0.9' }, exchangeRatesAsOf: '2029-12-30' }), { freshness: { refuseStale: true } });
    const ok = await plan();
    expect(ok.code).toBe(2);
    expect(readPlan().dataFreshness).toEqual([expect.objectContaining({ id: 'exchangeRates', asOf: '2029-12-30', ageDays: 2, stale: false })]);
  });
});
