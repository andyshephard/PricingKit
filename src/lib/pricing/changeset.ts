// The plan as a file.
//
// A ChangeSet is a reviewable JSON document listing every store change a run
// will make. Each op records the price it expects to find (`before`), the
// price it sets (`after`) and an idempotency key, so applying a ChangeSet is
// safe to repeat: an op whose target already holds `after` is skipped.

import { z } from 'zod';
import { normalizeDecimal } from './decimal';
import { canonicalJson, fnv1a64, priceValueSchema, productRefSchema, appRefSchema, territorySchema } from './refs';
import { checkOfferOpRules, describeOfferOp, isOfferOp, isOfferOpKind, offerOpSchema, offerTargetKey, type OfferOp, type OfferOpKind } from './offer-ops';
import {
  describePrice,
  productKey,
  type AppRef,
  type Platform,
  type PriceSlot,
  type PriceValue,
  type ProductRef,
} from './model';

export const CHANGESET_SCHEMA_VERSION = 1 as const;
export const CHANGESET_KIND = 'pricingkit.changeset' as const;

/** Base-price op kinds the Phase 1 executor applies */
export const BASE_PRICE_OP_KINDS = ['setPrice', 'schedulePrice', 'deleteScheduled', 'removePrice'] as const;
export type BasePriceOpKind = (typeof BASE_PRICE_OP_KINDS)[number];

/**
 * Reserved for later phases (availability, cohort migration). The format
 * names them so files stay forward compatible, but parseChangeSet refuses
 * them until an executor supports them.
 */
export const RESERVED_OP_KINDS = ['setAvailability', 'migrateCohort'] as const;
export type ReservedOpKind = (typeof RESERVED_OP_KINDS)[number];

export { OFFER_OP_KINDS, type OfferOp, type OfferOpKind } from './offer-ops';

export type ChangeOpKind = BasePriceOpKind | OfferOpKind | ReservedOpKind;

/**
 * setPrice        - change a territory's current price (Apple: immediate price; Google: regional price)
 * schedulePrice   - create or replace a territory's future price (Apple subscriptions)
 * deleteScheduled - delete a territory's future price (Apple subscriptions)
 * removePrice     - remove a territory's price configuration (Google only; used by undo)
 */
export interface BasePriceOp {
  /** Unique within the ChangeSet, e.g. "op-0001" */
  id: string;
  kind: BasePriceOpKind;
  platform: Platform;
  target: { product: ProductRef; territory: string };
  /** The price this op expects to find. null = no price in that slot. */
  before: PriceValue | null;
  /** The price this op sets. null for deleteScheduled and removePrice. */
  after: PriceValue | null;
  options?: {
    /** Apple: keep existing subscribers on their current price (default true) */
    preserveCurrentPrice?: boolean;
  };
  /** Same change -> same key; the executor and run log use it to detect repeats */
  idempotencyKey: string;
  /** Free-form context for reviewers (e.g. how far snapping moved the price) */
  note?: string;
}

/** Shape reserved for later op kinds. Not accepted by parseChangeSet. */
export interface ReservedOp {
  id: string;
  kind: ReservedOpKind;
  platform: Platform;
  target: { product: ProductRef; territory?: string };
  before: unknown;
  after: unknown;
  idempotencyKey: string;
  note?: string;
}

/** An op a ChangeSet can hold: a base-price op or an offer op */
export type ChangeOp = BasePriceOp | OfferOp;

/** An op before it is numbered (Omit that keeps each member of a union) */
export type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/** The base-price ops of a change set (offer ops left out) */
export function basePriceOps(changeSet: Pick<ChangeSet, 'ops'>): BasePriceOp[] {
  return changeSet.ops.filter((op): op is BasePriceOp => !isOfferOp(op));
}

/** A territory the planner looked at but produced no op for, and why */
export interface PlanSkip {
  product: ProductRef;
  territory: string;
  /** Set for skips while planning an offer */
  offerKey?: string;
  reason:
    | 'OFFER_CONFLICT'
    | 'ALREADY_AT_TARGET'
    | 'NOT_CONFIGURED'
    | 'CURRENCY_MISMATCH'
    | 'UNRESOLVED_PRICE_POINT'
    | 'NO_TARGET'
    | 'INVALID_TARGET'
    | 'AMBIGUOUS_STATE';
  detail?: string;
}

export interface ChangeSet {
  schemaVersion: typeof CHANGESET_SCHEMA_VERSION;
  kind: typeof CHANGESET_KIND;
  id: string;
  createdAt: string;
  description?: string;
  app: AppRef;
  /** Set on a ChangeSet generated to undo a run */
  undoOf?: { changeSetId: string; runId: string };
  /** Base-price ops and offer ops. The executor applies them in order of product, reading each product once. */
  ops: ChangeOp[];
  /** Planner notes only; the executor ignores them */
  skipped?: PlanSkip[];
  /** Ops an undo could not express, with the reason (e.g. Apple can't remove a current price) */
  notReversible?: Array<{ opId: string; reason: string }>;
  /** Things a reviewer should know about specific ops (e.g. a scheduled price that will still take effect) */
  warnings?: Array<{ opId: string; message: string }>;
}

export function opSlot(kind: BasePriceOpKind): PriceSlot {
  return kind === 'schedulePrice' || kind === 'deleteScheduled' ? 'scheduled' : 'current';
}

function valueKey(value: PriceValue | null): string {
  if (!value) return 'none';
  return [value.currency, normalizeDecimal(value.amount), value.pricePointId ?? '', value.startDate ?? ''].join(' ');
}

/**
 * Deterministic key for "this change": kind, product, territory and the end
 * state. Delete-style ops key on what they delete.
 */
export function computeIdempotencyKey(op: Pick<BasePriceOp, 'kind' | 'target' | 'before' | 'after'>): string {
  const subject = op.kind === 'deleteScheduled' || op.kind === 'removePrice' ? op.before : op.after;
  return [op.kind, productKey(op.target.product), op.target.territory, valueKey(subject)].join('|');
}

export function describeOp(op: ChangeOp): string {
  if (isOfferOp(op)) return describeOfferOp(op);
  return `${op.kind} ${productKey(op.target.product)} ${op.target.territory}: ${describePrice(op.before)} -> ${describePrice(op.after)}`;
}

/**
 * Hash of what a ChangeSet does (app + ops). Ignores id, createdAt,
 * description and planner notes, so re-serialising never changes it.
 */
export function changeSetHash(changeSet: Pick<ChangeSet, 'app' | 'ops'>): string {
  return fnv1a64(canonicalJson({ app: changeSet.app, ops: changeSet.ops }));
}

export { canonicalJson, fnv1a64, priceValueSchema, productRefSchema, appRefSchema } from './refs';

// ---------------------------------------------------------------------------
// Validation

const basePriceOpSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([...BASE_PRICE_OP_KINDS, ...RESERVED_OP_KINDS]),
    platform: z.enum(['apple', 'google']),
    target: z.object({ product: productRefSchema, territory: territorySchema }).strict(),
    before: priceValueSchema.nullable(),
    after: priceValueSchema.nullable(),
    options: z.object({ preserveCurrentPrice: z.boolean().optional() }).strict().optional(),
    idempotencyKey: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

// Offer ops are told apart by their kind; anything else is validated as a base-price op
// (a reserved kind passes the schema and is refused by checkChangeSetRules with a clear message)
const opSchema = z.unknown().transform((value, ctx) => {
  const kind = value && typeof value === 'object' ? (value as { kind?: unknown }).kind : undefined;
  const schema = typeof kind === 'string' && isOfferOpKind(kind) ? offerOpSchema : basePriceOpSchema;
  const result = schema.safeParse(value);
  if (result.success) return result.data as ChangeOp;
  for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path as Array<string | number> });
  return z.NEVER;
});

const skipSchema = z
  .object({
    product: productRefSchema,
    territory: z.string(),
    offerKey: z.string().optional(),
    reason: z.enum(['OFFER_CONFLICT', 'ALREADY_AT_TARGET', 'NOT_CONFIGURED', 'CURRENCY_MISMATCH', 'UNRESOLVED_PRICE_POINT', 'NO_TARGET', 'INVALID_TARGET', 'AMBIGUOUS_STATE']),
    detail: z.string().optional(),
  })
  .strict();

export const changeSetSchema = z
  .object({
    schemaVersion: z.literal(CHANGESET_SCHEMA_VERSION),
    kind: z.literal(CHANGESET_KIND),
    id: z.string().min(1),
    createdAt: z.string().min(1),
    description: z.string().optional(),
    app: appRefSchema,
    undoOf: z.object({ changeSetId: z.string(), runId: z.string() }).strict().optional(),
    ops: z.array(opSchema),
    skipped: z.array(skipSchema).optional(),
    notReversible: z.array(z.object({ opId: z.string(), reason: z.string() }).strict()).optional(),
    warnings: z.array(z.object({ opId: z.string(), message: z.string() }).strict()).optional(),
  })
  .strict();

export class ChangeSetValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid change set:\n- ${issues.join('\n- ')}`);
    this.name = 'ChangeSetValidationError';
  }
}

/** Rules the schema can't express. Returns problems; empty means valid. */
export function checkChangeSetRules(changeSet: ChangeSet): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const slots = new Set<string>();
  const appPlatform: Platform = 'bundleId' in changeSet.app ? 'apple' : 'google';

  for (const op of changeSet.ops as Array<ChangeOp | ReservedOp>) {
    const where = `op ${op.id}`;
    if (ids.has(op.id)) problems.push(`${where}: duplicate op id`);
    ids.add(op.id);

    if (isOfferOp(op)) {
      problems.push(...checkOfferOpRules(op, appPlatform));
      const slotKey = `offer|${offerTargetKey(op)}`;
      if (slots.has(slotKey)) problems.push(`${where}: another op already changes ${op.target.offer.kind} "${op.target.offer.key}"`);
      slots.add(slotKey);
      continue;
    }
    if ((RESERVED_OP_KINDS as readonly string[]).includes(op.kind)) {
      problems.push(`${where}: "${op.kind}" is reserved for a later phase and can't be applied yet`);
      continue;
    }
    const base = op as BasePriceOp;
    const { product, territory } = base.target;
    if (base.platform !== product.platform) problems.push(`${where}: platform ${base.platform} doesn't match its product (${product.platform})`);
    if (base.platform !== appPlatform) problems.push(`${where}: ${base.platform} op in a change set for a ${appPlatform} app`);

    const slot = opSlot(base.kind);
    const slotKey = `${productKey(product)}|${territory}|${slot}`;
    if (slots.has(slotKey)) problems.push(`${where}: another op already changes ${territory} ${slot} price of ${productKey(product)}`);
    slots.add(slotKey);

    const deletes = base.kind === 'deleteScheduled' || base.kind === 'removePrice';
    if (deletes && base.after !== null) problems.push(`${where}: ${base.kind} must have after: null`);
    if (deletes && base.before === null) problems.push(`${where}: ${base.kind} must say what it removes (before)`);
    if (!deletes && base.after === null) problems.push(`${where}: ${base.kind} needs an after price`);

    if (base.kind === 'removePrice' && base.platform !== 'google') problems.push(`${where}: removePrice is Google-only (Apple can't remove a current price)`);
    if ((base.kind === 'schedulePrice' || base.kind === 'deleteScheduled') && base.platform !== 'apple') {
      problems.push(`${where}: ${base.kind} is Apple-only`);
    }
    if (base.kind === 'schedulePrice' && !base.after?.startDate) problems.push(`${where}: schedulePrice needs after.startDate`);
    if (base.kind === 'setPrice' && base.after?.startDate) problems.push(`${where}: setPrice takes no startDate (use schedulePrice)`);
    if (base.platform === 'apple' && base.after && !base.after.pricePointId) {
      problems.push(`${where}: Apple prices must name a price point (after.pricePointId)`);
    }
    if (base.platform === 'apple' && product.type !== 'subscription') {
      problems.push(`${where}: Apple in-app purchase prices aren't supported by the plan executor yet`);
    }
    if (base.before && base.after && base.before.currency !== base.after.currency) {
      problems.push(`${where}: before and after currencies differ`);
    }
    const expectedKey = computeIdempotencyKey(base);
    if (base.idempotencyKey !== expectedKey) problems.push(`${where}: idempotencyKey doesn't match the op (expected "${expectedKey}")`);
  }
  return problems;
}

/** Parse and validate a ChangeSet from JSON text or a parsed object. */
export function parseChangeSet(input: string | unknown): ChangeSet {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      // JSON.parse messages quote the input, which may be anything (even a secret); never pass them on
      throw new ChangeSetValidationError(['not valid JSON']);
    }
  }
  const result = changeSetSchema.safeParse(raw);
  if (!result.success) {
    throw new ChangeSetValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    );
  }
  const changeSet = result.data as ChangeSet;
  const problems = checkChangeSetRules(changeSet);
  if (problems.length > 0) throw new ChangeSetValidationError(problems);
  return changeSet;
}

/** Stable, reviewable JSON (2-space indent, trailing newline) for committing to git. */
export function serializeChangeSet(changeSet: ChangeSet): string {
  return `${JSON.stringify(changeSet, null, 2)}\n`;
}
