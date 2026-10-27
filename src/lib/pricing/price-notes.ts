// Planner notes per base-price op: what existing subscribers see
// (price-increase.ts), proceeds and tax. They ride in ChangeSet.priceChanges,
// which the executor ignores and the plan hash doesn't cover.

import type { ResolvedPrice, TargetMeasure } from './adapter';
import type { BasePriceOp } from './changeset';
import { DEFAULT_PLAY_COMMISSION } from './adapter';
import { productKey, type ProductPriceState } from './model';
import { classifyPriceChange, type ConsentContext, type PlayMigrationClass, type PriceChangeClass } from './price-increase';
import type { Decimal } from './decimal';

export interface PriceChangeNote {
  opId: string;
  territory: string;
  classification: PriceChangeClass;
  direction: 'increase' | 'decrease' | 'none' | 'new';
  /** Signed percent against the current price, 2 decimals */
  percent?: Decimal;
  reasons: string[];
  assumptions?: string[];
  /** Google Play: what migrating the legacy cohort to this price would need */
  ifMigrated?: PlayMigrationClass;
  /** Developer proceeds before and after. Apple: from the price points; Google Play: estimated (after only). */
  proceeds?: { before?: Decimal; after?: Decimal; estimated?: boolean; commission?: Decimal };
  /** Google Play: tax included in the new price (from Play's price conversion) */
  tax?: Decimal;
  /** The spec targeted proceeds: the amount asked for */
  target?: { measure: TargetMeasure; amount: Decimal };
  /**
   * The classification's inputs that aren't in the op, so a reviewer
   * (pricingkit diff) can recompute it from the op: effective date, billing
   * period, last increase and the currency's rate per USD.
   */
  inputs?: { effectiveDate: string; billingPeriod?: string; lastIncreaseAt?: string; usdRate?: Decimal };
}

/** The consent context a note's inputs describe, for recomputing its classification */
export function noteConsentContext(note: Pick<PriceChangeNote, 'inputs'>, currency: string): ConsentContext {
  const i = note.inputs;
  return {
    ...(i?.billingPeriod ? { billingPeriod: i.billingPeriod } : {}),
    ...(i?.lastIncreaseAt ? { lastIncreaseAt: i.lastIncreaseAt } : {}),
    ...(i?.usdRate ? { exchangeRates: { [currency]: i.usdRate } } : {}),
  };
}

export interface PriceNoteProductInput {
  state: ProductPriceState;
  consent?: ConsentContext;
  measure?: TargetMeasure;
  commission?: Decimal;
  /** The adapter's resolve results, per territory (tax, proceeds, target) */
  resolved?: Record<string, ResolvedPrice>;
}

/** Notes for every setPrice / schedulePrice op. `createdAt` dates an immediate change. */
export function priceChangeNotes(ops: BasePriceOp[], products: PriceNoteProductInput[], createdAt: string): PriceChangeNote[] {
  const byKey = new Map(products.map((p) => [productKey(p.state.product), p]));
  const notes: PriceChangeNote[] = [];
  for (const op of ops) {
    if ((op.kind !== 'setPrice' && op.kind !== 'schedulePrice') || !op.after) continue;
    const input = byKey.get(productKey(op.target.product));
    if (!input) continue;
    const territory = op.target.territory;
    const current = input.state.territories[territory]?.current ?? null;
    const effectiveDate = op.after.startDate ?? createdAt.slice(0, 10);
    const last = input.consent?.lastIncreaseAt;
    const lastIncreaseAt = typeof last === 'string' ? last : last?.[territory];
    const usdRate = input.consent?.exchangeRates?.[op.after.currency];
    const c = classifyPriceChange({
      platform: op.platform,
      productType: op.target.product.type,
      territory,
      current,
      after: op.after,
      effectiveDate,
      ...(op.options?.preserveCurrentPrice !== undefined ? { preserveCurrentPrice: op.options.preserveCurrentPrice } : {}),
      ...(input.consent ? { context: input.consent } : {}),
    });
    const resolved = input.resolved?.[territory];
    const estimated = Boolean(resolved?.proceedsEstimated);
    const proceedsAfter = op.after.proceeds ?? resolved?.proceeds;
    const proceedsBefore = op.platform === 'apple' ? current?.proceeds : undefined;
    notes.push({
      opId: op.id,
      territory,
      classification: c.classification,
      direction: c.direction,
      ...(c.percent !== undefined ? { percent: c.percent } : {}),
      reasons: c.reasons,
      ...(c.assumptions.length > 0 ? { assumptions: c.assumptions } : {}),
      ...(c.ifMigrated ? { ifMigrated: c.ifMigrated } : {}),
      ...(proceedsAfter !== undefined || proceedsBefore !== undefined
        ? {
            proceeds: {
              ...(proceedsBefore !== undefined ? { before: proceedsBefore } : {}),
              ...(proceedsAfter !== undefined ? { after: proceedsAfter } : {}),
              ...(estimated ? { estimated: true, commission: input.commission ?? DEFAULT_PLAY_COMMISSION } : {}),
            },
          }
        : {}),
      ...(resolved?.tax !== undefined ? { tax: resolved.tax } : {}),
      ...(input.measure === 'proceeds' && resolved ? { target: { measure: 'proceeds' as const, amount: resolved.target } } : {}),
      inputs: {
        effectiveDate,
        ...(input.consent?.billingPeriod ? { billingPeriod: input.consent.billingPeriod } : {}),
        ...(lastIncreaseAt ? { lastIncreaseAt } : {}),
        ...(usdRate ? { usdRate } : {}),
      },
    });
  }
  return notes;
}
