// Core data model: products, prices and per-territory price state.
// Territories are ISO 3166-1 alpha-2 everywhere in the core; adapters map to
// Apple's alpha-3 IDs at the edge.

import { compareDecimal, type Decimal } from './decimal';

export type Platform = 'apple' | 'google';

/** Which app a plan, run or snapshot belongs to (same shape as the Phase 0 export). */
export type AppRef =
  | { packageName: string } // Google Play
  | { bundleId: string }; // App Store

export type ProductRef =
  /** Apple subscription; `id` is App Store Connect's numeric subscription ID */
  | { platform: 'apple'; type: 'subscription'; id: string; productId?: string }
  /** Apple in-app purchase (not yet supported by the Phase 1 adapter) */
  | { platform: 'apple'; type: 'inapp'; id: string; productId?: string }
  /** Google Play subscription base plan */
  | { platform: 'google'; type: 'subscription'; productId: string; basePlanId: string }
  /** Google Play one-time product (first purchase option) */
  | { platform: 'google'; type: 'inapp'; productId: string; purchaseOptionId?: string };

/** Stable string identity for a product, used to group ops and key state. */
export function productKey(ref: ProductRef): string {
  if (ref.platform === 'apple') return `apple:${ref.type}:${ref.id}`;
  if (ref.type === 'subscription') return `google:subscription:${ref.productId}/${ref.basePlanId}`;
  return `google:inapp:${ref.productId}`;
}

/** One price in one territory. Amounts are Decimal strings, never floats. */
export interface PriceValue {
  /** ISO 4217 */
  currency: string;
  /** Customer price (tax-inclusive where the store shows it that way) */
  amount: Decimal;
  /** Apple price point ID. Identifies the price exactly on Apple; absent on Google. */
  pricePointId?: string;
  /** Apple developer proceeds */
  proceeds?: Decimal;
  /** ISO 8601 date a scheduled price takes effect */
  startDate?: string;
}

/** Which price of a territory an op touches */
export type PriceSlot = 'current' | 'scheduled';

export interface TerritoryPriceState {
  /** alpha-2 */
  territory: string;
  currency: string;
  /** null when the territory has no current price (only a scheduled one, or none) */
  current: PriceValue | null;
  /** Apple's single future price for the territory, if any */
  scheduled?: PriceValue | null;
  /** Store availability state, when the store reports one */
  availability?: string;
  /**
   * Store-internal handles an adapter needs to act on this state (e.g. the
   * Apple subscriptionPrice ID of the scheduled price, to delete it). State
   * only: never copied into plans.
   */
  refs?: { scheduledPriceId?: string };
}

/** Everything the core needs to know about one product's prices right now. */
export interface ProductPriceState {
  product: ProductRef;
  /** ISO 8601 */
  capturedAt: string;
  /** Keyed by alpha-2 territory */
  territories: Record<string, TerritoryPriceState>;
  /** Things the adapter could not read (e.g. a territory without a currency) */
  warnings?: string[];
}

/**
 * Do two prices denote the same store price? On Apple a price point ID
 * identifies the price exactly; otherwise currency and amount must match.
 * Scheduled prices must also share their start date.
 */
export function samePrice(platform: Platform, a: PriceValue | null | undefined, b: PriceValue | null | undefined, slot: PriceSlot): boolean {
  if (!a || !b) return !a && !b;
  if (slot === 'scheduled' && (a.startDate ?? '') !== (b.startDate ?? '')) return false;
  if (platform === 'apple' && a.pricePointId && b.pricePointId) return a.pricePointId === b.pricePointId;
  return a.currency === b.currency && compareDecimal(a.amount, b.amount) === 0;
}

/** Short human-readable form, e.g. "4.99 USD (pp=abc) from 2030-01-01" */
export function describePrice(value: PriceValue | null | undefined): string {
  if (!value) return 'none';
  const parts = [`${value.amount} ${value.currency}`];
  if (value.pricePointId) parts.push(`(pp=${value.pricePointId})`);
  if (value.startDate) parts.push(`from ${value.startDate}`);
  return parts.join(' ');
}
