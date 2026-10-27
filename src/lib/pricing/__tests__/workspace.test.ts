import { describe, it, expect } from 'vitest';
import {
  buildWorkspacePlan,
  parsePricingSpec,
  parseWorkspace,
  parseWorkspacePlan,
  serializeWorkspacePlan,
  specTargets,
  WorkspaceError,
  workspaceAppSpec,
  workspacePlanHash,
  type PricingSpecProduct,
  type ProductPriceState,
  type WorkspacePlanEntry,
} from '..';

const IOS = { bundleId: 'com.example.app' };
const ANDROID = { packageName: 'com.example.app' };
const IOS2 = { bundleId: 'com.example.other' };
const appleSub = { platform: 'apple', type: 'subscription', id: '9700000001' } as const;
const playPlan = { platform: 'google', type: 'subscription', productId: 'com.example.pro', basePlanId: 'annual' } as const;

const ws = (extra: Record<string, unknown> = {}) => ({
  kind: 'pricingkit.workspace',
  schemaVersion: 1,
  apps: [
    { id: 'ios', app: IOS, products: [{ product: { platform: 'apple', type: 'subscription', id: '9700000002' }, targets: { type: 'fixed', prices: { US: '9.99' } } }] },
    { id: 'android', app: ANDROID, rules: 'rules/android.yaml' },
    { id: 'ios-two', app: IOS2, spec: 'specs/other.json' },
  ],
  parity: [
    {
      id: 'annual',
      apple: { bundleId: IOS.bundleId, subscription: appleSub.id },
      play: { packageName: ANDROID.packageName, subscription: playPlan.productId, basePlan: playPlan.basePlanId },
      target: { type: 'strategy', strategy: 'ppp', base: { amount: '49.99' } },
      baseTerritory: 'US',
      threshold: '0.050',
    },
  ],
  ...extra,
});

function issues(input: unknown): string[] {
  try {
    parseWorkspace(input);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    return (error as WorkspaceError).issues;
  }
  throw new Error('expected the workspace to be refused');
}

describe('parseWorkspace', () => {
  it('reads apps on both stores, file references and parity mappings', () => {
    const parsed = parseWorkspace(JSON.stringify(ws()));
    expect(parsed.apps.map((a) => a.id)).toEqual(['ios', 'android', 'ios-two']);
    expect(parsed.parity![0].threshold).toBe('0.05');
  });

  it('refuses a workspace from a newer PricingKit, and unknown fields', () => {
    expect(issues({ ...ws(), schemaVersion: 2 })[0]).toMatch(/newer PricingKit/);
    expect(issues({ ...ws(), extra: true })[0]).toMatch(/Unrecognized key/);
    expect(issues('{')).toEqual(['not valid JSON']);
  });

  it('keeps every app distinct: ids and apps listed once', () => {
    const doubled = ws();
    doubled.apps.push({ id: 'ios', app: IOS, rules: 'r.json' } as never);
    expect(issues(doubled)).toEqual(['apps.3 (ios): the id is used twice', 'apps.3 (ios): com.example.app (App Store) is already apps.0; list each app once']);
    // The same ID on the other store is another app
    expect(() => parseWorkspace(ws())).not.toThrow();
  });

  it('checks paths stay inside the workspace and name spec files', () => {
    const bad = (spec: string) => issues({ ...ws(), apps: [{ id: 'ios', app: IOS, spec }] });
    expect(bad('../outside.json')[0]).toMatch(/stay inside the workspace/);
    expect(bad('/abs/spec.json')[0]).toMatch(/relative path|stay inside/);
    expect(bad('specs/.git/x.json')[0]).toMatch(/stay inside/);
    expect(bad('specs/spec.txt')[0]).toMatch(/\.json, \.yaml or \.yml/);
    expect(bad('specs/sp ec.json')[0]).toMatch(/relative path/);
  });

  it('refuses spec and products together, and malformed ids', () => {
    expect(issues({ ...ws(), parity: [], apps: [{ id: 'ios', app: IOS, spec: 's.json', products: [{}] }] })).toEqual(['apps.0 (ios): give spec or products, not both']);
    expect(issues({ ...ws(), apps: [{ id: 'iOS App', app: IOS }] })[0]).toMatch(/lower-case letters/);
  });

  it('checks parity mappings: both apps in the workspace, each product mapped once, settings with a target', () => {
    const mapping = ws().parity[0];
    expect(issues({ ...ws(), parity: [{ ...mapping, apple: { bundleId: 'com.unknown', subscription: '1' } }] })).toEqual(['parity.0 (annual): apple.bundleId is not one of the workspace\'s apps']);
    expect(issues({ ...ws(), parity: [{ ...mapping, play: { ...mapping.play, packageName: 'com.unknown' } }] })).toEqual(['parity.0 (annual): play.packageName is not one of the workspace\'s apps']);
    expect(issues({ ...ws(), parity: [mapping, { ...mapping, id: 'again' }] })).toEqual([
      'parity.1 (again): the App Store subscription is already mapped by annual',
      'parity.1 (again): the Google Play base plan is already mapped by annual',
    ]);
    const { target: _target, ...noTarget } = mapping;
    void _target;
    expect(issues({ ...ws(), parity: [noTarget] })).toEqual(['parity.0 (annual): baseTerritory and snap go with a target']);
    expect(issues({ ...ws(), parity: [{ ...mapping, threshold: '1.5' }] })[0]).toMatch(/fraction from 0 to 1/);
    expect(issues({ ...ws(), parity: [{ ...mapping, apple: { bundleId: IOS.bundleId, subscription: 'abc' } }] })[0]).toMatch(/numeric/);
  });
});

describe('workspaceAppSpec', () => {
  it("builds each app's spec from its own products plus the parity target for that store, app by app", () => {
    const parsed = parseWorkspace(ws());
    const ios = workspaceAppSpec(parsed, parsed.apps[0])!;
    expect(ios.app).toEqual(IOS);
    expect(ios.products.map((p) => [p.product, p.baseTerritory])).toEqual([
      [{ platform: 'apple', type: 'subscription', id: '9700000002' }, undefined],
      [appleSub, 'US'],
    ]);
    // The parity target's base territory comes from the mapping (per product)
    expect(ios.products[1].targets).toMatchObject({ type: 'strategy', base: { territory: 'US', amount: '49.99' } });

    const android = workspaceAppSpec(parsed, parsed.apps[1])!;
    expect(android.app).toEqual(ANDROID);
    expect(android.products.map((p) => p.product)).toEqual([playPlan]);
    // An app with nothing to price has no spec
    expect(workspaceAppSpec(parsed, parsed.apps[2])).toBeUndefined();
  });

  it("never lets a spec file for another app in, or a product priced twice", () => {
    const parsed = parseWorkspace(ws());
    const otherApp = parsePricingSpec({ kind: 'pricingkit.spec', schemaVersion: 1, app: IOS, products: [{ product: { platform: 'apple', type: 'subscription', id: '1' }, targets: { type: 'fixed', prices: { US: '1' } } }] });
    expect(() => workspaceAppSpec(parsed, parsed.apps[2], otherApp)).toThrow(/is for com\.example\.app \(App Store\), not com\.example\.other/);

    const clash = parseWorkspace(ws({ apps: [{ id: 'ios', app: IOS, products: [{ product: appleSub, targets: { type: 'fixed', prices: { US: '1' } } }] }, { id: 'android', app: ANDROID }] }));
    expect(() => workspaceAppSpec(clash, clash.apps[0])).toThrow(/apple:subscription:9700000001 has its own spec entry and parity\.annual's target/);
  });

  it('names a bad parity target by its mapping', () => {
    const parsed = parseWorkspace(ws({ parity: [{ ...ws().parity[0], target: { type: 'fixed', prices: { US: 'abc' } } }] }));
    expect(() => workspaceAppSpec(parsed, parsed.apps[0])).toThrow(/app ios: parity annual\.targets\.prices\.US/);
  });
});

describe('per-product base territory', () => {
  const state = (product: PricingSpecProduct['product'], prices: Record<string, [string, string]>): ProductPriceState => ({
    product,
    capturedAt: '2030-01-01T00:00:00Z',
    territories: Object.fromEntries(Object.entries(prices).map(([t, [amount, currency]]) => [t, { territory: t, currency, current: { currency, amount } }])),
  });
  const spec = (products: unknown[]) => ({ kind: 'pricingkit.spec', schemaVersion: 1, app: IOS, products });
  const subA = { platform: 'apple', type: 'subscription', id: '1' } as const;
  const subB = { platform: 'apple', type: 'subscription', id: '2' } as const;
  const direct = { type: 'strategy', strategy: 'direct', base: { amount: '10' }, exchangeRates: { USD: '1', GBP: '0.5' } };

  it('takes a strategy base territory from the product; two products of one app may differ', () => {
    const parsed = parsePricingSpec(spec([
      { product: subA, baseTerritory: 'US', targets: direct },
      { product: subB, baseTerritory: 'GB', targets: direct },
    ]));
    expect(parsed.products.map((p) => p.targets.type === 'strategy' && p.targets.base.territory)).toEqual(['US', 'GB']);
    const prices = { US: ['10', 'USD'], GB: ['5', 'GBP'] } as Record<string, [string, string]>;
    // 10 in the base territory's currency: 10 USD -> 5 GBP for A; 10 GBP -> 20 USD for B
    expect(specTargets(parsed.products[0], state(subA, prices)).targets).toEqual({ GB: { currency: 'GBP', amount: '5' }, US: { currency: 'USD', amount: '10' } });
    expect(specTargets(parsed.products[1], state(subB, prices)).targets).toEqual({ GB: { currency: 'GBP', amount: '10' }, US: { currency: 'USD', amount: '20' } });
  });

  it('has no app-wide default: a strategy without either is refused, and the two must agree', () => {
    expect(() => parsePricingSpec(spec([{ product: subA, targets: direct }]))).toThrow(/needs a base territory: give targets\.base\.territory or the product's baseTerritory \(there is no app-wide default\)/);
    expect(() => parsePricingSpec(spec([{ product: subA, baseTerritory: 'GB', targets: { ...direct, base: { territory: 'US', amount: '10' } } }]))).toThrow(/\(US\) and the product's baseTerritory \(GB\) differ/);
    // Agreeing is fine, and so is the target's own territory alone (unchanged behaviour)
    expect(() => parsePricingSpec(spec([{ product: subA, baseTerritory: 'US', targets: { ...direct, base: { territory: 'US', amount: '10' } } }]))).not.toThrow();
    expect(() => parsePricingSpec(spec([{ product: subA, targets: { ...direct, base: { territory: 'US', amount: '10' } } }]))).not.toThrow();
  });

  it("checks custom multipliers and CPI against the product's base territory", () => {
    const custom = { type: 'strategy', strategy: 'custom', base: { amount: '10' }, multipliers: { IN: '0.4' }, territories: ['GB', 'IN'] };
    expect(() => parsePricingSpec(spec([{ product: subA, baseTerritory: 'GB', targets: custom }]))).not.toThrow();
    expect(() => parsePricingSpec(spec([{ product: subA, baseTerritory: 'US', targets: custom }]))).toThrow(/no multiplier for GB/);
    const inflate = { type: 'strategy', strategy: 'ppp', base: { amount: '10' }, pppStaleness: { mode: 'inflate', cpi: { GB: '1.2' } } };
    expect(() => parsePricingSpec(spec([{ product: subA, baseTerritory: 'US', targets: inflate }]))).toThrow(/needs cpi for the base territory US/);
  });
});

describe('workspace plan index', () => {
  const entry = (over: Partial<WorkspacePlanEntry> = {}): WorkspacePlanEntry => ({
    appId: 'ios',
    app: IOS,
    part: 'prices',
    file: 'ios.json',
    hash: '0123456789abcdef0123456789abcdef',
    ops: 2,
    baseOps: 2,
    offerOps: 0,
    manualActions: 0,
    ...over,
  });
  const plans = [entry(), entry({ appId: 'android', app: ANDROID, file: 'android.json', hash: 'fedcba9876543210fedcba9876543210' })];

  it('hashes every plan with its app, part, file and hash, in order', () => {
    const index = buildWorkspacePlan({ createdAt: '2030-01-01T00:00:00Z', plans });
    expect(parseWorkspacePlan(serializeWorkspacePlan(index))).toEqual(index);
    expect(workspacePlanHash([...plans].reverse())).not.toBe(index.hash);
    expect(workspacePlanHash([plans[0], { ...plans[1], app: IOS2 }])).not.toBe(index.hash);
    // Counts are information only: not part of the hash
    expect(workspacePlanHash([{ ...plans[0], ops: 99 } as WorkspacePlanEntry, plans[1]])).toBe(index.hash);
  });

  it('hashes every index with SHA-256, whatever its version; a 16-digit (FNV) hash is refused', () => {
    const index = buildWorkspacePlan({ createdAt: '2030-01-01T00:00:00Z', plans });
    expect(index.schemaVersion).toBe(2);
    expect(index.hash).toMatch(/^[0-9a-f]{32}$/);
    // Relabelled as version 1: still read, still checked against the SHA-256 hash
    expect(parseWorkspacePlan({ ...index, schemaVersion: 1 }).hash).toBe(index.hash);
    expect(() => parseWorkspacePlan({ ...index, schemaVersion: 1, hash: 'a'.repeat(16) })).toThrow(/32 hex digits/);
  });

  it('refuses an index edited after planning, a plan listed twice or a path outside its folder', () => {
    const index = buildWorkspacePlan({ createdAt: '2030-01-01T00:00:00Z', plans });
    expect(() => parseWorkspacePlan({ ...index, plans: [plans[0], { ...plans[1], app: IOS2 }] })).toThrow(/the hash doesn't match/);
    const twice = buildWorkspacePlan({ createdAt: 'x', plans: [plans[0], { ...plans[0], part: 'offers' }] });
    expect(() => parseWorkspacePlan(twice)).toThrow(/ios\.json is listed twice/);
    const sameApp = buildWorkspacePlan({ createdAt: 'x', plans: [plans[0], { ...plans[0], file: 'other.json' }] });
    expect(() => parseWorkspacePlan(sameApp)).toThrow(/has two prices plans/);
    const outside = buildWorkspacePlan({ createdAt: 'x', plans: [{ ...plans[0], file: '../ios.json' }] });
    expect(() => parseWorkspacePlan(outside)).toThrow(/a plan file name next to the index/);
    expect(() => parseWorkspacePlan({ ...index, schemaVersion: 3 })).toThrow(/newer PricingKit/);
  });
});
