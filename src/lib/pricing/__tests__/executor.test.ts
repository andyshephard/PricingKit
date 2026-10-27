import { describe, it, expect } from 'vitest';
import {
  applyChangeSet,
  basePriceOps,
  buildChangeSet,
  buildUndoChangeSet,
  changeSetHash,
  describeRun,
  parseChangeSet,
  parseRun,
  RunValidationError,
  serializeChangeSet,
  serializeRun,
  summarizeRun,
  type ApplyRun,
  type ChangeSet,
} from '..';
import { RequestBudget } from '@/lib/utils/request-budget';
import { ApiError } from '@/lib/utils/api-error';
import { FakeStore } from './fixtures/fake-store';
import { APPLE_APP, APPLE_SUB, GOOGLE_APP, GOOGLE_PLAN, appleState, googleState } from './fixtures/plan-fixtures';

const clock = () => {
  let t = 0;
  return () => new Date(Date.UTC(2030, 0, 1, 0, 0, t++)).toISOString();
};

function applePlan(): ChangeSet {
  return buildChangeSet({
    app: APPLE_APP,
    createdAt: '2030-01-01T00:00:00.000Z',
    products: [
      {
        state: appleState(),
        targets: {
          US: { currency: 'USD', amount: '24.99', pricePointId: 'pp-us-2499' },
          GB: { currency: 'GBP', amount: '19.99', pricePointId: 'pp-gb-1999' },
          DE: { currency: 'EUR', amount: '31.99', pricePointId: 'pp-de-3199', startDate: '2030-07-01' },
        },
      },
    ],
  });
}

function googlePlan(): ChangeSet {
  return buildChangeSet({
    app: GOOGLE_APP,
    createdAt: '2030-01-01T00:00:00.000Z',
    products: [
      {
        state: googleState(),
        targets: {
          US: { currency: 'USD', amount: '19.99' },
          GB: { currency: 'GBP', amount: '17.99' },
          JP: { currency: 'JPY', amount: '2900' },
          FR: { currency: 'EUR', amount: '18.99' },
        },
        options: { allowNewTerritories: true },
      },
    ],
  });
}

const serverError = () => new ApiError('Apple is down', { status: 503, platform: 'apple' });

describe('applyChangeSet', () => {
  it('applies every op and records it', async () => {
    const store = new FakeStore('apple', [appleState()]);
    const run = await applyChangeSet(applePlan(), { adapter: store, now: clock() });
    expect(run.status).toBe('completed');
    expect(summarizeRun(run)).toEqual({ pending: 0, ok: 3, skipped: 0, failed: 0 });
    expect(store.state(APPLE_SUB).territories.GB.current).toEqual({ currency: 'GBP', amount: '19.99', pricePointId: 'pp-gb-1999' });
    expect(run.ops[0].observed).toMatchObject({ pricePointId: 'pp-de-2999' });
    expect(run.ops.every((r) => r.attempts === 1 && r.response)).toBe(true);
    expect(describeRun(applePlan(), run)[0]).toMatch(/^ok +op-0001 schedulePrice apple:subscription:9000000001 DE/);
  });

  describe('idempotency', () => {
    it('applying the same plan twice changes nothing the second time', async () => {
      const store = new FakeStore('apple', [appleState()]);
      const plan = applePlan();
      await applyChangeSet(plan, { adapter: store, now: clock() });
      const stateAfterFirst = structuredClone(store.state(APPLE_SUB));
      const writesAfterFirst = store.writes.length;

      const second = await applyChangeSet(plan, { adapter: store, now: clock() });
      expect(store.writes.length).toBe(writesAfterFirst);
      expect(store.state(APPLE_SUB)).toEqual(stateAfterFirst);
      expect(second.status).toBe('completed');
      expect(second.ops.map((r) => [r.status, r.skipReason])).toEqual([
        ['skipped', 'ALREADY_AT_TARGET'],
        ['skipped', 'ALREADY_AT_TARGET'],
        ['skipped', 'ALREADY_AT_TARGET'],
      ]);
    });

    it('re-running a finished run sends nothing', async () => {
      const store = new FakeStore('apple', [appleState()]);
      const plan = applePlan();
      const run = await applyChangeSet(plan, { adapter: store });
      const reads = store.reads;
      const again = await applyChangeSet(plan, { adapter: store, run });
      expect(store.writes).toHaveLength(3);
      expect(store.reads).toBe(reads); // nothing left to check
      expect(again.passes).toBe(2);
    });

    it('also holds for a Google plan written in one batch', async () => {
      const store = new FakeStore('google', [googleState()]).enableBatching();
      const plan = googlePlan();
      await applyChangeSet(plan, { adapter: store });
      expect(store.writes).toEqual(['batch:FR,GB,JP,US']);
      const second = await applyChangeSet(plan, { adapter: store });
      expect(store.writes).toHaveLength(1);
      expect(second.ops.every((r) => r.status === 'skipped')).toBe(true);
    });
  });

  describe('resume after a partial failure', () => {
    it('retries only what failed and leaves finished ops alone', async () => {
      const store = new FakeStore('apple', [appleState()]);
      store.failures.set('GB', { times: 1, error: serverError });
      const plan = applePlan();

      const first = await applyChangeSet(plan, { adapter: store, now: clock() });
      expect(first.status).toBe('incomplete');
      expect(first.ops.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
      expect(first.ops[1].error).toMatchObject({ status: 503, message: 'Apple is down' });

      // Resume from the saved log, as if after a restart
      const saved = parseRun(serializeRun(first));
      const writesBefore = store.writes.length;
      const resumed = await applyChangeSet(parseChangeSet(serializeChangeSet(plan)), { adapter: store, run: saved, now: clock() });
      expect(resumed.status).toBe('completed');
      expect(store.writes.slice(writesBefore)).toEqual(['setPrice:GB']);
      expect(resumed.ops.map((r) => [r.status, r.attempts])).toEqual([
        ['ok', 1],
        ['ok', 2],
        ['ok', 1],
      ]);
      expect(resumed.ops[1].error).toBeUndefined();
    });

    it('counts a write that took effect despite an error as done, without sending it again', async () => {
      const store = new FakeStore('apple', [appleState()]);
      store.failures.set('GB', { times: 1, afterWrite: true, error: serverError });
      const plan = applePlan();
      const first = await applyChangeSet(plan, { adapter: store });
      expect(first.ops[1].status).toBe('failed');

      const resumed = await applyChangeSet(plan, { adapter: store, run: first });
      expect(resumed.ops[1]).toMatchObject({ status: 'ok', response: { confirmedOnResume: true }, attempts: 1 });
      expect(store.writes.filter((w) => w === 'setPrice:GB')).toHaveLength(1);
      // ...and undo reverses it, because this run made the change
      expect(basePriceOps(buildUndoChangeSet(plan, resumed)).map((op) => op.target.territory)).toContain('GB');
    });

    it('resumes correctly from the log saved while a write was in flight (crash mid-request)', async () => {
      const store = new FakeStore('apple', [appleState()]);
      const plan = applePlan();
      const saved: ApplyRun[] = [];
      let onDisk: ApplyRun | undefined;
      const realApply = store.apply.bind(store);
      store.apply = async (op, context) => {
        const response = await realApply(op, context);
        if (op.target.territory === 'GB') {
          // The store took the write; the process dies before hearing back.
          onDisk = structuredClone(saved.at(-1)!);
          throw new Error('process killed');
        }
        return response;
      };
      await applyChangeSet(plan, { adapter: store, concurrency: 1, onUpdate: (r) => void saved.push(r) });

      // What was on disk at the crash: GB marked as attempted, not finished
      const gbOnDisk = onDisk!.ops.find((r) => r.opId === 'op-0002')!;
      expect(gbOnDisk).toMatchObject({ status: 'pending', attempts: 1 });

      store.apply = realApply;
      const writes = store.writes.length;
      const resumed = await applyChangeSet(plan, { adapter: store, run: parseRun(serializeRun(onDisk!)) });
      expect(resumed.ops.find((r) => r.opId === 'op-0002')).toMatchObject({ status: 'ok', response: { confirmedOnResume: true } });
      expect(store.writes.slice(writes)).not.toContain('setPrice:GB');
      expect(basePriceOps(buildUndoChangeSet(plan, resumed)).map((op) => op.target.territory)).toContain('GB');
    });

    it('stops before any further write when the run log cannot be saved', async () => {
      const store = new FakeStore('apple', [appleState()]);
      let calls = 0;
      const run = await applyChangeSet(applePlan(), {
        adapter: store,
        concurrency: 1,
        onUpdate: () => {
          calls++;
          // classification + first pre-write + first post-write succeed; the next pre-write save fails
          if (calls === 4) throw new Error('disk full');
        },
      });
      expect(store.writes).toEqual(['schedulePrice:DE']);
      expect(run.stoppedReason).toBe('PERSIST_FAILED');
      expect(run.stoppedDetail).toMatch(/disk full/);
      expect(run.ops.map((r) => [r.status, r.attempts])).toEqual([
        ['ok', 1],
        ['pending', 0],
        ['pending', 0],
      ]);
    });

    it('refuses to resume a run with a different plan', async () => {
      const store = new FakeStore('apple', [appleState()]);
      const run = await applyChangeSet(applePlan(), { adapter: store });
      const other = buildChangeSet({
        app: APPLE_APP,
        products: [{ state: appleState(), targets: { GB: { currency: 'GBP', amount: '9.99', pricePointId: 'pp-gb-999' } } }],
      });
      await expect(applyChangeSet(other, { adapter: store, run })).rejects.toThrow(RunValidationError);
    });
  });

  it('never writes over a territory that changed since the plan was made', async () => {
    const store = new FakeStore('apple', [appleState()]);
    store.state(APPLE_SUB).territories.GB.current = { currency: 'GBP', amount: '22.99', pricePointId: 'pp-gb-2299' };
    const run = await applyChangeSet(applePlan(), { adapter: store });
    expect(run.ops[1]).toMatchObject({ status: 'failed', error: { code: 'STATE_CHANGED', retryable: false } });
    expect(run.ops[1].error?.message).toMatch(/22\.99 GBP/);
    expect(store.writes).not.toContain('setPrice:GB');
    expect(run.status).toBe('incomplete');
  });

  describe('undo', () => {
    it('restores the before state exactly, and the undo plan is a reviewable ChangeSet', async () => {
      const original = appleState();
      const store = new FakeStore('apple', [original]);
      const plan = applePlan();
      const run = await applyChangeSet(plan, { adapter: store });

      const undo = parseChangeSet(serializeChangeSet(buildUndoChangeSet(plan, run, { createdAt: '2030-01-02T00:00:00.000Z' })));
      expect(undo.undoOf).toEqual({ changeSetId: plan.id, runId: run.id });
      expect(basePriceOps(undo).map((op) => [op.kind, op.target.territory])).toEqual([
        ['setPrice', 'US'],
        ['setPrice', 'GB'],
        ['schedulePrice', 'DE'],
      ]);

      const undoRun = await applyChangeSet(undo, { adapter: store });
      expect(undoRun.status).toBe('completed');
      expect(store.state(APPLE_SUB).territories).toEqual(original.territories);
    });

    it('deletes a scheduled price the run created and removes a Google region it added', async () => {
      const apple = new FakeStore('apple', [appleState()]);
      const schedulePlan = buildChangeSet({
        app: APPLE_APP,
        products: [{ state: appleState(), targets: { GB: { currency: 'GBP', amount: '27.99', pricePointId: 'pp-gb-2799', startDate: '2030-09-01' } } }],
      });
      const run = await applyChangeSet(schedulePlan, { adapter: apple });
      const undo = buildUndoChangeSet(schedulePlan, run);
      expect(undo.ops[0]).toMatchObject({ kind: 'deleteScheduled', after: null });
      await applyChangeSet(undo, { adapter: apple });
      expect(apple.state(APPLE_SUB).territories.GB.scheduled ?? null).toBeNull();

      const google = new FakeStore('google', [googleState()]);
      const gPlan = googlePlan();
      const gRun = await applyChangeSet(gPlan, { adapter: google });
      await applyChangeSet(buildUndoChangeSet(gPlan, gRun), { adapter: google });
      expect(google.state(GOOGLE_PLAN).territories).toEqual(googleState().territories);
    });

    it('reverses only what the run changed', async () => {
      const store = new FakeStore('apple', [appleState()]);
      store.failures.set('US', { times: 5, error: serverError });
      const plan = applePlan();
      // GB is already at target before the run: skipped, so not undone either
      store.state(APPLE_SUB).territories.GB.current = { currency: 'GBP', amount: '19.99', pricePointId: 'pp-gb-1999' };
      const run = await applyChangeSet(plan, { adapter: store });
      expect(run.ops.map((r) => r.status)).toEqual(['ok', 'skipped', 'failed']);
      expect(basePriceOps(buildUndoChangeSet(plan, run)).map((op) => op.target.territory)).toEqual(['DE']);
    });

    it('lists what it cannot reverse', async () => {
      const state = appleState();
      delete state.territories.US;
      const store = new FakeStore('apple', [state]);
      const plan = buildChangeSet({
        app: APPLE_APP,
        products: [{ state, targets: { US: { currency: 'USD', amount: '24.99', pricePointId: 'pp-us-2499' } }, options: { allowNewTerritories: true } }],
      });
      const run = await applyChangeSet(plan, { adapter: store });
      const undo = buildUndoChangeSet(plan, run);
      expect(undo.ops).toEqual([]);
      expect(undo.notReversible).toEqual([{ opId: 'op-0001', reason: expect.stringMatching(/can't remove the current price/) }]);
    });
  });

  describe('budget', () => {
    it('stops before the budget runs out and resumes later with a new one', async () => {
      // 1 read + 3 writes needed; allow 3
      const budget = new RequestBudget({ limit: 3 });
      const store = new FakeStore('apple', [appleState()], budget);
      const plan = applePlan();
      const run = await applyChangeSet(plan, { adapter: store, budget, concurrency: 1 });
      expect(budget.used).toBe(3);
      expect(run.status).toBe('incomplete');
      expect(run.stoppedReason).toBe('BUDGET_EXCEEDED');
      expect(run.ops.map((r) => r.status)).toEqual(['ok', 'ok', 'pending']);
      expect(store.writes).toHaveLength(2);

      const nextBudget = new RequestBudget({ limit: 3 });
      const resumedStore = Object.assign(store, { budget: nextBudget });
      const resumed = await applyChangeSet(plan, { adapter: resumedStore, budget: nextBudget, run });
      expect(resumed.status).toBe('completed');
      expect(store.writes).toHaveLength(3);
    });

    it('records a budget refusal from the store client and stops', async () => {
      const budget = new RequestBudget({ limit: 2 }); // read + one write
      const store = new FakeStore('apple', [appleState()], budget);
      // The executor isn't told about the budget, so only the client refusal stops it
      const run = await applyChangeSet(applePlan(), { adapter: store, concurrency: 1 });
      expect(budget.used).toBe(2);
      expect(run.stoppedReason).toBe('BUDGET_EXCEEDED');
      expect(run.ops.map((r) => r.status)).toEqual(['ok', 'failed', 'pending']);
      expect(run.ops[1].error).toMatchObject({ code: 'BUDGET_EXCEEDED', status: 429 });
    });

    it('never starts an op the remaining budget cannot finish, even with writes in flight', async () => {
      const budget = new RequestBudget({ limit: 4 }); // 1 read + 3 left; each op needs 2
      const store = new FakeStore('apple', [appleState()], budget);
      store.costPerOp = 2;
      const run = await applyChangeSet(applePlan(), { adapter: store, budget, concurrency: 2 });
      expect(budget.used).toBe(3);
      expect(run.ops.map((r) => r.status)).toEqual(['ok', 'pending', 'pending']);
      expect(run.stoppedReason).toBe('BUDGET_EXCEEDED');
      expect(run.stoppedDetail).toMatch(/needs 2/);
      expect(run.ops.every((r) => r.status !== 'failed')).toBe(true);
    });

    it('keeps a reserve when asked', async () => {
      const budget = new RequestBudget({ limit: 10 });
      const store = new FakeStore('apple', [appleState()], budget);
      const run = await applyChangeSet(applePlan(), { adapter: store, budget, reserve: 8, concurrency: 1 });
      expect(budget.remaining).toBe(8);
      expect(run.ops.map((r) => r.status)).toEqual(['ok', 'pending', 'pending']);
    });

    it('caps concurrent writes', async () => {
      const store = new FakeStore('apple', [appleState()]);
      await applyChangeSet(applePlan(), { adapter: store, concurrency: 2 });
      expect(store.peakInFlight).toBe(2);
      const serial = new FakeStore('apple', [appleState()]);
      await applyChangeSet(applePlan(), { adapter: serial, concurrency: 1 });
      expect(serial.peakInFlight).toBe(1);
    });
  });

  it('publishes the run after every change, in order', async () => {
    const store = new FakeStore('apple', [appleState()]);
    const updates: ApplyRun[] = [];
    const final = await applyChangeSet(applePlan(), { adapter: store, onUpdate: (r) => void updates.push(r), concurrency: 1 });
    expect(updates.length).toBeGreaterThanOrEqual(4);
    expect(updates.at(-1)).toEqual(final);
    const okCounts = updates.map((r) => summarizeRun(r).ok);
    expect(okCounts).toEqual([...okCounts].sort((a, b) => a - b));
  });

  it('records adapter warnings on the op and shows them in describeRun', async () => {
    const store = new FakeStore('apple', [appleState()]);
    const realApply = store.apply.bind(store);
    store.apply = async (op, context) => ({ ...(await realApply(op, context)), ...(op.target.territory === 'GB' ? { warning: 'old price left in place' } : {}) });
    const plan = applePlan();
    const run = await applyChangeSet(plan, { adapter: store });
    expect(run.ops[1]).toMatchObject({ status: 'ok', warning: 'old price left in place' });
    expect(parseRun(serializeRun(run)).ops[1].warning).toBe('old price left in place');
    expect(describeRun(plan, run)[1]).toMatch(/WARNING: old price left in place$/);
  });

  it('marks ops verified after a read-back', async () => {
    const store = new FakeStore('apple', [appleState()]);
    const run = await applyChangeSet(applePlan(), { adapter: store, verify: true });
    expect(run.ops.every((r) => r.verified === true)).toBe(true);
  });

  it('records a failed state read for every op of the product', async () => {
    const store = new FakeStore('apple', [appleState()]);
    store.fetchState = async () => {
      throw new ApiError('Forbidden', { status: 403, platform: 'apple' });
    };
    const run = await applyChangeSet(applePlan(), { adapter: store });
    expect(run.ops.every((r) => r.status === 'failed' && r.error?.status === 403)).toBe(true);
    expect(store.writes).toEqual([]);
  });

  it('rejects an adapter for the wrong platform and keeps the run tied to its plan', async () => {
    const google = new FakeStore('google', [googleState()]);
    await expect(applyChangeSet(applePlan(), { adapter: google })).rejects.toThrow(/adapter is google/);
    const plan = applePlan();
    const run = await applyChangeSet(plan, { adapter: new FakeStore('apple', [appleState()]) });
    expect(run.changeSetHash).toBe(changeSetHash(plan));
  });
});
