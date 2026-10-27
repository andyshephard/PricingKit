// Offer price derivation ("X% of each territory's own price, snapped to that
// territory's valid price points") and the drift check that compares an
// existing offer with its rule. Pure: callers pass in the base prices and
// price-point ladders they read.

import {
  compareDecimal,
  divideDecimal,
  isDecimalString,
  multiplyDecimal,
  normalizeDecimal,
  type Decimal,
} from './decimal';
import type { ProductPriceState } from './model';
import {
  durationRatio,
  type BillingPeriod,
  type OfferDuration,
  type OfferMode,
  type OfferTerritoryPrice,
  type PercentOfCurrentRule,
  type StoreOffer,
} from './offers';
import { snapToPricePoints, type PricePointCandidate } from './snap';

export const DEFAULT_OFFER_DEVIATION_THRESHOLD = '0.05';
/** Fraction digits kept for an unsnapped target (e.g. 1/12 of a price) */
const TARGET_SCALE = 6;

/** One territory's valid price points for the subscription */
export interface PriceLadder {
  /** ISO 4217; when given it must match the territory's base currency */
  currency?: string;
  points: PricePointCandidate[];
}

export type OfferFlagCode =
  | 'NO_CURRENT_PRICE'
  | 'CURRENT_PRICE_UNREADABLE'
  | 'NO_PRICE_LADDER'
  | 'CURRENCY_MISMATCH'
  | 'NO_PRICE_POINT'
  | 'NOT_BELOW_CURRENT'
  | 'DEVIATION_ABOVE_THRESHOLD';

export interface OfferFlag {
  code: OfferFlagCode;
  /** error: no usable offer price for this territory; warning: usable, but look at it */
  severity: 'error' | 'warning';
  message: string;
}

/** One preview row: what the rule gives in one territory */
export interface OfferPreviewRow {
  /** alpha-2 */
  territory: string;
  currency: string;
  /** The territory's current base price */
  currentPrice: Decimal | null;
  currentPricePointId?: string;
  /** The base price over the time one offer charge covers (current x duration ratio); the offer must stay below it */
  fullPriceEquivalent: Decimal | null;
  /** Unsnapped target */
  exactTarget: Decimal | null;
  /** The price point the target snapped to */
  snappedPrice: Decimal | null;
  pricePointId?: string;
  /** snappedPrice - exactTarget */
  deviation: Decimal | null;
  /** |deviation| / exactTarget, 4 decimal places ("0.0125" = 1.25%) */
  deviationRatio: Decimal | null;
  /** Developer proceeds of the snapped point, when the store reports them */
  proceeds?: Decimal;
  flags: OfferFlag[];
  /** True when there is an offer price to use (no error flags; warnings allowed) */
  ok: boolean;
}

export interface OfferDerivationInput {
  rule: PercentOfCurrentRule;
  offer: { mode: OfferMode; duration: OfferDuration };
  /** The subscription's billing period */
  billingPeriod: BillingPeriod;
  /** Current base prices (alpha-2 keyed) */
  base: ProductPriceState;
  /** Valid price points per alpha-2 territory */
  ladders: Record<string, PriceLadder>;
  /** Territories to derive; 'all' = every territory in `base` (default) */
  territories?: 'all' | string[];
  /** Flag a snapped price further than this fraction from its target (default "0.05" = 5%) */
  deviationThreshold?: Decimal;
}

export interface OfferDerivation {
  rule: PercentOfCurrentRule;
  /** Exact factor applied to each current price: percent / 100 x duration ratio */
  multiplier: { percent: Decimal; numerator: number; denominator: number };
  deviationThreshold: Decimal;
  rows: OfferPreviewRow[];
  summary: { territories: number; ok: number; errors: number; warnings: number };
}

export class OfferRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfferRuleError';
  }
}

/**
 * The exact factor for a rule: totalOverDuration multiplies by
 * offerDuration / billingPeriod (1-year offer on a monthly plan: 12; on an
 * annual plan: 1). perPeriod uses the current price as is.
 */
export function offerMultiplier(
  rule: PercentOfCurrentRule,
  duration: OfferDuration,
  billingPeriod: BillingPeriod
): { numerator: number; denominator: number } {
  if (rule.basis === 'perPeriod') return { numerator: 1, denominator: 1 };
  const ratio = durationRatio(duration, billingPeriod);
  if (!ratio) {
    throw new OfferRuleError(
      `A ${duration} offer on a ${billingPeriod} subscription has no exact duration ratio (weeks and months don't convert); use basis perPeriod`
    );
  }
  return ratio;
}

function flag(code: OfferFlagCode, severity: OfferFlag['severity'], message: string): OfferFlag {
  return { code, severity, message };
}

function emptyRow(territory: string, currency: string): OfferPreviewRow {
  return {
    territory,
    currency,
    currentPrice: null,
    fullPriceEquivalent: null,
    exactTarget: null,
    snappedPrice: null,
    deviation: null,
    deviationRatio: null,
    flags: [],
    ok: false,
  };
}

/**
 * Derive a percent-of-current offer's price in every territory. Each
 * territory uses its own current price and its own price points; nothing is
 * converted between currencies.
 */
export function deriveOfferPrices(input: OfferDerivationInput): OfferDerivation {
  const { rule, offer, billingPeriod, base, ladders } = input;
  if (offer.mode === 'FREE_TRIAL') throw new OfferRuleError('A free trial has no price to derive');
  if (!isDecimalString(rule.percent) || compareDecimal(rule.percent, '0') <= 0 || compareDecimal(rule.percent, '100') >= 0) {
    throw new OfferRuleError(`percent must be above 0 and below 100 (got ${JSON.stringify(rule.percent)})`);
  }
  const threshold = normalizeDecimal(input.deviationThreshold ?? DEFAULT_OFFER_DEVIATION_THRESHOLD);
  const multiplier = offerMultiplier(rule, offer.duration, billingPeriod);
  // The time one offer charge covers, compared with the billing period, for the "below current" check
  const spanRatio = durationRatio(offer.duration, billingPeriod) ?? { numerator: 1, denominator: 1 };
  const percent = normalizeDecimal(rule.percent);

  const territories = input.territories === undefined || input.territories === 'all' ? Object.keys(base.territories).sort() : [...new Set(input.territories)].sort();

  const rows = territories.map((territory): OfferPreviewRow => {
    const state = base.territories[territory];
    const row = emptyRow(territory, state?.currency ?? ladders[territory]?.currency ?? '');
    if (!state) {
      row.flags.push(flag('NO_CURRENT_PRICE', 'error', `${territory} has no base price`));
      return row;
    }
    if (state.problems?.current) {
      row.flags.push(flag('CURRENT_PRICE_UNREADABLE', 'error', `${territory} current price can't be read: ${state.problems.current}`));
      return row;
    }
    if (!state.current) {
      row.flags.push(flag('NO_CURRENT_PRICE', 'error', `${territory} has no current price`));
      return row;
    }

    const current = normalizeDecimal(state.current.amount);
    row.currency = state.current.currency;
    row.currentPrice = current;
    if (state.current.pricePointId) row.currentPricePointId = state.current.pricePointId;
    row.fullPriceEquivalent = divideDecimal(multiplyDecimal(current, String(spanRatio.numerator)), String(spanRatio.denominator), TARGET_SCALE);
    // current x percent x numerator / (100 x denominator): one division, so the target is exact whenever it terminates
    row.exactTarget = divideDecimal(
      multiplyDecimal(multiplyDecimal(current, percent), String(multiplier.numerator)),
      String(100 * multiplier.denominator),
      TARGET_SCALE
    );

    const ladder = ladders[territory];
    if (!ladder || ladder.points.length === 0) {
      row.flags.push(flag('NO_PRICE_LADDER', 'error', `No price points for ${territory}`));
      return row;
    }
    if (ladder.currency && ladder.currency !== row.currency) {
      row.flags.push(flag('CURRENCY_MISMATCH', 'error', `${territory} price points are in ${ladder.currency}, the base price is in ${row.currency}`));
      return row;
    }
    const points = ladder.points
      .filter((p) => isDecimalString(p.customerPrice))
      .map((p) => ({ ...p, customerPrice: normalizeDecimal(p.customerPrice) }));
    const snapped = snapToPricePoints(row.exactTarget, points, rule.snap);
    if (!snapped) {
      row.flags.push(flag('NO_PRICE_POINT', 'error', `No ${rule.snap} price point for ${row.exactTarget} ${row.currency}`));
      return row;
    }
    row.snappedPrice = snapped.point.customerPrice;
    if (snapped.point.id) row.pricePointId = snapped.point.id;
    if (snapped.point.proceeds && isDecimalString(snapped.point.proceeds)) row.proceeds = normalizeDecimal(snapped.point.proceeds);
    row.deviation = snapped.deviation;
    row.deviationRatio = snapped.deviationRatio;

    if (compareDecimal(row.snappedPrice, row.fullPriceEquivalent) >= 0) {
      row.flags.push(
        flag('NOT_BELOW_CURRENT', 'error', `${row.snappedPrice} ${row.currency} is not below the current price over the same time (${row.fullPriceEquivalent})`)
      );
    }
    if (compareDecimal(snapped.deviationRatio, threshold) > 0) {
      row.flags.push(
        flag('DEVIATION_ABOVE_THRESHOLD', 'warning', `Snapped price ${row.snappedPrice} is ${snapped.deviationRatio} away from the target ${row.exactTarget} (threshold ${threshold})`)
      );
    }
    row.ok = !row.flags.some((f) => f.severity === 'error');
    return row;
  });

  return {
    rule: { ...rule, percent },
    multiplier: { percent, ...multiplier },
    deviationThreshold: threshold,
    rows,
    summary: {
      territories: rows.length,
      ok: rows.filter((r) => r.ok).length,
      errors: rows.filter((r) => !r.ok).length,
      warnings: rows.filter((r) => r.flags.some((f) => f.severity === 'warning')).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Drift

export const OFFER_DRIFT_KIND = 'pricingkit.offerDrift' as const;
export const OFFER_DRIFT_SCHEMA_VERSION = 1 as const;

/**
 * match      - the offer price is the price the rule gives
 * mismatch   - the offer has a different price than the rule gives
 * missing    - the rule gives a price, the offer has none in this territory
 * extra      - the offer has a price in a territory the rule doesn't cover
 * unresolved - the rule can't give a price here (no base price, no price point, ...)
 * unreadable - the offer's own price here couldn't be read
 */
export type OfferDriftStatus = 'match' | 'mismatch' | 'missing' | 'extra' | 'unresolved' | 'unreadable';

export interface OfferDriftEntry {
  territory: string;
  status: OfferDriftStatus;
  /** The offer's price as the store has it */
  actual?: OfferTerritoryPrice;
  /** What the rule gives */
  expected?: { currency: string; amount: Decimal; pricePointId?: string; exactTarget: Decimal; currentPrice: Decimal };
  reason?: string;
}

export interface OfferDriftReport {
  kind: typeof OFFER_DRIFT_KIND;
  schemaVersion: typeof OFFER_DRIFT_SCHEMA_VERSION;
  checkedAt: string;
  offer: { kind: StoreOffer['kind']; storeId: string; key: string; name?: string; mode: OfferMode; duration: OfferDuration };
  rule: PercentOfCurrentRule;
  billingPeriod: BillingPeriod;
  deviationThreshold: Decimal;
  /** True when every territory matches */
  inSync: boolean;
  summary: Record<OfferDriftStatus, number>;
  /** Every territory looked at, sorted; filter on status for the drifted ones */
  territories: OfferDriftEntry[];
  /** Offer-level read problems (e.g. a price Apple returned without a territory) */
  problems?: string[];
  /** Warnings from the derivation (e.g. deviation above threshold) */
  warnings?: Array<{ territory: string; message: string }>;
}

function samePointOrAmount(actual: OfferTerritoryPrice, expected: { currency: string; amount: Decimal; pricePointId?: string }): boolean {
  if (actual.pricePointId && expected.pricePointId) return actual.pricePointId === expected.pricePointId;
  return actual.currency === expected.currency && compareDecimal(actual.amount, expected.amount) === 0;
}

export interface OfferDriftInput extends Omit<OfferDerivationInput, 'offer'> {
  offer: StoreOffer;
  /** ISO timestamp for the report (tests) */
  now?: string;
}

/**
 * Compare an existing offer with the price its rule gives today in every
 * territory. Reports missing and extra territories and every snapped-price
 * mismatch. The result is plain JSON.
 */
export function checkOfferDrift(input: OfferDriftInput): OfferDriftReport {
  const { offer } = input;
  if (!offer.mode || !offer.duration) {
    throw new OfferRuleError(`Offer ${offer.key} has an unknown mode or duration; its rule can't be checked`);
  }
  const derivation = deriveOfferPrices({ ...input, offer: { mode: offer.mode, duration: offer.duration } });
  const entries: OfferDriftEntry[] = [];
  const covered = new Set<string>();
  const warnings: Array<{ territory: string; message: string }> = [];

  for (const row of derivation.rows) {
    covered.add(row.territory);
    const actual = offer.prices[row.territory];
    const unreadable = offer.territoryProblems?.[row.territory];
    for (const f of row.flags) if (f.severity === 'warning') warnings.push({ territory: row.territory, message: f.message });

    if (unreadable) {
      entries.push({ territory: row.territory, status: 'unreadable', reason: unreadable });
      continue;
    }
    if (!row.ok || row.snappedPrice === null || row.exactTarget === null || row.currentPrice === null) {
      entries.push({
        territory: row.territory,
        status: 'unresolved',
        ...(actual ? { actual } : {}),
        reason: row.flags.filter((f) => f.severity === 'error').map((f) => f.message).join('; '),
      });
      continue;
    }
    const expected = {
      currency: row.currency,
      amount: row.snappedPrice,
      ...(row.pricePointId ? { pricePointId: row.pricePointId } : {}),
      exactTarget: row.exactTarget,
      currentPrice: row.currentPrice,
    };
    if (!actual) {
      entries.push({ territory: row.territory, status: 'missing', expected, reason: 'The offer has no price in this territory' });
    } else if (samePointOrAmount(actual, expected)) {
      entries.push({ territory: row.territory, status: 'match', actual, expected });
    } else {
      entries.push({
        territory: row.territory,
        status: 'mismatch',
        actual,
        expected,
        reason: `Offer is ${actual.amount} ${actual.currency}, rule gives ${expected.amount} ${expected.currency}`,
      });
    }
  }

  const offerTerritories = new Set([...Object.keys(offer.prices), ...Object.keys(offer.territoryProblems ?? {})]);
  for (const territory of offerTerritories) {
    if (covered.has(territory)) continue;
    const actual = offer.prices[territory];
    entries.push({
      territory,
      status: 'extra',
      ...(actual ? { actual } : {}),
      reason: 'The offer has a price in a territory the rule does not cover',
    });
  }
  entries.sort((a, b) => a.territory.localeCompare(b.territory));

  const summary: Record<OfferDriftStatus, number> = { match: 0, mismatch: 0, missing: 0, extra: 0, unresolved: 0, unreadable: 0 };
  for (const e of entries) summary[e.status]++;

  return {
    kind: OFFER_DRIFT_KIND,
    schemaVersion: OFFER_DRIFT_SCHEMA_VERSION,
    checkedAt: input.now ?? new Date().toISOString(),
    offer: {
      kind: offer.kind,
      storeId: offer.storeId,
      key: offer.key,
      ...(offer.name ? { name: offer.name } : {}),
      mode: offer.mode,
      duration: offer.duration,
    },
    rule: derivation.rule,
    billingPeriod: input.billingPeriod,
    deviationThreshold: derivation.deviationThreshold,
    inSync: entries.every((e) => e.status === 'match') && !(offer.problems?.length),
    summary,
    territories: entries,
    ...(offer.problems?.length ? { problems: [...offer.problems] } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
