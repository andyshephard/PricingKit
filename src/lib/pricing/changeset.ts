// The plan as a file.
//
// A ChangeSet is a reviewable JSON document listing every store change a run
// will make. Each op records the price it expects to find (`before`), the
// price it sets (`after`) and an idempotency key, so applying a ChangeSet is
// safe to repeat: an op whose target already holds `after` is skipped.

import { z } from 'zod';
import { isDecimalString, normalizeDecimal } from './decimal';
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
 * Reserved for later phases (offers in 2 and 3, availability and cohort
 * migration after that). The format names them so files stay forward
 * compatible, but parseChangeSet refuses them until an executor supports them.
 */
export const RESERVED_OP_KINDS = [
  'createOffer',
  'updateOfferPrices',
  'deactivateOffer',
  'deleteOffer',
  'setAvailability',
  'migrateCohort',
] as const;
export type ReservedOpKind = (typeof RESERVED_OP_KINDS)[number];

export type ChangeOpKind = BasePriceOpKind | ReservedOpKind;

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

/** Shape reserved for offer ops (Phases 2-3). Not accepted by parseChangeSet yet. */
export interface ReservedOp {
  id: string;
  kind: ReservedOpKind;
  platform: Platform;
  target: { product: ProductRef; offerId?: string; territory?: string };
  before: unknown;
  after: unknown;
  idempotencyKey: string;
  note?: string;
}

export type ChangeOp = BasePriceOp | ReservedOp;

/** A territory the planner looked at but produced no op for, and why */
export interface PlanSkip {
  product: ProductRef;
  territory: string;
  reason:
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
  ops: BasePriceOp[];
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

export function describeOp(op: BasePriceOp): string {
  return `${op.kind} ${productKey(op.target.product)} ${op.target.territory}: ${describePrice(op.before)} -> ${describePrice(op.after)}`;
}

// ---------------------------------------------------------------------------
// Canonical JSON and hashing

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** JSON with sorted keys and no undefined fields */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const FNV_OFFSET = BigInt('0xcbf29ce484222325');
const FNV_PRIME = BigInt('0x100000001b3');
const MASK_64 = BigInt('0xffffffffffffffff');

/** FNV-1a 64-bit of a UTF-8 string, as 16 hex digits. Not a security hash. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Hash of what a ChangeSet does (app + ops). Ignores id, createdAt,
 * description and planner notes, so re-serialising never changes it.
 */
export function changeSetHash(changeSet: Pick<ChangeSet, 'app' | 'ops'>): string {
  return fnv1a64(canonicalJson({ app: changeSet.app, ops: changeSet.ops }));
}

// ---------------------------------------------------------------------------
// Validation

const decimalSchema = z
  .string()
  .refine((v) => isDecimalString(v), { message: 'must be a plain decimal string such as "4.99"' })
  .transform((v) => normalizeDecimal(v));

const territorySchema = z.string().regex(/^[A-Z]{2}$/, 'territory must be ISO 3166-1 alpha-2, e.g. "GB"');
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'currency must be ISO 4217, e.g. "EUR"');

export const priceValueSchema = z
  .object({
    currency: currencySchema,
    amount: decimalSchema,
    pricePointId: z.string().min(1).optional(),
    proceeds: decimalSchema.optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be a date, YYYY-MM-DD').optional(),
  })
  .strict();

export const productRefSchema = z.union([
  z.object({ platform: z.literal('apple'), type: z.enum(['subscription', 'inapp']), id: z.string().min(1), productId: z.string().min(1).optional() }).strict(),
  z.object({ platform: z.literal('google'), type: z.literal('subscription'), productId: z.string().min(1), basePlanId: z.string().min(1) }).strict(),
  z.object({ platform: z.literal('google'), type: z.literal('inapp'), productId: z.string().min(1), purchaseOptionId: z.string().min(1).optional() }).strict(),
]);

export const appRefSchema = z.union([
  z.object({ packageName: z.string().min(1) }).strict(),
  z.object({ bundleId: z.string().min(1) }).strict(),
]);

const opSchema = z
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

const skipSchema = z
  .object({
    product: productRefSchema,
    territory: z.string(),
    reason: z.enum(['ALREADY_AT_TARGET', 'NOT_CONFIGURED', 'CURRENCY_MISMATCH', 'UNRESOLVED_PRICE_POINT', 'NO_TARGET', 'INVALID_TARGET', 'AMBIGUOUS_STATE']),
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

  for (const op of changeSet.ops as ChangeOp[]) {
    const where = `op ${op.id}`;
    if (ids.has(op.id)) problems.push(`${where}: duplicate op id`);
    ids.add(op.id);

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
    } catch (error) {
      throw new ChangeSetValidationError([`not valid JSON: ${(error as Error).message}`]);
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
