// The ApplyRun log: what happened to every op of a ChangeSet.
//
// A run is plain JSON. Save it after every update (the executor's onUpdate
// callback) and it can be resumed after a crash or a partial failure, and
// undone from the `before` snapshots of the ops it changed.

import { z } from 'zod';
import {
  CHANGESET_KIND,
  CHANGESET_SCHEMA_VERSION,
  changeSetHash,
  checkChangeSetRules,
  ChangeSetValidationError,
  type BasePriceOp,
  type ChangeOp,
  type ChangeSet,
  type WithoutId,
} from './changeset';
import { numberOps } from './diff';
import { invertOp } from './inverse';
import { anyOfferStateSchema, invertOfferOp, isOfferOp, type AnyOfferState } from './offer-ops';
import { appRefSchema, confirmHashSchema, priceValueSchema } from './changeset';
import type { AppRef, PriceValue } from './model';

export const RUN_SCHEMA_VERSION = 1 as const;
export const RUN_KIND = 'pricingkit.applyRun' as const;

/**
 * pending - not attempted yet (or the run stopped before reaching it)
 * ok      - applied by this run
 * skipped - already at its target when the run checked; nothing sent
 * failed  - not applied: the store refused, the territory changed since the
 *           plan was made, or the request failed. Resuming retries it.
 */
export type OpStatus = 'pending' | 'ok' | 'skipped' | 'failed';

export interface OpError {
  message: string;
  status?: number;
  code?: string | number;
  retryable?: boolean;
  /** Requests the store client sent for this attempt (more than 1: it retried) */
  clientAttempts?: number;
}

export interface OpRecord {
  opId: string;
  idempotencyKey: string;
  status: OpStatus;
  /** How many times this run tried to apply the op */
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  /** Why an op was skipped, e.g. ALREADY_AT_TARGET */
  skipReason?: string;
  error?: OpError;
  /** What the store did (adapter-specific, JSON-safe) */
  response?: Record<string, unknown>;
  /** The price found in the territory right before the op was applied or skipped */
  observed?: PriceValue | null;
  /** Offer ops: the offer found right before the op was applied or skipped */
  observedOffer?: AnyOfferState | null;
  /** Set when the run re-read the store after applying (verify option) */
  verified?: boolean;
  /** The op was applied but something needs attention (from the adapter's response) */
  warning?: string;
}

export type RunStatus = 'running' | 'completed' | 'incomplete';

export interface ApplyRun {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  kind: typeof RUN_KIND;
  id: string;
  changeSetId: string;
  /** changeSetHash() of the plan this run applies; a run only resumes the same plan */
  changeSetHash: string;
  app: AppRef;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  status: RunStatus;
  /** Number of times the executor has worked on this run (1 + resumes) */
  passes: number;
  /** Why the last pass stopped early, e.g. BUDGET_EXCEEDED */
  stoppedReason?: string;
  /** Human-readable detail for stoppedReason */
  stoppedDetail?: string;
  ops: OpRecord[];
}

export function createRun(changeSet: ChangeSet, options: { id?: string; now?: string } = {}): ApplyRun {
  const now = options.now ?? new Date().toISOString();
  const hash = changeSetHash(changeSet);
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    kind: RUN_KIND,
    id: options.id ?? `run-${now.replace(/[^0-9]/g, '').slice(0, 14)}-${hash.slice(0, 8)}`,
    changeSetId: changeSet.id,
    changeSetHash: hash,
    app: changeSet.app,
    startedAt: now,
    updatedAt: now,
    status: 'running',
    passes: 0,
    ops: changeSet.ops.map((op) => ({ opId: op.id, idempotencyKey: op.idempotencyKey, status: 'pending', attempts: 0 })),
  };
}

export function summarizeRun(run: ApplyRun): Record<OpStatus, number> {
  const counts: Record<OpStatus, number> = { pending: 0, ok: 0, skipped: 0, failed: 0 };
  for (const record of run.ops) counts[record.status]++;
  return counts;
}

export function serializeRun(run: ApplyRun): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

const opRecordSchema = z
  .object({
    opId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    status: z.enum(['pending', 'ok', 'skipped', 'failed']),
    attempts: z.number().int().min(0),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    skipReason: z.string().optional(),
    error: z
      .object({
        message: z.string(),
        status: z.number().optional(),
        code: z.union([z.string(), z.number()]).optional(),
        retryable: z.boolean().optional(),
        clientAttempts: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    response: z.record(z.string(), z.unknown()).optional(),
    observed: priceValueSchema.nullable().optional(),
    observedOffer: anyOfferStateSchema.nullable().optional(),
    verified: z.boolean().optional(),
    warning: z.string().optional(),
  })
  .strict();

const runSchema = z
  .object({
    schemaVersion: z.literal(RUN_SCHEMA_VERSION),
    kind: z.literal(RUN_KIND),
    id: z.string().min(1),
    changeSetId: z.string().min(1),
    changeSetHash: confirmHashSchema,
    app: appRefSchema,
    startedAt: z.string(),
    updatedAt: z.string(),
    finishedAt: z.string().optional(),
    status: z.enum(['running', 'completed', 'incomplete']),
    passes: z.number().int().min(0),
    stoppedReason: z.string().optional(),
    stoppedDetail: z.string().optional(),
    ops: z.array(opRecordSchema),
  })
  .strict();

export class RunValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid apply run:\n- ${issues.join('\n- ')}`);
    this.name = 'RunValidationError';
  }
}

export function parseRun(input: string | unknown): ApplyRun {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      // JSON.parse messages quote the input, which may be anything (even a secret); never pass them on
      throw new RunValidationError(['not valid JSON']);
    }
  }
  const result = runSchema.safeParse(raw);
  if (!result.success) {
    throw new RunValidationError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data as ApplyRun;
}

/** Throws unless `run` is a run of exactly this ChangeSet. */
export function assertRunMatches(changeSet: ChangeSet, run: ApplyRun): void {
  const problems: string[] = [];
  if (run.changeSetHash !== changeSetHash(changeSet)) {
    problems.push(`run ${run.id} belongs to a different plan (hash ${run.changeSetHash}, plan hash ${changeSetHash(changeSet)})`);
  }
  const ids = changeSet.ops.map((op) => `${op.id}=${op.idempotencyKey}`).join(',');
  const recorded = run.ops.map((r) => `${r.opId}=${r.idempotencyKey}`).join(',');
  if (ids !== recorded) problems.push(`run ${run.id} ops don't match the plan's ops`);
  if (problems.length > 0) throw new RunValidationError(problems);
}

/**
 * Build a ChangeSet that undoes every change `run` made, from the ops'
 * `before` snapshots. Only ops the run applied (status ok) are reversed,
 * newest first; skipped ops changed nothing. Offer ops that failed after a
 * request was sent are reversed too, because they may have taken effect (a
 * create that answered 5xx, or an intro offer created in some territories),
 * except ones the store refused with a 4xx and nothing recorded as written.
 * Intro creates are undone only for the resources the run recorded creating.
 * Dependencies are reversed: where an offer op depended on base-price ops
 * (a sync plan), the base-price reverts depend on the offer's revert, so
 * offers are reverted first and a base price is not reverted under an offer
 * whose revert failed.
 * The undo op is judged against the store like any other, so a part that
 * never happened is simply skipped. The result is an ordinary plan: review
 * it, then apply it like any other (it is idempotent too).
 */
export function buildUndoChangeSet(
  changeSet: ChangeSet,
  run: ApplyRun,
  options: { createdAt?: string; description?: string } = {}
): ChangeSet {
  assertRunMatches(changeSet, run);
  const byId = new Map(changeSet.ops.map((op) => [op.id, op]));
  const inverses: Array<WithoutId<ChangeOp>> = [];
  /** Original op ID -> index of its inverse in `inverses` */
  const inverseOf = new Map<string, number>();
  const notReversible: Array<{ opId: string; reason: string }> = [];
  const caveats: Array<{ index: number; message: string }> = [];

  for (const record of [...run.ops].reverse()) {
    const op = byId.get(record.opId)!;
    const createdIds = record.response?.createdIds as Record<string, string> | undefined;
    // A failed offer op may still have taken effect (a create that answered 5xx or timed out).
    // It is left out only when its one and only attempt was refused (4xx) with nothing recorded as
    // written: after a timeout, a later 409 may mean the first attempt took effect.
    // Something recorded as (possibly) written is never "refused": intro resources created, or a Play
    // create that was sent (it may have applied whatever the answer). Nor is a 4xx that followed
    // client-side retries (an earlier request may have taken effect).
    const wrote = Boolean(createdIds) || record.response?.created === true || record.response?.createSent === true;
    const clientRetried = (record.error?.clientAttempts ?? 1) > 1;
    const refused =
      record.attempts === 1 && record.error?.status !== undefined && record.error.status >= 400 && record.error.status < 500 && !wrote && !clientRetried;
    // Base-price ops too: an Apple create that answered 5xx may have taken effect. Their inverse is
    // safe either way: if the op never applied, the store is at the inverse's target and it is skipped.
    const failedButSent = record.status === 'failed' && record.attempts > 0 && !refused;
    const mayHaveApplied = record.status === 'ok' || failedButSent;
    if (!mayHaveApplied) continue;
    if (isOfferOp(op)) {
      const inverse = invertOfferOp(op, { ...(createdIds ? { createdIds } : {}), failed: record.status === 'failed', ...(record.response ? { response: record.response } : {}) });
      if (inverse.notReversible) notReversible.push({ opId: op.id, reason: inverse.notReversible });
      if (inverse.op) {
        if (inverse.caveat) {
          caveats.push({ index: inverses.length, message: inverse.caveat });
          notReversible.push({ opId: op.id, reason: `Partly: ${inverse.caveat}` });
        }
        inverseOf.set(op.id, inverses.length);
        inverses.push(inverse.op);
      }
      continue;
    }
    const inverse = invertOp(op as BasePriceOp);
    if ('notReversible' in inverse) notReversible.push({ opId: op.id, reason: record.status === 'failed' ? `If it took effect: ${inverse.notReversible}` : inverse.notReversible });
    else {
      inverseOf.set(op.id, inverses.length);
      inverses.push(inverse.op);
    }
  }

  const ops = numberOps<ChangeOp>(inverses);
  // X depended on Y -> undo(Y) depends on undo(X)
  for (const op of changeSet.ops) {
    const from = inverseOf.get(op.id);
    if (from === undefined) continue;
    for (const dep of op.dependsOn ?? []) {
      const to = inverseOf.get(dep);
      if (to === undefined) continue;
      const target = ops[to];
      target.dependsOn = [...new Set([...(target.dependsOn ?? []), ops[from].id])].sort();
    }
  }
  const createdAt = options.createdAt ?? new Date().toISOString();
  const undo: ChangeSet = {
    schemaVersion: CHANGESET_SCHEMA_VERSION,
    kind: CHANGESET_KIND,
    id: `undo-${run.id}`,
    createdAt,
    description: options.description ?? `Undo run ${run.id} of ${changeSet.id}`,
    app: changeSet.app,
    undoOf: { changeSetId: changeSet.id, runId: run.id },
    ops,
    ...(notReversible.length > 0 ? { notReversible } : {}),
    ...(caveats.length > 0 ? { warnings: caveats.map((c) => ({ opId: ops[c.index].id, message: c.message })) } : {}),
  };
  const problems = checkChangeSetRules(undo);
  if (problems.length > 0) throw new ChangeSetValidationError(problems);
  return undo;
}
