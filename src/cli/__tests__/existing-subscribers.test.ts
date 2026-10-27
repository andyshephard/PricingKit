// preserveCurrentPrice: false moves existing App Store subscribers to the new
// price. diff shows it from the op itself (covered by the hash), whether or not
// the plan carries planner notes; and an undo that raises a price back keeps
// existing subscribers' price unless someone decides otherwise. Offline.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildUndoChangeSet, computeIdempotencyKey, createRun, invertOp, type BasePriceOp, type ChangeSet } from '@/lib/pricing';
import { run, tempDir } from './fixtures';

const product = { platform: 'apple', type: 'subscription', id: '9200000001' } as const;

function op(preserve: boolean | undefined, before = '4.99', after = '9.99', territory = 'US'): BasePriceOp {
  const o = {
    id: 'op-0001',
    kind: 'setPrice' as const,
    platform: 'apple' as const,
    target: { product, territory },
    before: { currency: 'USD', amount: before, pricePointId: `pp-${before}` },
    after: { currency: 'USD', amount: after, pricePointId: `pp-${after}` },
    ...(preserve !== undefined ? { options: { preserveCurrentPrice: preserve } } : {}),
  };
  return { ...o, idempotencyKey: computeIdempotencyKey(o) } as BasePriceOp;
}

const plan = (ops: BasePriceOp[]): ChangeSet => ({ schemaVersion: 3, kind: 'pricingkit.changeset', id: 'p', createdAt: '2030-01-01T00:00:00Z', app: { bundleId: 'com.example.app' }, ops });

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

describe('diff: existing subscribers without planner notes', () => {
  it('flags preserveCurrentPrice: false (an increase that reaches existing subscribers) from the op alone', async () => {
    writeFileSync(join(tmp.dir, 'moves.json'), JSON.stringify(plan([op(false)])));
    const r = await run(['diff', 'moves.json'], { cwd: tmp.dir });
    expect(r.stdout).toMatch(/WARNING: 1 App Store change moves EXISTING SUBSCRIBERS to the new price \(preserveCurrentPrice: false\): US \(op-0001\)/);
    expect(r.stdout).toMatch(/US\s+setPrice\s+4\.99 USD\s+9\.99 USD\s+\+100\.20%\s+MOVES EXISTING SUBSCRIBERS: notified, no consent/);
    // Computed from the op, so not labelled as a planner note
    expect(r.stdout).not.toContain('planner notes');
    const json = JSON.parse((await run(['diff', 'moves.json', '--json'], { cwd: tmp.dir })).stdout);
    expect(json.movesExistingSubscribers).toEqual([{ opId: 'op-0001', territory: 'US' }]);
    expect(json.products[0].ops[0]).toMatchObject({ movesExistingSubscribers: true, existingSubscribers: 'increase-within-no-consent-threshold' });
  });

  it('shows the default (existing subscribers keep their price) without a warning', async () => {
    writeFileSync(join(tmp.dir, 'keeps.json'), JSON.stringify(plan([op(undefined)])));
    const r = await run(['diff', 'keeps.json'], { cwd: tmp.dir });
    expect(r.stdout).not.toContain('WARNING');
    expect(r.stdout).toMatch(/US\s+setPrice.*new subscribers only/);
  });

  it('a note that claims otherwise does not hide it', async () => {
    const p = plan([op(false)]);
    p.priceChanges = [{ opId: 'op-0001', territory: 'US', classification: 'increase-to-new-subscribers-only', direction: 'increase', reasons: [] }];
    writeFileSync(join(tmp.dir, 'lying.json'), JSON.stringify(p));
    const r = await run(['diff', 'lying.json'], { cwd: tmp.dir });
    expect(r.stdout).toMatch(/WARNING: 1 App Store change moves EXISTING SUBSCRIBERS/);
    expect(r.stdout).toMatch(/the plan's note says increase-to-new-subscribers-only, but the op gives increase-within-no-consent-threshold/);
  });
});

describe('undo and preserveCurrentPrice', () => {
  it("undoing a decrease that reached existing subscribers doesn't raise their price, and says so", () => {
    const decrease = op(false, '9.99', '4.99');
    const inverse = invertOp(decrease);
    expect('op' in inverse && inverse.op.options).toEqual({ preserveCurrentPrice: true });
    expect('op' in inverse && inverse.warning).toMatch(/existing subscribers keep the lower price/);

    const original = plan([decrease]);
    const done = createRun(original, { id: 'r', now: '2030-01-01T00:00:00Z' });
    done.ops[0].status = 'ok';
    done.ops[0].attempts = 1;
    const undo = buildUndoChangeSet(original, done, { createdAt: '2030-01-02T00:00:00Z' });
    expect((undo.ops[0] as BasePriceOp).options).toEqual({ preserveCurrentPrice: true });
    expect(undo.warnings).toEqual([{ opId: undo.ops[0].id, message: expect.stringMatching(/raises the price back to 9\.99 USD for new subscribers only/) }]);
  });

  it('keeps the option as it was for an undo that lowers a price, and on Google Play', () => {
    const increase = op(false, '4.99', '9.99');
    const inverse = invertOp(increase);
    expect('op' in inverse && inverse.op.options).toEqual({ preserveCurrentPrice: false });
    expect('op' in inverse && inverse.warning).toBeUndefined();
    const google = { ...op(false, '9.99', '4.99'), platform: 'google' as const };
    expect('op' in invertOp(google) && (invertOp(google) as { op: BasePriceOp }).op.options).toEqual({ preserveCurrentPrice: false });
  });
});
