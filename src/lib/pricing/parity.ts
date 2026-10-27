// Cross-store parity: one App Store subscription mapped to one Google Play
// base plan, and a per-territory comparison of what customers pay in each.
//
// A mapping (in a workspace, see workspace.ts) may carry a target. Then one
// target drives both stores: the workspace planner adds it to each app's spec,
// each store snaps it separately (Apple to its price points, Play through
// its own price conversion), and the parity report on the planned prices
// shows where the two stores still differ.
//
// Prices are compared as each store lists them: the customer price in the
// territory's currency. Both stores show tax-inclusive prices in most
// territories and tax-exclusive ones in a few (e.g. the United States), the
// same way, so the comparison is like for like; a territory billed in
// different currencies by the two stores is reported as not comparable,
// never converted.
// Framework-free.

import { absDecimal, compareDecimal, divideDecimal, isZeroDecimal, multiplyDecimal, subtractDecimal, type Decimal } from './decimal';
import type { BasePriceOp } from './changeset';
import type { ProductPriceState, ProductRef } from './model';
import { projectBasePrices } from './offer-sync';

export const PARITY_REPORT_KIND = 'pricingkit.parity' as const;
export const PARITY_REPORT_SCHEMA_VERSION = 1 as const;
/** Default largest accepted difference, as a fraction of the lower price (5%) */
export const DEFAULT_PARITY_THRESHOLD = '0.05';

export interface ParityMapping {
  /** Stable name of the mapping, e.g. "annual" */
  id: string;
  apple: { bundleId: string; subscription: string };
  play: { packageName: string; subscription: string; basePlan: string };
  /** Largest accepted difference as a fraction of the lower price (default "0.05") */
  threshold?: Decimal;
  /** Territories to compare (default: every territory either store prices) */
  territories?: string[];
}

export type ParityOutcome = 'inParity' | 'gaps' | 'notChecked';

export type ParityStatus =
  /** Same amount in the same currency */
  | 'same'
  /** Different, within the threshold */
  | 'withinThreshold'
  /** Different by more than the threshold */
  | 'gap'
  /** The stores bill this territory in different currencies: not compared */
  | 'notComparable'
  /** Priced on one store only */
  | 'appleOnly'
  | 'playOnly'
  /** A price that couldn't be read unambiguously */
  | 'unreadable';

export interface ParityRow {
  territory: string;
  status: ParityStatus;
  apple?: { amount: Decimal; currency: string };
  play?: { amount: Decimal; currency: string };
  /** play - apple (same currency only) */
  difference?: Decimal;
  /** |difference| / the lower price, 4 decimal places (for display: the status compares exactly) */
  ratio?: Decimal;
  reason?: string;
}

export type AppleSubscriptionRef = Extract<ProductRef, { platform: 'apple'; type: 'subscription' }>;
export type PlayBasePlanRef = Extract<ProductRef, { platform: 'google'; type: 'subscription' }>;

export interface ParityMappingReport {
  id: string;
  apple: AppleSubscriptionRef;
  play: PlayBasePlanRef;
  appleApp: { bundleId: string };
  playApp: { packageName: string };
  threshold: Decimal;
  /**
   * gaps: a territory differs by more than the threshold.
   * notChecked: no gap, but a territory couldn't be compared (unreadable, or billed in
   * different currencies), or no territory could be compared at all.
   * inParity: every territory priced on both stores was compared and none has a gap.
   */
  status: ParityOutcome;
  /** status === 'inParity' */
  inParity: boolean;
  summary: Record<ParityStatus, number>;
  rows: ParityRow[];
  /** Territories asked for that neither store prices */
  notPriced?: string[];
}

export interface ParityReport {
  kind: typeof PARITY_REPORT_KIND;
  schemaVersion: typeof PARITY_REPORT_SCHEMA_VERSION;
  checkedAt: string;
  /** current: the stores' prices now; plan: the prices once the plans are applied */
  basis: 'current' | 'plan';
  /** gaps if any mapping has one, else notChecked if any mapping does, else inParity */
  status: ParityOutcome;
  inParity: boolean;
  mappings: ParityMappingReport[];
}

export function parityAppleProduct(mapping: ParityMapping): AppleSubscriptionRef {
  return { platform: 'apple', type: 'subscription', id: mapping.apple.subscription };
}

export function parityPlayProduct(mapping: ParityMapping): PlayBasePlanRef {
  return { platform: 'google', type: 'subscription', productId: mapping.play.subscription, basePlanId: mapping.play.basePlan };
}

function emptySummary(): Record<ParityStatus, number> {
  return { same: 0, withinThreshold: 0, gap: 0, notComparable: 0, appleOnly: 0, playOnly: 0, unreadable: 0 };
}

/** Compare one territory's two prices */
export function compareParity(
  territory: string,
  apple: { amount: Decimal; currency: string } | undefined,
  play: { amount: Decimal; currency: string } | undefined,
  threshold: Decimal
): ParityRow {
  if (!apple && !play) return { territory, status: 'unreadable', reason: 'neither store prices it' };
  if (!apple) return { territory, status: 'playOnly', play };
  if (!play) return { territory, status: 'appleOnly', apple };
  if (apple.currency !== play.currency) {
    return { territory, status: 'notComparable', apple, play, reason: `App Store bills ${apple.currency}, Google Play ${play.currency}` };
  }
  const difference = subtractDecimal(play.amount, apple.amount);
  if (isZeroDecimal(difference)) return { territory, status: 'same', apple, play, difference: '0', ratio: '0' };
  const lower = compareDecimal(apple.amount, play.amount) <= 0 ? apple.amount : play.amount;
  // Exact: |difference| > threshold x lower. The ratio is rounded for display only.
  const gap = compareDecimal(absDecimal(difference), multiplyDecimal(threshold, lower)) > 0;
  const ratio = isZeroDecimal(lower) ? '1' : divideDecimal(absDecimal(difference), lower, 4);
  return { territory, status: gap ? 'gap' : 'withinThreshold', apple, play, difference, ratio };
}

/**
 * Per-territory parity of one mapping from the two products' price states
 * (each read from its own store). Pure.
 */
export function parityMappingReport(mapping: ParityMapping, appleState: ProductPriceState, playState: ProductPriceState): ParityMappingReport {
  const threshold = mapping.threshold ?? DEFAULT_PARITY_THRESHOLD;
  const priced = (state: ProductPriceState) => Object.keys(state.territories).filter((t) => state.territories[t].current || state.territories[t].problems?.current);
  const territories = mapping.territories ? [...new Set(mapping.territories)].sort() : [...new Set([...priced(appleState), ...priced(playState)])].sort();
  const summary = emptySummary();
  const rows: ParityRow[] = [];
  const notPriced: string[] = [];
  for (const territory of territories) {
    const a = appleState.territories[territory];
    const p = playState.territories[territory];
    let row: ParityRow;
    if (a?.problems?.current || p?.problems?.current) {
      row = { territory, status: 'unreadable', reason: a?.problems?.current ? `App Store: ${a.problems.current}` : `Google Play: ${p!.problems!.current}` };
    } else if (!a?.current && !p?.current) {
      notPriced.push(territory);
      continue;
    } else {
      const price = (v: typeof a) => (v?.current ? { amount: v.current.amount, currency: v.current.currency } : undefined);
      row = compareParity(territory, price(a), price(p), threshold);
    }
    summary[row.status]++;
    rows.push(row);
  }
  return {
    id: mapping.id,
    apple: parityAppleProduct(mapping),
    play: parityPlayProduct(mapping),
    appleApp: { bundleId: mapping.apple.bundleId },
    playApp: { packageName: mapping.play.packageName },
    threshold,
    status: mappingOutcome(summary),
    inParity: mappingOutcome(summary) === 'inParity',
    summary,
    rows,
    ...(notPriced.length > 0 ? { notPriced } : {}),
  };
}

/** The same report on the prices a plan leaves: each product's setPrice ops applied to its state */
export function plannedParityMappingReport(
  mapping: ParityMapping,
  appleState: ProductPriceState,
  appleOps: BasePriceOp[],
  playState: ProductPriceState,
  playOps: BasePriceOp[]
): ParityMappingReport {
  return parityMappingReport(mapping, projectBasePrices(appleState, appleOps), projectBasePrices(playState, playOps));
}

export function mappingOutcome(summary: Record<ParityStatus, number>): ParityOutcome {
  if (summary.gap > 0) return 'gaps';
  if (summary.unreadable > 0 || summary.notComparable > 0) return 'notChecked';
  // Nothing compared at all (e.g. only one store prices the product) is never "in parity"
  if (summary.same + summary.withinThreshold === 0) return 'notChecked';
  return 'inParity';
}

export function buildParityReport(mappings: ParityMappingReport[], basis: ParityReport['basis'], checkedAt: string): ParityReport {
  const status: ParityOutcome = mappings.some((m) => m.status === 'gaps') ? 'gaps' : mappings.some((m) => m.status === 'notChecked') || mappings.length === 0 ? 'notChecked' : 'inParity';
  return {
    kind: PARITY_REPORT_KIND,
    schemaVersion: PARITY_REPORT_SCHEMA_VERSION,
    checkedAt,
    basis,
    status,
    inParity: status === 'inParity',
    mappings,
  };
}
