// YAML spec and rules files: converted to the same JSON the core parsers
// read, numbers kept as written, tags and several documents refused, and
// errors that never quote the file. The CLI parts run against the
// in-memory App Store fake: nothing leaves the process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});

import { FakeOfferStore } from '@/lib/adapters/__tests__/fake-apple-offer-store';
import { parseChangeSet, parseOfferPlanSpec, parseOfferRules, parsePricingSpec } from '@/lib/pricing';
import { isYamlPath, yamlToJson, YamlSpecError } from '../spec-file';
import { fakeAppleEnv, run, tempDir } from './fixtures';

const BUNDLE = 'com.example.app';
const A = '0123456789';

describe('yamlToJson', () => {
  it('keeps numbers as written except under integer keys', () => {
    const json = JSON.parse(
      yamlToJson(`
kind: pricingkit.spec
schemaVersion: 1
app: { bundleId: ${BUNDLE} }
products:
  - product: { platform: apple, type: subscription, id: ${A} }
    targets:
      type: fixed
      prices: { GB: 4.10, US: 5, NO: 59.00, JP: 1500 }
`)
    );
    expect(json.schemaVersion).toBe(1);
    expect(json.products[0].product.id).toBe(A); // a leading zero survives
    // NO stays a territory (YAML 1.2), not false; amounts keep their text
    expect(json.products[0].targets.prices).toEqual({ GB: '4.10', US: '5', NO: '59.00', JP: '1500' });
    const spec = parsePricingSpec(yamlToJson(`kind: pricingkit.spec\nschemaVersion: 1\napp: { bundleId: ${BUNDLE} }\nproducts:\n  - product: { platform: apple, type: subscription, id: ${A} }\n    targets: { type: fixed, prices: { GB: 4.10 } }\n`));
    expect(spec.products[0].targets).toEqual({ type: 'fixed', prices: { GB: '4.1' } });
  });

  it('reads offer plan specs and rules files with integer fields', () => {
    const offers = parseOfferPlanSpec(
      yamlToJson(`
kind: pricingkit.offerPlanSpec
schemaVersion: 1
app: { bundleId: ${BUNDLE} }
offers:
  - id: example_monthly_intro
    productRef: { platform: apple, type: subscription, id: ${A} }
    kind: apple.promo
    mode: PAY_AS_YOU_GO
    duration: P1M
    periods: 3
    pricing: { type: percentOfCurrent, percent: 50, basis: perPeriod, snap: nearest }
    territories: all
    syncWithBase: true
`)
    );
    expect(offers.offers[0]).toMatchObject({ periods: 3, pricing: { percent: '50' } });
    const rules = parseOfferRules(
      yamlToJson(`
kind: pricingkit.offerRules
schemaVersion: 1
app: { packageName: com.example.app }
offers:
  - product: { platform: google, type: subscription, productId: pro, basePlanId: annual }
    kind: play.offer
    key: annual-half-off
    phase: 1
    pricing: { type: play.relativeDiscount, fraction: 0.5 }
    deviationThreshold: 0.05
    syncWithBase: true
`)
    );
    expect(rules.offers[0]).toMatchObject({ phase: 1, deviationThreshold: '0.05', pricing: { fraction: '0.5' } });
  });

  it('refuses tags, several documents, duplicate keys and bad syntax, without quoting the file', () => {
    const secret = 'do-not-echo-this-value';
    const cases: Array<[string, RegExp]> = [
      [`a: !!binary aGVsbG8=\nb: ${secret}`, /line 1, column \d+: tags such as tag:yaml\.org,2002:binary aren't allowed/],
      [`a: !custom ${secret}`, /TAG_RESOLVE_FAILED|tags such as/],
      [`a: ${secret}\n---\nb: 2`, /MULTIPLE_DOCS/],
      [`a: ${secret}\na: 2`, /line 2, column 1: DUPLICATE_KEY/],
      [`a: [${secret},\n`, /not valid YAML \(line \d+, column \d+: [A-Z_]+\)/],
    ];
    for (const [text, message] of cases) {
      let error: unknown;
      try {
        yamlToJson(text, 'spec file x.yaml');
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(YamlSpecError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('caps aliases (no alias bombs)', () => {
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x]', 'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]', 'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]', 'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]', 'e: [*d, *d, *d, *d, *d, *d, *d, *d, *d]'].join('\n');
    expect(() => yamlToJson(bomb)).toThrow(YamlSpecError);
  });

  it('knows YAML files by extension', () => {
    expect(['a.yaml', 'b.YML', 'c.json', 'd'].map(isYamlPath)).toEqual([true, true, false, false]);
  });
});

describe('pricingkit with YAML files', () => {
  let store: FakeOfferStore;
  let env: Record<string, string>;
  let tmp: ReturnType<typeof tempDir>;

  beforeEach(async () => {
    store = new FakeOfferStore().addSubscription(A, 'ONE_YEAR', { USA: '49.99', GBR: '44.99' }, { USA: ['24.99', '27.99', '49.99', '54.99'], GBR: ['22.99', '24.99', '44.99', '49.99'] });
    store.seedPromo(A, 'example_annual_50', {}, { USA: '24.99', GBR: '22.99' });
    appleApiRequest.mockReset();
    appleApiRequest.mockImplementation(store.handle);
    env = await fakeAppleEnv();
    tmp = tempDir();
  });
  afterEach(() => tmp.cleanup());

  it('plans from a YAML spec with a YAML rules file, the same as from JSON', async () => {
    writeFileSync(
      join(tmp.dir, 'base.yaml'),
      `# Base prices, reviewed in pull requests\nkind: pricingkit.spec\nschemaVersion: 1\napp:\n  bundleId: ${BUNDLE}\nproducts:\n  - product: { platform: apple, type: subscription, id: "${A}" }\n    targets:\n      type: fixed\n      prices: { US: 54.99, GB: 49.99 }\n`
    );
    writeFileSync(
      join(tmp.dir, 'rules.yml'),
      `kind: pricingkit.offerRules\nschemaVersion: 1\napp: { bundleId: ${BUNDLE} }\noffers:\n  - product: { platform: apple, type: subscription, id: "${A}" }\n    kind: apple.promo\n    key: example_annual_50\n    pricing: { type: percentOfCurrent, percent: 50, snap: nearest }\n    syncWithBase: true\n`
    );
    const r = await run(['plan', '--spec', 'base.yaml', '--rules', 'rules.yml', '--out', 'plan.json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(2);
    const plan = parseChangeSet(readFileSync(join(tmp.dir, 'plan.json'), 'utf8'));
    expect(plan.ops.map((op) => op.kind)).toEqual(['setPrice', 'setPrice', 'updateOfferPrices']);
    // The same rules file alone: the offer is in step with today's prices
    expect((await run(['plan', '--rules', 'rules.yml', '--out', 'sync.json'], { env, cwd: tmp.dir })).code).toBe(0);
    expect(store.writes()).toEqual([]);
  });

  it('reports bad YAML as INVALID_YAML before any store request', async () => {
    writeFileSync(join(tmp.dir, 'bad.yaml'), 'kind: pricingkit.spec\nkind: again\n');
    const r = await run(['plan', '--spec', 'bad.yaml', '--json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: 'INVALID_YAML', message: expect.stringMatching(/spec file bad\.yaml is not valid YAML \(line 2/) });
    expect(appleApiRequest).not.toHaveBeenCalled();
  });
});
