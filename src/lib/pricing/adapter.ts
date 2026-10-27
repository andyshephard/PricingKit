// What the executor needs from a store. Implementations live outside the core
// (src/lib/adapters) because they do network I/O; the core only knows this shape.

import type { BasePriceOp } from './changeset';
import type { InverseResult } from './inverse';
import type { OfferOp, OfferState } from './offer-ops';
import type { StoreOffer } from './offers';
import type { Platform, ProductPriceState, ProductRef, TerritoryPriceState } from './model';
import type { SnapMode } from './snap';

export interface ResolveTarget {
  currency: string;
  /** Unsnapped target amount (Decimal string) */
  amount: string;
}

export interface ResolvedPrice {
  currency: string;
  /** Snapped amount the store will accept */
  amount: string;
  pricePointId?: string;
  proceeds?: string;
  /** The amount that was asked for */
  target: string;
  /** amount - target */
  deviation: string;
  /** |deviation| / target, 4 decimal places */
  deviationRatio: string;
}

export interface ResolveResult {
  resolved: Record<string, ResolvedPrice>;
  /** Territory -> reason it could not be resolved */
  unresolved: Record<string, string>;
}

/** What the executor tells an adapter when it applies an op */
export interface ApplyContext {
  /** Freshly fetched state of the op's territory (undefined if the store has none) */
  territoryState: TerritoryPriceState | undefined;
}

/**
 * JSON-safe description of what the store did, stored in the run log. A
 * string `warning` marks an op that was applied but needs attention; the
 * executor copies it onto the op record.
 */
export type OpResponse = Record<string, unknown>;

export interface PlatformAdapter {
  readonly platform: Platform;
  /** Read one product's current prices */
  fetchState(product: ProductRef): Promise<ProductPriceState>;
  /** Snap target amounts to prices the store accepts, per territory */
  resolvePricePoints(
    product: ProductRef,
    targets: Record<string, ResolveTarget>,
    options?: { mode?: SnapMode }
  ): Promise<ResolveResult>;
  /** Apply one op. The executor has already checked the territory is at op.before. */
  apply(op: BasePriceOp, context: ApplyContext): Promise<OpResponse>;
  /**
   * Optional: apply several ops on one product in one store write (e.g. one
   * Google PATCH). Ops sharing a batchKey are passed together. Must return one
   * outcome per op, in order; an op's error doesn't have to fail the others.
   */
  applyMany?(ops: BasePriceOp[], contexts: ApplyContext[]): Promise<Array<{ response?: OpResponse; error?: unknown }>>;
  batchKey?(op: BasePriceOp): string | undefined;
  /**
   * Most requests applying these ops (one unit: a single op, or one batch)
   * can send, not counting client retries. The executor won't start a unit
   * the budget can't cover. Defaults to one per op.
   */
  requestsNeeded?(ops: BasePriceOp[], contexts: ApplyContext[]): number;
  /** The op that undoes `op`, from its before snapshot */
  inverse(op: BasePriceOp): InverseResult;

  /**
   * Optional: throw unless the product belongs to the app the adapter is
   * for (e.g. App Store Connect keys reach every app of a team). The executor
   * calls it once per product before reading or writing anything for it.
   */
  verifyProduct?(product: ProductRef): Promise<void>;

  // Offers (optional: an adapter without them refuses offer ops)

  /** Every offer of a product, as the store reports it now */
  fetchOffers?(product: ProductRef): Promise<StoreOffer[]>;
  /** Apply one offer op. The executor has already checked the offer is at op.before (or, for intro offers, which territories are pending). */
  applyOffer?(op: OfferOp, context: OfferApplyContext): Promise<OpResponse>;
  /** Most requests applying this offer op can send (default 1) */
  offerRequestsNeeded?(op: OfferOp, context: OfferApplyContext): number;
}

/** What the executor tells an adapter when it applies an offer op */
export interface OfferApplyContext {
  /** The offer as read right before applying (null when it doesn't exist) */
  observed: OfferState | null;
  /** The store's own record of the offer (IDs of the offer and its prices); absent for intro offers and creates */
  offer?: StoreOffer;
  /** Intro offers: the territories still to write */
  pending?: string[];
  /** Intro offers: store resource ID per territory */
  storeRefs?: Record<string, string>;
}

/** Read-only view of a request budget, so the executor can stop before a run runs dry */
export interface BudgetView {
  readonly remaining: number;
}
