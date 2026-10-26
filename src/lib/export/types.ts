// Canonical price export shape.
// This is a stable, versioned format: it is the snapshot users take before
// changing prices, and the seed for future plan files. Bump
// PRICE_EXPORT_SCHEMA_VERSION on any breaking change to these types.

export const PRICE_EXPORT_SCHEMA_VERSION = 1 as const;

export type ExportPlatform = 'apple' | 'google';
export type ExportProductType = 'inapp' | 'subscription';
export type ExportFormat = 'json' | 'csv';

export type ExportApp =
  | { packageName: string } // Google Play
  | { bundleId: string }; // App Store

export interface ExportProduct {
  type: ExportProductType;
  /** Store product identifier (Google SKU / product ID, Apple productId) */
  id: string;
  /** Google subscription base plan */
  basePlanId?: string;
  /** Apple internal numeric ID, when known */
  storeId?: string;
  /** Google one-time product purchase option the prices belong to */
  purchaseOptionId?: string;
  /** Apple IAP base territory (alpha-2) */
  baseTerritory?: string;
}

export interface ScheduledPrice {
  /** Canonical decimal string */
  amount: string;
  /** ISO 8601 date the price takes effect */
  startDate: string;
  /** Apple developer proceeds, canonical decimal string */
  proceeds?: string;
}

export interface ExportPrice {
  /** ISO 3166-1 alpha-2 */
  territory: string;
  /** ISO 4217 */
  currency: string;
  /**
   * Current customer price as a canonical decimal string (never a float).
   * null only when a territory has a scheduled price but no current one.
   */
  amount: string | null;
  /** Apple developer proceeds, canonical decimal string */
  proceeds?: string;
  /** Future prices, ordered by startDate */
  scheduled?: ScheduledPrice[];
  /**
   * Store availability state. Google one-time products use the API value
   * (e.g. "AVAILABLE"); Google base plans map newSubscriberAvailability to
   * "AVAILABLE" or "NO_NEW_SUBSCRIBERS".
   */
  availability?: string;
}

/** Google base plan prices for regions without an explicit config */
export interface ExportOtherRegions {
  usdAmount: string;
  eurAmount: string;
  availability?: string;
}

export interface PriceExport {
  schemaVersion: typeof PRICE_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  platform: ExportPlatform;
  app: ExportApp;
  product: ExportProduct;
  /** Sorted by territory */
  prices: ExportPrice[];
  otherRegions?: ExportOtherRegions;
}
