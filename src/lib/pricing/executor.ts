// The executor: apply a ChangeSet through a platform adapter, idempotently,
// within a request budget, recording every op in an ApplyRun.
//
// For each op not yet done, the executor reads the product's current state
// first and compares the territory with the op:
//   - already at `after`  -> skipped (applying a plan twice changes nothing)
//   - at `before`         -> applied
//   - anything else       -> failed with STATE_CHANGED; nothing is sent,
//                            because the store no longer matches what the
//                            plan's reviewer saw
// Ops recorded as ok or skipped in a run passed back in are not touched
// again, so a partial run can be resumed.

import {
  checkChangeSetRules,
  ChangeSetValidationError,
  describeOp,
  opSlot,
  type BasePriceOp,
  type ChangeSet,
} from './changeset';
import { mapWithConcurrency } from './concurrency';
import { describePrice, productKey, samePrice, type PriceValue, type ProductPriceState } from './model';
import type { ApplyContext, BudgetView, OpResponse, PlatformAdapter } from './adapter';
import { assertRunMatches, createRun, type ApplyRun, type OpError, type OpRecord } from './run';

export const STATE_CHANGED = 'STATE_CHANGED';
const BUDGET_EXCEEDED = 'BUDGET_EXCEEDED';
export const PERSIST_FAILED = 'PERSIST_FAILED';

export interface ApplyOptions {
  adapter: PlatformAdapter;
  /** A run of this ChangeSet to resume; omitted = start a new run */
  run?: ApplyRun;
  /** Most store writes in flight at once (default 2) */
  concurrency?: number;
  /**
   * Budget the adapter spends from. The executor stops starting new work
   * once `remaining` falls to `reserve`, leaving the rest pending.
   */
  budget?: BudgetView;
  /** Requests to keep in hand when stopping early (default 0) */
  reserve?: number;
  /** Re-read each touched product after applying and mark ops verified (costs one read per product) */
  verify?: boolean;
  /** Called with a snapshot of the run after every change; persist it to survive a crash */
  onUpdate?: (run: ApplyRun) => void | Promise<void>;
  /** Clock override, for tests */
  now?: () => string;
}

function toOpError(error: unknown): OpError {
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; retryable?: unknown; detail?: unknown };
    const message =
      typeof e.detail === 'string' && e.detail ? e.detail : typeof e.message === 'string' && e.message ? e.message : 'Unknown error';
    const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
    return {
      message,
      ...(status !== undefined ? { status } : {}),
      ...(typeof e.code === 'string' || typeof e.code === 'number' ? { code: e.code } : {}),
      ...(typeof e.retryable === 'boolean' ? { retryable: e.retryable } : {}),
    };
  }
  return { message: typeof error === 'string' ? error : 'Unknown error' };
}

function isBudgetError(error: OpError): boolean {
  return error.code === BUDGET_EXCEEDED;
}

type Classification =
  | { kind: 'atTarget'; observed: PriceValue | null }
  | { kind: 'ready'; observed: PriceValue | null }
  | { kind: 'drifted'; observed: PriceValue | null; message: string };

/** Compare an op with the territory's current state. */
export function classifyOp(op: BasePriceOp, state: ProductPriceState): Classification {
  const territory = state.territories[op.target.territory];
  const slot = opSlot(op.kind);
  const observed = (slot === 'scheduled' ? territory?.scheduled : territory?.current) ?? null;
  if (samePrice(op.platform, observed, op.after, slot)) return { kind: 'atTarget', observed };
  if (samePrice(op.platform, observed, op.before, slot)) return { kind: 'ready', observed };
  return {
    kind: 'drifted',
    observed,
    message:
      `${op.target.territory} ${slot} price is ${describePrice(observed)}; the plan expected ${describePrice(op.before)} ` +
      `(or ${describePrice(op.after)} if already applied). Nothing was sent. Re-plan from current prices.`,
  };
}

function computeStatus(run: ApplyRun): ApplyRun['status'] {
  return run.ops.every((r) => r.status === 'ok' || r.status === 'skipped') ? 'completed' : 'incomplete';
}

/**
 * Apply `changeSet` and return the run log. Never throws for a store
 * failure: failures are recorded per op. Throws only for an invalid plan or
 * a run that belongs to a different plan.
 */
export async function applyChangeSet(changeSet: ChangeSet, options: ApplyOptions): Promise<ApplyRun> {
  const { adapter, concurrency = 2, budget, reserve = 0, verify = false } = options;
  const now = options.now ?? (() => new Date().toISOString());

  const problems = checkChangeSetRules(changeSet);
  if (problems.length > 0) throw new ChangeSetValidationError(problems);
  const wrongPlatform = changeSet.ops.find((op) => op.platform !== adapter.platform);
  if (wrongPlatform) {
    throw new ChangeSetValidationError([`op ${wrongPlatform.id} is for ${wrongPlatform.platform}, adapter is ${adapter.platform}`]);
  }

  let run: ApplyRun;
  if (options.run) {
    assertRunMatches(changeSet, options.run);
    run = structuredClone(options.run);
  } else {
    run = createRun(changeSet, { now: now() });
  }
  run.passes += 1;
  run.status = 'running';
  delete run.stoppedReason;
  delete run.stoppedDetail;
  delete run.finishedAt;

  const records = new Map(run.ops.map((r) => [r.opId, r]));

  let stopReason: string | undefined;
  let stopDetail: string | undefined;
  const stop = (reason: string, detail?: string) => {
    if (stopReason) return;
    stopReason = reason;
    stopDetail = detail;
  };

  // onUpdate calls run one at a time, in order. If one fails, the saved log
  // can no longer be trusted to show what was sent, so the run stops before
  // any further write (in-flight writes finish and are recorded in the result).
  let updateChain: Promise<unknown> = Promise.resolve();
  const publish = async (): Promise<boolean> => {
    run.updatedAt = now();
    const snapshot = structuredClone(run);
    const result = updateChain.then(() => options.onUpdate?.(snapshot));
    updateChain = result.catch(() => undefined);
    try {
      await result;
      return true;
    } catch (error) {
      stop(PERSIST_FAILED, `Saving the run log failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const update = (record: OpRecord, changes: Partial<OpRecord>) => {
    Object.assign(record, changes);
    if (changes.status === 'ok' || changes.status === 'skipped') delete record.error;
    if (changes.status === 'ok' || changes.status === 'failed') delete record.skipReason;
  };

  const budgetLow = () => budget !== undefined && budget.remaining <= reserve;

  // 1. Ops still to do, grouped by product
  const todo = changeSet.ops.filter((op) => {
    const status = records.get(op.id)!.status;
    return status === 'pending' || status === 'failed';
  });
  const byProduct = new Map<string, BasePriceOp[]>();
  for (const op of todo) {
    const key = productKey(op.target.product);
    byProduct.set(key, [...(byProduct.get(key) ?? []), op]);
  }

  // 2. Read each product once and classify its ops
  const ready: Array<{ op: BasePriceOp; context: ApplyContext }> = [];
  const states = new Map<string, ProductPriceState>();
  for (const [key, productOps] of byProduct) {
    if (stopReason || budgetLow()) {
      stop(stopReason ?? BUDGET_EXCEEDED);
      break;
    }
    let state: ProductPriceState;
    try {
      state = await adapter.fetchState(productOps[0].target.product);
      states.set(key, state);
    } catch (error) {
      const opError = toOpError(error);
      for (const op of productOps) {
        update(records.get(op.id)!, { status: 'failed', finishedAt: now(), error: { ...opError, message: `Could not read current prices: ${opError.message}` } });
      }
      if (isBudgetError(opError)) stop(BUDGET_EXCEEDED);
      await publish();
      continue;
    }
    for (const op of productOps) {
      const record = records.get(op.id)!;
      const result = classifyOp(op, state);
      if (result.kind === 'atTarget' && record.attempts > 0) {
        // An earlier pass sent this op and it failed or timed out, yet the store
        // now holds the target: that attempt took effect (e.g. an Apple create
        // that answered 5xx). Count it as this run's change so undo reverses it.
        update(record, { status: 'ok', observed: result.observed, finishedAt: now(), response: { confirmedOnResume: true } });
      } else if (result.kind === 'atTarget') {
        update(record, { status: 'skipped', skipReason: 'ALREADY_AT_TARGET', observed: result.observed, finishedAt: now() });
      } else if (result.kind === 'drifted') {
        update(record, { status: 'failed', observed: result.observed, finishedAt: now(), error: { message: result.message, code: STATE_CHANGED, retryable: false } });
      } else {
        update(record, { observed: result.observed });
        ready.push({ op, context: { territoryState: state.territories[op.target.territory] } });
      }
    }
    await publish();
  }

  // 3. Apply, in batches the adapter can write together
  const units: Array<Array<{ op: BasePriceOp; context: ApplyContext }>> = [];
  const batches = new Map<string, Array<{ op: BasePriceOp; context: ApplyContext }>>();
  for (const item of ready) {
    const key = adapter.applyMany ? adapter.batchKey?.(item.op) : undefined;
    if (key === undefined) {
      units.push([item]);
    } else {
      if (!batches.has(key)) {
        const batch: Array<{ op: BasePriceOp; context: ApplyContext }> = [];
        batches.set(key, batch);
        units.push(batch);
      }
      batches.get(key)!.push(item);
    }
  }

  const finish = (op: BasePriceOp, outcome: { response?: OpResponse; error?: unknown }) => {
    const record = records.get(op.id)!;
    if (outcome.error !== undefined) {
      const opError = toOpError(outcome.error);
      update(record, { status: 'failed', finishedAt: now(), error: opError });
      if (isBudgetError(opError)) stop(BUDGET_EXCEEDED);
    } else {
      const warning = typeof outcome.response?.warning === 'string' ? outcome.response.warning : undefined;
      update(record, {
        status: 'ok',
        finishedAt: now(),
        ...(outcome.response ? { response: outcome.response } : {}),
        ...(warning ? { warning } : {}),
      });
    }
  };

  // Requests held back for units in flight, so two units can't both count on
  // the same remaining budget. Conservative: a unit's reservation is held
  // until it finishes even as its requests are spent.
  let reserved = 0;
  const requestsFor = (unit: Array<{ op: BasePriceOp; context: ApplyContext }>) =>
    adapter.requestsNeeded
      ? adapter.requestsNeeded(unit.map((u) => u.op), unit.map((u) => u.context))
      : unit.length;

  await mapWithConcurrency(units, concurrency, async (unit) => {
    // Never start an op the budget can't finish: a two-request op (create
    // then delete) stopped halfway leaves the store in a state no plan expects.
    const needed = requestsFor(unit);
    if (stopReason || (budget !== undefined && budget.remaining - reserved - reserve < needed)) {
      stop(stopReason ?? BUDGET_EXCEEDED, stopReason ? undefined : `Not enough request budget left to start ${unit.map((u) => u.op.id).join(', ')} (needs ${needed})`);
      return; // left pending (or failed from an earlier pass) for a resume
    }
    reserved += needed;
    try {
      await runUnit(unit);
    } finally {
      reserved -= needed;
    }
  });

  async function runUnit(unit: Array<{ op: BasePriceOp; context: ApplyContext }>): Promise<void> {
    // Record the attempt and persist it BEFORE sending, so a crash mid-request
    // leaves a log that shows the op may have been sent (attempts > 0). On
    // resume, an op found at its target is then counted as this run's change.
    const previous = unit.map(({ op }) => {
      const record = records.get(op.id)!;
      const before = { attempts: record.attempts, startedAt: record.startedAt };
      update(record, { attempts: record.attempts + 1, startedAt: now() });
      return before;
    });
    // Only a failed save cancels a unit that already holds its budget
    // reservation; another unit stopping for budget doesn't affect this one.
    if (!(await publish()) || stopReason === PERSIST_FAILED) {
      // Nothing was sent: undo the in-memory attempt so the log stays truthful
      unit.forEach(({ op }, i) => Object.assign(records.get(op.id)!, previous[i]));
      return;
    }
    if (unit.length > 1 || (adapter.applyMany && adapter.batchKey?.(unit[0].op) !== undefined)) {
      let outcomes: Array<{ response?: OpResponse; error?: unknown }>;
      try {
        outcomes = await adapter.applyMany!(unit.map((u) => u.op), unit.map((u) => u.context));
      } catch (error) {
        outcomes = unit.map(() => ({ error }));
      }
      unit.forEach((u, i) => finish(u.op, outcomes[i] ?? { error: new Error('Adapter returned no outcome for this op') }));
    } else {
      const { op, context } = unit[0];
      try {
        finish(op, { response: await adapter.apply(op, context) });
      } catch (error) {
        finish(op, { error });
      }
    }
    await publish();
  }

  // 4. Optional read-back
  if (verify && !stopReason) {
    for (const [key, productOps] of byProduct) {
      const applied = productOps.filter((op) => records.get(op.id)!.status === 'ok');
      if (applied.length === 0 || !states.has(key)) continue;
      try {
        const after = await adapter.fetchState(applied[0].target.product);
        for (const op of applied) {
          update(records.get(op.id)!, { verified: classifyOp(op, after).kind === 'atTarget' });
        }
      } catch {
        // Verification is best effort; the ops themselves succeeded
      }
    }
  }

  run.status = computeStatus(run);
  if (stopReason) run.stoppedReason = stopReason;
  if (stopDetail) run.stoppedDetail = stopDetail;
  if (run.status === 'completed') run.finishedAt = now();
  await publish();
  return structuredClone(run);
}

/** One line per op, for logs and CLI output. */
export function describeRun(changeSet: ChangeSet, run: ApplyRun): string[] {
  const ops = new Map(changeSet.ops.map((op) => [op.id, op]));
  return run.ops.map((record) => {
    const op = ops.get(record.opId);
    const what = op ? describeOp(op) : record.opId;
    const why = record.error ? ` (${record.error.message})` : record.skipReason ? ` (${record.skipReason})` : '';
    const warning = record.warning ? ` WARNING: ${record.warning}` : '';
    return `${record.status.padEnd(7)} ${record.opId} ${what}${why}${warning}`;
  });
}
