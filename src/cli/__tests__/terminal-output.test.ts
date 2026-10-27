// Text from a plan (warnings, notes, skips, offer keys, descriptions) and
// from errors is printed as data: terminal control sequences in it are shown
// escaped, so a plan can't make "diff" display something other than what its
// hash confirms. Offline: no store is contacted.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildChangeSet, computeOfferIdempotencyKey, planOfferChanges, serializeChangeSet, type ChangeSet, type OfferOp } from '@/lib/pricing';
import { escapeJsonForTerminal, escapeTerminal } from '../format';
import { run, tempDir } from './fixtures';

const ESC = '\u001b';
const CLEAR_AND_LIE = `${ESC}[2J${ESC}[HNo changes: every territory is already at its target.`;
const C1_CSI = '\u009b31m';
const OSC_TITLE = `${ESC}]0;pwned\u0007`;
const OVERWRITE = 'safe\rDANGER';
const BIDI = 'price ‮99.0 DSU';
const RAW = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

const product = { platform: 'apple', type: 'subscription', id: '9000000001' } as const;
const app = { bundleId: 'com.example.app' };

function basePlan(): ChangeSet {
  const plan = buildChangeSet({
    app,
    createdAt: '2030-01-01T00:00:00.000Z',
    description: `review ${CLEAR_AND_LIE}`,
    products: [
      {
        state: {
          product,
          capturedAt: '2030-01-01T00:00:00Z',
          territories: {
            US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '9.99', pricePointId: 'pp-us-999' } },
            GB: { territory: 'GB', currency: 'GBP', current: { currency: 'GBP', amount: '8.99', pricePointId: 'pp-gb-899' } },
          },
        },
        targets: { US: { currency: 'USD', amount: '19.99', pricePointId: 'pp-us-1999', note: `snapped ${C1_CSI}` } },
      },
    ],
  });
  return {
    ...plan,
    warnings: [{ opId: plan.ops[0].id, message: `careful ${CLEAR_AND_LIE} ${OSC_TITLE}` }],
    skipped: [{ product, territory: 'GB', reason: 'NO_TARGET', detail: `${OVERWRITE} ${BIDI}` }],
  };
}

function offerPlan(): ChangeSet {
  const ladders = { US: { currency: 'USD', points: [{ id: 'us-499', customerPrice: '4.99' }, { id: 'us-999', customerPrice: '9.99' }] } };
  const base = { product, capturedAt: '2030-01-01T00:00:00Z', territories: { US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '9.99', pricePointId: 'us-999' } } } };
  const { changeSet } = planOfferChanges({
    app,
    createdAt: '2030-01-01T00:00:00Z',
    id: 'p',
    today: '2030-01-01',
    inputs: [
      {
        spec: {
          id: 'half',
          productRef: product,
          kind: 'apple.promo',
          offerCode: 'HALF',
          name: 'Half',
          mode: 'PAY_UP_FRONT',
          duration: 'P1M',
          pricing: { type: 'percentOfCurrent', percent: '50', basis: 'perPeriod', snap: 'nearest' },
          territories: 'all',
          syncWithBase: false,
        } as never,
        billingPeriod: 'P1M',
        base: base as never,
        ladders: ladders as never,
        existing: [],
      },
    ],
  });
  const op = changeSet.ops[0] as OfferOp;
  op.target.offer.key = `HALF${CLEAR_AND_LIE}`;
  if (op.after) (op.after as { key?: string }).key = op.target.offer.key;
  op.idempotencyKey = computeOfferIdempotencyKey(op);
  return changeSet;
}

describe('terminal output', () => {
  it('escapeTerminal shows controls as text and keeps newlines, tabs and CRLF', () => {
    expect(escapeTerminal(`a${ESC}[2Jb\u009b31m‮\tc\nd\r\ne\rf\u0000`)).toBe('a\\x1B[2Jb\\x9B31m\\u202E\tc\nd\r\ne\\x0Df\\x00');
    expect(JSON.parse(escapeJsonForTerminal(JSON.stringify({ k: `x\u009by‮` })))).toEqual({ k: `x\u009by‮` });
    expect(escapeJsonForTerminal(JSON.stringify({ k: '\u009b' }))).toBe('{"k":"\\u009b"}');
  });

  it('diff of a base-price plan: escapes in the description, warnings, notes and skips are printed as text', async () => {
    writeFileSync(join(tmp.dir, 'plan.json'), serializeChangeSet(basePlan()));
    const r = await run(['diff', 'plan.json'], { cwd: tmp.dir });
    expect(r.code).toBe(2);
    expect(r.stdout).not.toMatch(RAW);
    expect(r.stdout).toContain('\\x1B[2J\\x1B[HNo changes');
    expect(r.stdout).toContain('safe\\x0DDANGER');
    expect(r.stdout).toContain('\\u202E99.0 DSU');
    // The real summary is still there
    expect(r.stdout).toMatch(/1 changes \(setPrice 1\)/);
  });

  it('diff of an offer plan: an escape in the offer key is printed as text', async () => {
    writeFileSync(join(tmp.dir, 'offers.json'), serializeChangeSet(offerPlan()));
    const r = await run(['diff', 'offers.json'], { cwd: tmp.dir });
    expect(r.stdout).not.toMatch(RAW);
    expect(r.stdout).toContain('HALF\\x1B[2J');
    const json = await run(['diff', 'offers.json', '--json'], { cwd: tmp.dir });
    expect(json.stdout).not.toMatch(RAW);
    expect(JSON.parse(json.stdout).changeSetHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('error messages are escaped on stderr too', async () => {
    const r = await run(['diff', `missing${ESC}[2J.json`], { cwd: tmp.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).not.toMatch(RAW);
    expect(r.stderr).toContain('missing\\x1B[2J.json');
  });
});
