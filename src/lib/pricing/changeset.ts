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
import { OFFER_KINDS, type OfferKind } from './offers';
import type { PlayOfferOp } from './play-offers';
import type { PriceChangeNote } from './price-notes';
import { PLAY_MIGRATION_CLASSES, PRICE_CHANGE_CLASSES } from './price-increase';
import { REFERENCE_DATA_IDS, type FreshnessEntry } from './freshness';
import {
  describePrice,
  productKey,
  type AppRef,
  type Platform,
  type PriceSlot,
  type PriceValue,
  type ProductRef,
} from './model';

/**
 * Version written by this build. 2 adds the planner notes priceChanges and
 * dataFreshness (Phase 8); everything else is as in 1. The plan hash covers
 * app + ops only, so a v1 plan keeps its hash when read by this build.
 */
export const CHANGESET_SCHEMA_VERSION = 2 as const;
/** Versions this build reads */
export const CHANGESET_SCHEMA_VERSIONS_READ = [1, 2] as const;
export type ChangeSetSchemaVersion = (typeof CHANGESET_SCHEMA_VERSIONS_READ)[number];
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

export { OFFER_OP_KINDS, type AnyOfferOp, type OfferOp, type OfferOpKind } from './offer-ops';

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
    /** Google Play: the regionsVersion.version the edit sends (planned, so it is reviewed) */
    regionsVersion?: string;
  };
  /** Same change -> same key; the executor and run log use it to detect repeats */
  idempotencyKey: string;
  /** Free-form context for reviewers (e.g. how far snapping moved the price) */
  note?: string;
  /**
   * Offer ops (IDs in the same ChangeSet) this op waits for. Set in undo
   * plans of sync runs: a base price is reverted only after the offers that
   * were derived from it are, and not at all if reverting them failed.
   */
  dependsOn?: string[];
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
export type ChangeOp = BasePriceOp | OfferOp | PlayOfferOp;

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
    | 'AMBIGUOUS_STATE'
    /** Play percentOfCurrent: Play's price is further from the target than the deviation threshold */
    | 'DEVIATION_ABOVE_THRESHOLD'
    /** Strategy targets: the reference data (e.g. PPP) is older than the spec allows and can't be adjusted */
    | 'STALE_REFERENCE_DATA';
  detail?: string;
}

/**
 * Why an offer needs a person rather than an op (sync plans):
 * PRICES_IMMUTABLE    - the rule gives new prices, but the store can't re-price this kind of offer
 *                       (offer codes, win-back and introductory offers); the planner never deletes or
 *                       re-creates an offer by itself
 * OFFER_NOT_FOUND     - the rules file names an offer the product doesn't have (sync never creates offers)
 * OFFER_UNREADABLE    - the offer can't be read unambiguously (two offers share the key, a price without
 *                       a price point, an unknown mode or duration)
 * RULE_NOT_APPLICABLE - the rule can't price this offer (a free trial, weeks against months, ...)
 * BASE_SCHEDULED      - the plan schedules the base price change for a later date; held by default
 *                       because offer prices change as soon as they are applied
 */
export const MANUAL_ACTION_CODES = ['PRICES_IMMUTABLE', 'OFFER_NOT_FOUND', 'OFFER_UNREADABLE', 'RULE_NOT_APPLICABLE', 'BASE_SCHEDULED'] as const;
export type ManualActionCode = (typeof MANUAL_ACTION_CODES)[number];

/** An offer the planner looked at but can't change itself, and what to do instead */
export interface ManualAction {
  product: ProductRef;
  offer: { kind: OfferKind; key: string };
  code: ManualActionCode;
  message: string;
  /** Territories concerned, when it's about some of them */
  territories?: string[];
}

export interface ChangeSet {
  schemaVersion: ChangeSetSchemaVersion;
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
  /** Planner notes only (sync plans): offers that need a person, with the reason. The executor ignores them. */
  manualActions?: ManualAction[];
  /**
   * Planner notes only (base-price plans): per op, what existing subscribers
   * see (decrease, increase within the no-consent limits, needs consent, new
   * subscribers only), and proceeds and tax. The executor ignores them.
   */
  priceChanges?: PriceChangeNote[];
  /** Planner notes only: the reference data the plan's targets were derived from, and how old it is */
  dataFreshness?: FreshnessEntry[];
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
    options: z.object({ preserveCurrentPrice: z.boolean().optional(), regionsVersion: z.string().min(1).max(40).optional() }).strict().optional(),
    idempotencyKey: z.string().min(1),
    note: z.string().optional(),
    dependsOn: z.array(z.string().min(1)).min(1).optional(),
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
    reason: z.enum(['OFFER_CONFLICT', 'ALREADY_AT_TARGET', 'NOT_CONFIGURED', 'CURRENCY_MISMATCH', 'UNRESOLVED_PRICE_POINT', 'NO_TARGET', 'INVALID_TARGET', 'AMBIGUOUS_STATE', 'DEVIATION_ABOVE_THRESHOLD', 'STALE_REFERENCE_DATA']),
    detail: z.string().optional(),
  })
  .strict();

export const changeSetSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
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
    manualActions: z
      .array(
        z
          .object({
            product: productRefSchema,
            offer: z.object({ kind: z.enum(OFFER_KINDS), key: z.string().min(1) }).strict(),
            code: z.enum(MANUAL_ACTION_CODES),
            message: z.string(),
            territories: z.array(territorySchema).optional(),
          })
          .strict()
      )
      .optional(),
    priceChanges: z
      .array(
        z
          .object({
            opId: z.string(),
            territory: territorySchema,
            classification: z.enum(PRICE_CHANGE_CLASSES),
            direction: z.enum(['increase', 'decrease', 'none', 'new']),
            percent: z.string().optional(),
            reasons: z.array(z.string()),
            assumptions: z.array(z.string()).optional(),
            ifMigrated: z.enum(PLAY_MIGRATION_CLASSES).optional(),
            proceeds: z
              .object({ before: z.string().optional(), after: z.string().optional(), estimated: z.boolean().optional(), commission: z.string().optional() })
              .strict()
              .optional(),
            tax: z.string().optional(),
            target: z.object({ measure: z.enum(['customerPrice', 'proceeds']), amount: z.string() }).strict().optional(),
            inputs: z
              .object({ effectiveDate: z.string(), billingPeriod: z.string().optional(), lastIncreaseAt: z.string().optional(), usdRate: z.string().optional() })
              .strict()
              .optional(),
          })
          .strict()
      )
      .optional(),
    dataFreshness: z
      .array(
        z
          .object({
            id: z.enum(REFERENCE_DATA_IDS),
            label: z.string(),
            asOf: z.string().optional(),
            ageDays: z.number().optional(),
            maxAgeDays: z.number(),
            stale: z.boolean(),
            message: z.string(),
          })
          .strict()
      )
      .optional(),
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
  const byId = new Map(changeSet.ops.map((op) => [op.id, op]));

  for (const op of changeSet.ops as Array<ChangeOp | ReservedOp>) {
    const where = `op ${op.id}`;
    if (ids.has(op.id)) problems.push(`${where}: duplicate op id`);
    ids.add(op.id);

    // dependsOn links a base-price op and an offer op of the same product, one level deep (so no
    // cycles): sync plans make offer ops wait for base ops, their undo plans the other way round
    const deps = (op as { dependsOn?: string[] }).dependsOn ?? [];
    if (new Set(deps).size !== deps.length) problems.push(`${where}: dependsOn lists an op twice`);
    for (const dep of deps) {
      const target = byId.get(dep);
      if (!target) problems.push(`${where}: dependsOn names ${dep}, which isn't in the plan`);
      else if (isOfferOp(target) === isOfferOp(op)) {
        problems.push(`${where}: dependsOn names ${dep}; an offer op can depend only on base-price ops and a base-price op only on offer ops`);
      } else if (productKey(target.target.product) !== productKey(op.target.product)) problems.push(`${where}: dependsOn names ${dep}, an op on another product`);
      else if ((target as { dependsOn?: string[] }).dependsOn?.length) problems.push(`${where}: dependsOn names ${dep}, which itself depends on other ops`);
    }

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

    if (base.options?.regionsVersion && base.platform !== 'google') problems.push(`${where}: options.regionsVersion is Google Play-only`);
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
  // A plan from a newer PricingKit may hold things this build can't check: say so plainly
  const version = raw && typeof raw === 'object' ? (raw as { kind?: unknown; schemaVersion?: unknown }) : undefined;
  if (version?.kind === CHANGESET_KIND && typeof version.schemaVersion === 'number' && version.schemaVersion > CHANGESET_SCHEMA_VERSION) {
    throw new ChangeSetValidationError([
      `schemaVersion ${version.schemaVersion}: this plan was written by a newer PricingKit (this one reads versions ${CHANGESET_SCHEMA_VERSIONS_READ.join(' and ')}); upgrade PricingKit`,
    ]);
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
