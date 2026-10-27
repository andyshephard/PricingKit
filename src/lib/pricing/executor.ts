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
//
// Offer ops (offer-ops.ts) follow the same rules against the product's
// offers, read once per product. A plan with offer ops is applied only with
// `confirm` set to the plan's hash (what the reviewer saw), and an offer is
// deleted only with `force.deleteOffers`, because App Store Connect doesn't
// report redemptions.

import {
  changeSetHash,
  checkChangeSetRules,
  ChangeSetValidationError,
  describeOp,
  opSlot,
  type BasePriceOp,
  type ChangeOp,
  type ChangeSet,
} from './changeset';
import { mapWithConcurrency } from './concurrency';
import { describePrice, productKey, samePrice, type PriceValue, type ProductPriceState } from './model';
import type { ApplyContext, BudgetView, OfferApplyContext, OpResponse, PlatformAdapter } from './adapter';
import { classifyOfferOp, isOfferOp, offerKindLabel, type OfferOp } from './offer-ops';
import type { StoreOffer } from './offers';
import { assertRunMatches, createRun, type ApplyRun, type OpError, type OpRecord } from './run';

export const STATE_CHANGED = 'STATE_CHANGED';
const BUDGET_EXCEEDED = 'BUDGET_EXCEEDED';
export const PERSIST_FAILED = 'PERSIST_FAILED';
/** A deleteOffer op was not sent because force.deleteOffers wasn't set */
export const REDEMPTIONS_UNCHECKED = 'REDEMPTIONS_UNCHECKED';

/**
 * Thrown before anything is read or sent when a plan with offer ops is
 * applied without the right confirm hash. The message never includes the
 * plan's hash: the hash is what a reviewer copies from the preview, so an
 * error must not hand it out.
 */
export class ConfirmationRequiredError extends Error {
  constructor() {
    super(
      "This plan changes offers and the confirmation doesn't match it. Review the plan (the preview, or `pricingkit diff`) and confirm with the hash shown there."
    );
    this.name = 'ConfirmationRequiredError';
  }
}

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
  /**
   * Required when the plan has offer ops: changeSetHash() of the plan the
   * reviewer approved. Any other value refuses the whole apply before
   * anything is read or sent.
   */
  confirm?: string;
  /** Explicit overrides of safety checks */
  force?: {
    /**
     * Delete offers even though the store can't say whether anyone redeemed
     * them (App Store Connect's API reports no redemptions). Without it a
     * deleteOffer op fails with REDEMPTIONS_UNCHECKED and nothing is sent.
     */
    deleteOffers?: boolean;
  };
  /** Clock override, for tests */
  now?: () => string;
}

type ReadyItem =
  | { offer: false; op: BasePriceOp; context: ApplyContext }
  | { offer: true; op: OfferOp; context: OfferApplyContext };

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
  const problem = territory?.problems?.[slot];
  if (problem) {
    return {
      kind: 'drifted',
      observed,
      message: `${op.target.territory} ${slot} price can't be read unambiguously (${problem}). Nothing was sent. Resolve it in the store (e.g. clear the extra scheduled price), then re-plan.`,
    };
  }
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
  const hasOfferOps = changeSet.ops.some(isOfferOp);
  if (hasOfferOps) {
    const hash = changeSetHash(changeSet);
    if (options.confirm !== hash) throw new ConfirmationRequiredError();
    if (!adapter.fetchOffers || !adapter.applyOffer) {
      throw new ChangeSetValidationError([`the ${adapter.platform} adapter can't apply offer ops`]);
    }
  }
  const today = () => now().slice(0, 10);

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
  const byProduct = new Map<string, ChangeOp[]>();
  for (const op of todo) {
    const key = productKey(op.target.product);
    byProduct.set(key, [...(byProduct.get(key) ?? []), op]);
  }

  // 2. Read each product once and classify its ops
  const ready: ReadyItem[] = [];
  const states = new Map<string, ProductPriceState>();
  const offerReads = new Map<string, StoreOffer[]>();
  const failRead = (ops: ChangeOp[], error: unknown, what: string) => {
    const opError = toOpError(error);
    for (const op of ops) {
      update(records.get(op.id)!, { status: 'failed', finishedAt: now(), error: { ...opError, message: `Could not read current ${what}: ${opError.message}` } });
    }
    if (isBudgetError(opError)) stop(BUDGET_EXCEEDED);
  };
  for (const [key, productOps] of byProduct) {
    if (stopReason || budgetLow()) {
      stop(stopReason ?? BUDGET_EXCEEDED);
      break;
    }
    const priceOps = productOps.filter((op): op is BasePriceOp => !isOfferOp(op));
    const offerOps = productOps.filter(isOfferOp);

    // The product must belong to the plan's app before anything is read or written for it
    if (adapter.verifyProduct) {
      try {
        await adapter.verifyProduct(productOps[0].target.product);
      } catch (error) {
        const opError = toOpError(error);
        for (const op of productOps) update(records.get(op.id)!, { status: 'failed', finishedAt: now(), error: opError });
        if (isBudgetError(opError)) stop(BUDGET_EXCEEDED);
        await publish();
        continue;
      }
    }

    if (priceOps.length > 0) {
      let state: ProductPriceState | undefined;
      try {
        state = await adapter.fetchState(priceOps[0].target.product);
        states.set(key, state);
      } catch (error) {
        failRead(priceOps, error, 'prices');
      }
      if (state) {
        for (const op of priceOps) {
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
            ready.push({ offer: false, op, context: { territoryState: state.territories[op.target.territory] } });
          }
        }
      }
    }

    if (offerOps.length > 0 && !stopReason && !budgetLow()) {
      let offers: StoreOffer[] | undefined;
      try {
        offers = await adapter.fetchOffers!(offerOps[0].target.product);
        offerReads.set(key, offers);
      } catch (error) {
        failRead(offerOps, error, 'offers');
      }
      if (offers) {
        for (const op of offerOps) {
          const record = records.get(op.id)!;
          const result = classifyOfferOp(op, offers, today(), offerHistory(record));
          if (result.kind === 'atTarget') {
            // As for prices: an op found at its target after an attempt was sent took effect
            // (e.g. a create that answered 5xx); it is found by its key, never sent again
            update(record, {
              status: record.attempts > 0 ? 'ok' : 'skipped',
              ...(record.attempts > 0 ? { response: { ...(record.response ?? {}), confirmedOnResume: true } } : { skipReason: 'ALREADY_AT_TARGET' }),
              observedOffer: result.observed,
              finishedAt: now(),
            });
          } else if (result.kind === 'drifted') {
            update(record, { status: 'failed', observedOffer: result.observed, finishedAt: now(), error: { message: result.message, code: STATE_CHANGED, retryable: false } });
          } else if (op.kind === 'deleteOffer' && !options.force?.deleteOffers) {
            update(record, {
              status: 'failed',
              observedOffer: result.observed,
              finishedAt: now(),
              error: {
                message: `Not deleted: the store doesn't report whether anyone redeemed the ${offerKindLabel(op.target.offer.kind)} "${op.target.offer.key}". Apply with force.deleteOffers to delete it anyway.`,
                code: REDEMPTIONS_UNCHECKED,
                retryable: false,
              },
            });
          } else {
            update(record, { observedOffer: result.observed });
            ready.push({
              offer: true,
              op,
              context: {
                observed: result.observed,
                ...(result.offer ? { offer: result.offer } : {}),
                ...(result.pending ? { pending: result.pending } : {}),
                ...(result.storeRefs ? { storeRefs: result.storeRefs } : {}),
              },
            });
          }
        }
      }
    } else if (offerOps.length > 0) {
      stop(stopReason ?? BUDGET_EXCEEDED);
    }
    await publish();
  }

  // 3. Apply, in batches the adapter can write together (offer ops one at a time)
  const units: ReadyItem[][] = [];
  const batches = new Map<string, ReadyItem[]>();
  for (const item of ready) {
    const key = !item.offer && adapter.applyMany ? adapter.batchKey?.(item.op) : undefined;
    if (key === undefined) {
      units.push([item]);
    } else {
      if (!batches.has(key)) {
        const batch: ReadyItem[] = [];
        batches.set(key, batch);
        units.push(batch);
      }
      batches.get(key)!.push(item);
    }
  }

  const finish = (op: ChangeOp, outcome: { response?: OpResponse; error?: unknown }) => {
    const record = records.get(op.id)!;
    if (outcome.error !== undefined) {
      const opError = toOpError(outcome.error);
      // An op that wrote part of its work before failing (e.g. an intro offer created in some
      // territories) says what it wrote, so a resume and an undo know exactly
      const partial = partialResponse(outcome.error);
      update(record, { status: 'failed', finishedAt: now(), error: opError, ...(partial ? { response: mergeResponses(record.response, partial) } : {}) });
      if (isBudgetError(opError)) stop(BUDGET_EXCEEDED);
    } else {
      const warning = typeof outcome.response?.warning === 'string' ? outcome.response.warning : undefined;
      update(record, {
        status: 'ok',
        finishedAt: now(),
        ...(outcome.response ? { response: mergeResponses(record.response, outcome.response) } : {}),
        ...(warning ? { warning } : {}),
      });
    }
  };

  // Requests held back for units in flight, so two units can't both count on
  // the same remaining budget. Conservative: a unit's reservation is held
  // until it finishes even as its requests are spent.
  let reserved = 0;
  const requestsFor = (unit: ReadyItem[]): number => {
    const first = unit[0];
    if (first.offer) return adapter.offerRequestsNeeded ? adapter.offerRequestsNeeded(first.op, first.context) : 1;
    const priceUnit = unit as Array<Extract<ReadyItem, { offer: false }>>;
    return adapter.requestsNeeded ? adapter.requestsNeeded(priceUnit.map((u) => u.op), priceUnit.map((u) => u.context)) : unit.length;
  };

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

  async function runUnit(unit: ReadyItem[]): Promise<void> {
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
    const first = unit[0];
    if (first.offer) {
      try {
        finish(first.op, { response: await adapter.applyOffer!(first.op, first.context) });
      } catch (error) {
        finish(first.op, { error });
      }
    } else if (unit.length > 1 || (adapter.applyMany && adapter.batchKey?.(first.op) !== undefined)) {
      const priceUnit = unit as Array<Extract<ReadyItem, { offer: false }>>;
      let outcomes: Array<{ response?: OpResponse; error?: unknown }>;
      try {
        outcomes = await adapter.applyMany!(priceUnit.map((u) => u.op), priceUnit.map((u) => u.context));
      } catch (error) {
        outcomes = unit.map(() => ({ error }));
      }
      unit.forEach((u, i) => finish(u.op, outcomes[i] ?? { error: new Error('Adapter returned no outcome for this op') }));
    } else {
      try {
        finish(first.op, { response: await adapter.apply(first.op, first.context) });
      } catch (error) {
        finish(first.op, { error });
      }
    }
    await publish();
  }

  // 4. Optional read-back
  if (verify && !stopReason) {
    for (const [key, productOps] of byProduct) {
      const applied = productOps.filter((op) => records.get(op.id)!.status === 'ok');
      const priceOps = applied.filter((op): op is BasePriceOp => !isOfferOp(op));
      const offerOps = applied.filter(isOfferOp);
      try {
        if (priceOps.length > 0 && states.has(key)) {
          const after = await adapter.fetchState(priceOps[0].target.product);
          for (const op of priceOps) update(records.get(op.id)!, { verified: classifyOp(op, after).kind === 'atTarget' });
        }
        if (offerOps.length > 0 && offerReads.has(key)) {
          const after = await adapter.fetchOffers!(offerOps[0].target.product);
          for (const op of offerOps) update(records.get(op.id)!, { verified: classifyOfferOp(op, after, today(), offerHistory(records.get(op.id)!)).kind === 'atTarget' });
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

/** Intro resources an op's earlier attempts created, from its run record */
function offerHistory(record: OpRecord): { createdIds?: Record<string, string> } {
  const ids = record.response?.createdIds;
  return ids && typeof ids === 'object' ? { createdIds: ids as Record<string, string> } : {};
}

/** An error that carries what was written before it happened (`partialResponse`) */
function partialResponse(error: unknown): OpResponse | undefined {
  const partial = error && typeof error === 'object' ? (error as { partialResponse?: unknown }).partialResponse : undefined;
  return partial && typeof partial === 'object' ? (partial as OpResponse) : undefined;
}

/** A new response for a record, keeping resource IDs created by earlier attempts */
function mergeResponses(previous: OpResponse | undefined, next: OpResponse): OpResponse {
  const prevIds = previous?.createdIds;
  const nextIds = next.createdIds;
  if (!prevIds || typeof prevIds !== 'object') return next;
  return { ...next, createdIds: { ...(prevIds as Record<string, string>), ...((nextIds as Record<string, string> | undefined) ?? {}) } };
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
