// Diff: current state + target prices -> the ops that get from one to the other.
// Territories already at their target produce no op (they're listed as skipped).

import {
  CHANGESET_KIND,
  CHANGESET_SCHEMA_VERSION,
  changeSetHash,
  checkChangeSetRules,
  ChangeSetValidationError,
  computeIdempotencyKey,
  type BasePriceOp,
  type ChangeSet,
  type PlanSkip,
} from './changeset';
import { isDecimalString, isNegativeDecimal, normalizeDecimal } from './decimal';
import { samePrice, type AppRef, type PriceValue, type ProductPriceState } from './model';

export interface TargetPrice {
  currency: string;
  amount: string;
  /** Required on Apple: the resolved (snapped) price point */
  pricePointId?: string;
  proceeds?: string;
  /** Set to schedule the price for a future date instead of changing it now (Apple) */
  startDate?: string;
  /** Carried into the op's note, e.g. the unsnapped target */
  note?: string;
}

export interface DiffOptions {
  /** Allow ops for territories that have no current price (default false: never launch a territory nobody chose) */
  allowNewTerritories?: boolean;
  /** Apple: preserve existing subscribers' prices (default true) */
  preserveCurrentPrice?: boolean;
}

export interface DiffResult {
  ops: Omit<BasePriceOp, 'id'>[];
  skipped: PlanSkip[];
}

/** Compute the ops that move one product from `state` to `targets` (keyed by alpha-2). */
export function diffPrices(
  state: ProductPriceState,
  targets: Record<string, TargetPrice>,
  options: DiffOptions = {}
): DiffResult {
  const { product } = state;
  const platform = product.platform;
  const ops: Omit<BasePriceOp, 'id'>[] = [];
  const skipped: PlanSkip[] = [];
  const skip = (territory: string, reason: PlanSkip['reason'], detail?: string) =>
    skipped.push({ product, territory, reason, ...(detail ? { detail } : {}) });

  for (const territory of Object.keys(targets).sort()) {
    const target = targets[territory];
    if (!isDecimalString(target.amount) || isNegativeDecimal(target.amount)) {
      skip(territory, 'INVALID_TARGET', `amount ${JSON.stringify(target.amount)} is not a non-negative decimal string`);
      continue;
    }
    const after: PriceValue = {
      currency: target.currency,
      amount: normalizeDecimal(target.amount),
      ...(target.pricePointId ? { pricePointId: target.pricePointId } : {}),
      ...(target.proceeds ? { proceeds: normalizeDecimal(target.proceeds) } : {}),
      ...(target.startDate ? { startDate: target.startDate } : {}),
    };
    const current = state.territories[territory];

    if (platform === 'apple' && !after.pricePointId) {
      skip(territory, 'UNRESOLVED_PRICE_POINT', 'no Apple price point was resolved for this target');
      continue;
    }
    if (current && current.currency && current.currency !== after.currency) {
      skip(territory, 'CURRENCY_MISMATCH', `territory is priced in ${current.currency}, target is ${after.currency}`);
      continue;
    }

    const scheduling = Boolean(after.startDate);
    const slot = scheduling ? 'scheduled' : 'current';
    const before = (scheduling ? current?.scheduled : current?.current) ?? null;

    if (!scheduling && !current?.current && !options.allowNewTerritories) {
      skip(territory, 'NOT_CONFIGURED', 'territory has no current price; set allowNewTerritories to add one');
      continue;
    }
    if (samePrice(platform, before, after, slot)) {
      skip(territory, 'ALREADY_AT_TARGET');
      continue;
    }

    const op: Omit<BasePriceOp, 'id' | 'idempotencyKey'> = {
      kind: scheduling ? 'schedulePrice' : 'setPrice',
      platform,
      target: { product, territory },
      before,
      after,
      ...(platform === 'apple' ? { options: { preserveCurrentPrice: options.preserveCurrentPrice ?? true } } : {}),
      ...(target.note ? { note: target.note } : {}),
    };
    ops.push({ ...op, idempotencyKey: computeIdempotencyKey(op) });
  }
  return { ops, skipped };
}

export interface BuildChangeSetInput {
  app: AppRef;
  description?: string;
  products: Array<{ state: ProductPriceState; targets: Record<string, TargetPrice>; options?: DiffOptions }>;
  /** Defaults to now */
  createdAt?: string;
}

/** Number ops "op-0001", "op-0002", ... in order. */
export function numberOps(ops: Omit<BasePriceOp, 'id'>[]): BasePriceOp[] {
  return ops.map((op, index) => ({ id: `op-${String(index + 1).padStart(4, '0')}`, ...op }));
}

/** Diff every product and wrap the ops in a validated ChangeSet. */
export function buildChangeSet(input: BuildChangeSetInput): ChangeSet {
  const allOps: Omit<BasePriceOp, 'id'>[] = [];
  const skipped: PlanSkip[] = [];
  for (const { state, targets, options } of input.products) {
    const result = diffPrices(state, targets, options);
    allOps.push(...result.ops);
    skipped.push(...result.skipped);
  }
  const ops = numberOps(allOps);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const changeSet: ChangeSet = {
    schemaVersion: CHANGESET_SCHEMA_VERSION,
    kind: CHANGESET_KIND,
    id: `cs-${createdAt.replace(/[^0-9]/g, '').slice(0, 14)}-${changeSetHash({ app: input.app, ops }).slice(0, 8)}`,
    createdAt,
    ...(input.description ? { description: input.description } : {}),
    app: input.app,
    ops,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
  const problems = checkChangeSetRules(changeSet);
  if (problems.length > 0) throw new ChangeSetValidationError(problems);
  return changeSet;
}
