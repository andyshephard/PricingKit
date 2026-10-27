// The CLI with Google Play offers, end to end against the stateful Play fake:
// offers, plan (offer specs and --rules), diff, apply and undo, with
// their exit codes. The Play client is mocked: nothing leaves the process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const googlePlayFetch = vi.fn();
vi.mock('@/lib/google-play/client', () => ({ googlePlayFetch: (...args: unknown[]) => googlePlayFetch(...args) }));

import { FakePlayOffers, money, PKG, PRODUCT, retentionOfferResource } from '@/lib/adapters/__tests__/fake-play-offers';
import { changeSetHash, parseChangeSet, parseRun } from '@/lib/pricing';
import { run, tempDir, throwawayRsaPem } from './fixtures';

let store: FakePlayOffers;
let env: Record<string, string>;
let tmp: ReturnType<typeof tempDir>;

const annual = { platform: 'google', type: 'subscription', productId: PRODUCT, basePlanId: 'annual' };
const offerSpec = {
  kind: 'pricingkit.offerPlanSpec',
  schemaVersion: 1,
  app: { packageName: PKG },
  offers: [
    {
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
    },
    {
      id: 'new-customer-trial',
      kind: 'play.offer',
      productRef: annual,
      mode: 'FREE_TRIAL',
      duration: 'P1W',
      pricing: { type: 'free' },
      eligibility: { type: 'play.targeting', rule: { type: 'acquisition', scope: 'anySubscriptionInApp' } },
      territories: 'all',
      syncWithBase: false,
    },
  ],
};

function writeJson(name: string, value: unknown) {
  writeFileSync(join(tmp.dir, name), JSON.stringify(value));
}

function rulesFile(offers: unknown[]) {
  return { kind: 'pricingkit.offerRules', schemaVersion: 1, app: { packageName: PKG }, offers };
}

beforeEach(async () => {
  store = new FakePlayOffers();
  googlePlayFetch.mockReset();
  googlePlayFetch.mockImplementation(store.handle);
  env = {
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account',
      client_email: 'robot@example-project.iam.gserviceaccount.com',
      private_key_id: 'abcdef0123456789',
      private_key: await throwawayRsaPem(),
    }),
  };
  tmp = tempDir();
  writeJson('offers.json', offerSpec);
});
afterEach(() => tmp.cleanup());

async function planFile() {
  const r = await run(['plan', '--spec', 'offers.json', '--out', 'plan.json'], { env, cwd: tmp.dir });
  const plan = parseChangeSet(readFileSync(join(tmp.dir, 'plan.json'), 'utf8'));
  return { r, plan, hash: changeSetHash(plan) };
}

describe('pricingkit offers --package-name', () => {
  it("lists a base plan's offers with state, eligibility, tags and phases", async () => {
    store.seed('annual', retentionOfferResource());
    const r = await run(['offers', '--package-name', PKG, '--subscription', PRODUCT, '--base-plan', 'annual'], { env, cwd: tmp.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/play\.offer {2}annual-half-off {2}ACTIVE/);
    expect(r.stdout).toMatch(/eligibility: Developer-determined/);
    expect(r.stdout).toMatch(/tags: rc-customer-center, rc-ignore-offer/);
    expect(r.stdout).toMatch(/1\) P1Y x1: 50% off/);
    const json = JSON.parse((await run(['offers', '--package-name', PKG, '--subscription', PRODUCT, '--json'], { env, cwd: tmp.dir })).stdout);
    expect(json).toMatchObject({ kind: 'pricingkit.offers', app: { packageName: PKG }, product: { basePlanId: '-' }, offers: [{ key: 'annual-half-off' }] });
    expect(store.calls.at(-1)!.path).toMatch(/basePlans\/-\/offers$/);
  });

  it('refuses App Store flags on Play', async () => {
    const r = await run(['offers', '--package-name', PKG, '--subscription', PRODUCT, '--kind', 'apple.promo'], { env, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--kind can only be play\.offer/);
  });
});

describe('pricingkit plan, diff, apply and undo with Play offers', () => {
  it('plans the two offers, previewing eligibility, phases, tags and per-region prices (exit 2, dry run)', async () => {
    const { r, plan, hash } = await planFile();
    expect(r.code).toBe(2);
    expect(plan.ops.map((op) => op.kind)).toEqual(['createOffer', 'createOffer']);
    expect(r.stdout).toContain(`Plan hash: ${hash}`);
    expect(r.stdout).toMatch(/Play offer annual-half-off on com\.example\.pro\/annual: create \(op-0001\)\n {2}State: ACTIVE \(new offer\)/);
    expect(r.stdout).toMatch(/Eligibility: Developer-determined/);
    expect(r.stdout).toMatch(/Eligibility: New customer acquisition: never had any subscription in the app/);
    expect(r.stdout).toMatch(/Tags: rc-customer-center, rc-ignore-offer/);
    expect(r.stdout).toMatch(/US\s+59\.99 USD\s+59\.99 USD\s+50% off\s+~30 USD\s+29\.99 USD \(49\.99%\)/);
    expect(r.stdout).toContain('Dry run: nothing was changed in the store.');
    expect(store.writes()).toEqual([]);

    const diff = await run(['diff', 'plan.json'], { env: {}, cwd: tmp.dir });
    expect(diff.code).toBe(2);
    expect(diff.stdout).toMatch(/Play offers:\n {2}op-0001 createOffer annual-half-off on google:subscription:com\.example\.pro\/annual\n {4}State: ACTIVE \(new offer\)/);
    expect(diff.stdout).toMatch(/phase 1: - -> 50% off/);
  });

  it('applies only with the hash, then undo deactivates (exit codes 1, 0, 2, 0)', async () => {
    const { hash } = await planFile();
    const reads = store.calls.length;
    const wrong = await run(['apply', 'plan.json', '--confirm', '0000000000000000', '--json'], { env, cwd: tmp.dir });
    expect(wrong.code).toBe(1);
    expect(JSON.parse(wrong.stdout).error.code).toBe('CONFIRM_MISMATCH');
    expect(store.calls).toHaveLength(reads);

    const applied = await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir });
    expect(applied.code).toBe(0);
    expect(store.offer('annual', 'annual-half-off')!.state).toBe('ACTIVE');
    expect(store.offer('annual', 'new-customer-trial')!.state).toBe('ACTIVE');
    const log = parseRun(readFileSync(join(tmp.dir, 'plan.run.json'), 'utf8'));
    expect(log.status).toBe('completed');

    const undo = await run(['undo', 'plan.json', 'plan.run.json'], { env: {}, cwd: tmp.dir });
    expect(undo.code).toBe(2);
    expect(undo.stdout).toMatch(/deletes only draft offers/);
    const undoPlan = parseChangeSet(readFileSync(join(tmp.dir, 'plan.undo.json'), 'utf8'));
    const reverted = await run(['apply', 'plan.undo.json', '--confirm', changeSetHash(undoPlan)], { env, cwd: tmp.dir });
    expect(reverted.code).toBe(0);
    expect(store.offer('annual', 'annual-half-off')!.state).toBe('INACTIVE');
  });

  it('exits 1 with the run log when an op fails, and --resume finishes it', async () => {
    const { hash } = await planFile();
    store.failNext((c) => c.path.endsWith('annual-half-off:activate'), 500);
    const failed = await run(['apply', 'plan.json', '--confirm', hash], { env, cwd: tmp.dir });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toMatch(/Resume with: pricingkit apply plan\.json --confirm/);
    expect(existsSync(join(tmp.dir, 'plan.run.json'))).toBe(true);
    const resumed = await run(['apply', 'plan.json', '--confirm', hash, '--resume', 'plan.run.json'], { env, cwd: tmp.dir });
    expect(resumed.code).toBe(0);
    expect(store.writes().filter((w) => w.endsWith('/offers'))).toHaveLength(2);
  });

  it('shows state, eligibility and tags before and after for a change, in the preview and in diff', async () => {
    store.seed('annual', retentionOfferResource('DRAFT'));
    const spec = structuredClone(offerSpec);
    spec.offers = [{ ...spec.offers[0], tags: ['rc-customer-center'], eligibility: { type: 'play.targeting', rule: { type: 'acquisition', scope: 'thisSubscription' } } } as never];
    writeJson('change.json', spec);
    const refused = await run(['plan', '--spec', 'change.json', '--out', 'change-plan.json'], { env, cwd: tmp.dir });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toMatch(/refused \(TAG_REMOVAL\)/);

    (spec.offers[0] as Record<string, unknown>).play = { allowTagRemoval: true };
    writeJson('change.json', spec);
    const r = await run(['plan', '--spec', 'change.json', '--out', 'change-plan.json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/State: DRAFT \(unchanged\)/);
    expect(r.stdout).toMatch(/Eligibility: Developer-determined .* -> New customer acquisition: never had this subscription/);
    expect(r.stdout).toMatch(/Tags: rc-customer-center, rc-ignore-offer -> rc-customer-center \(removes rc-ignore-offer\)/);
    expect(r.stdout).toMatch(/op-0001: removes tag rc-ignore-offer/);
    const diff = await run(['diff', 'change-plan.json', '--json'], { env: {}, cwd: tmp.dir });
    expect(JSON.parse(diff.stdout).playOffers[0]).toMatchObject({ stateBefore: 'DRAFT', stateAfter: 'DRAFT', tagsBefore: ['rc-customer-center', 'rc-ignore-offer'], tagsRemoved: ['rc-ignore-offer'], eligibilityBefore: expect.stringMatching(/^Developer-determined/) });
    const text = await run(['diff', 'change-plan.json'], { env: {}, cwd: tmp.dir });
    expect(text.stdout).toMatch(/Tags: rc-customer-center, rc-ignore-offer -> rc-customer-center \(removes rc-ignore-offer\)/);
  });

  it('exits 1 when Play prices a region further from its target than the threshold, leaving it out', async () => {
    const spec = structuredClone(offerSpec);
    // 33% of 59.99 = 19.80; the fake's Play price is 19.99 (1%); a 0.5% threshold refuses it
    spec.offers = [{ ...spec.offers[0], id: 'annual-third', tags: [], pricing: { type: 'percentOfCurrent', percent: '33', basis: 'totalOverDuration', snap: 'nearest' }, territories: ['US'], play: { deviationThreshold: '0.005' } } as never];
    writeJson('deviation.json', spec);
    const r = await run(['plan', '--spec', 'deviation.json', '--out', 'deviation-plan.json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/ERROR: 1 region was left out because Play's price is further from the target/);
    // The default threshold (5%) accepts it
    (spec.offers[0] as Record<string, unknown>).play = undefined;
    writeJson('deviation.json', spec);
    expect((await run(['plan', '--spec', 'deviation.json', '--out', 'deviation-plan.json'], { env, cwd: tmp.dir })).code).toBe(2);
  });

  it('refuses any app but the pinned one (PRICINGKIT_EXPECT_PACKAGE / _BUNDLE_ID) before reading anything', async () => {
    const { hash } = await planFile();
    const reads = store.calls.length;
    const pinned = await run(['apply', 'plan.json', '--confirm', hash, '--json'], { env: { ...env, PRICINGKIT_EXPECT_PACKAGE: 'com.example.other' }, cwd: tmp.dir });
    expect(pinned.code).toBe(1);
    expect(JSON.parse(pinned.stdout).error.code).toBe('APP_NOT_EXPECTED');
    expect(store.calls).toHaveLength(reads);
    const offers = await run(['offers', '--package-name', PKG, '--subscription', PRODUCT], { env: { ...env, PRICINGKIT_EXPECT_PACKAGE: 'com.example.other' }, cwd: tmp.dir });
    expect(offers.code).toBe(1);
    // The matching pin is fine; an App Store pin doesn't restrict Play
    expect((await run(['offers', '--package-name', PKG, '--subscription', PRODUCT], { env: { ...env, PRICINGKIT_EXPECT_PACKAGE: PKG, PRICINGKIT_EXPECT_BUNDLE_ID: 'com.example.ios' }, cwd: tmp.dir })).code).toBe(0);
    const apple = await run(['offers', '--bundle-id', 'com.example.app', '--subscription', '123'], { env: { PRICINGKIT_EXPECT_BUNDLE_ID: 'com.example.ios' }, cwd: tmp.dir });
    expect(apple.stderr).toMatch(/is not the app PRICINGKIT_EXPECT_BUNDLE_ID allows/);
  });

  it('refuses a Play spec for another app than the one on the command line', async () => {
    const r = await run(['plan', '--spec', 'offers.json', '--out', 'plan.json', '--package-name', 'com.example.other'], { env, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not the app in the spec/);
  });
});

describe('pricingkit plan --rules with Play offers', () => {
  it('plan --rules: nothing to do while in step; re-prices a percent-of-current offer after a base change', async () => {
    store.seed('annual', retentionOfferResource());
    store.seed('annual', {
      offerId: 'annual-half-price',
      state: 'ACTIVE',
      phases: [{ duration: 'P1Y', recurrenceCount: 1, regionalConfigs: [{ regionCode: 'US', price: money('USD', '29.99') }] }],
      regionalConfigs: [{ regionCode: 'US', newSubscriberAvailability: true }],
    });
    writeJson(
      'rules.json',
      rulesFile([
        { product: annual, kind: 'play.offer', key: 'annual-half-off', pricing: { type: 'play.relativeDiscount', fraction: '0.5' }, syncWithBase: true },
        { product: annual, kind: 'play.offer', key: 'annual-half-price', pricing: { type: 'percentOfCurrent', percent: '50', snap: 'nearest' }, territories: ['US'], syncWithBase: true },
      ])
    );
    const inStep = await run(['plan', '--rules', 'rules.json', '--out', 'before.json'], { env, cwd: tmp.dir });
    expect(inStep.code).toBe(0);
    expect(inStep.stdout).toMatch(/annual-half-price\s+in step with its rule/);

    store.setBasePrice('annual', 'US', '69.99');

    const sync = await run(['plan', '--rules', 'rules.json', '--out', 'sync.json'], { env, cwd: tmp.dir });
    expect(sync.code).toBe(2);
    expect(sync.stdout).toMatch(/annual-half-off\s+follows base automatically \(Play relative discount\)/);
    expect(sync.stdout).toMatch(/annual-half-price\s+op-0001: re-price 1 regions \(against current base prices\)/);
    const plan = parseChangeSet(readFileSync(join(tmp.dir, 'sync.json'), 'utf8'));
    expect(plan.ops).toMatchObject([{ kind: 'updateOfferPrices', target: { offer: { key: 'annual-half-price' } } }]);
    expect((await run(['apply', 'sync.json', '--confirm', changeSetHash(plan)], { env, cwd: tmp.dir })).code).toBe(0);
    expect((await run(['plan', '--rules', 'rules.json', '--out', 'after.json'], { env, cwd: tmp.dir })).code).toBe(0);
  });

});
