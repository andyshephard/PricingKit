// Pure transforms from fetched store state to the canonical PriceExport shape.
// Framework-free: no Next.js/React imports, no network access.

import type { BasePlan, Money } from '@/lib/google-play/types';
import type { AppleProductPrice } from '@/lib/apple-connect/types';
import { alpha3ToAlpha2 } from '@/lib/apple-connect/territories';
import { moneyToDecimal, normalizeDecimal } from './decimal';
import {
  PRICE_EXPORT_SCHEMA_VERSION,
  type ExportPrice,
  type PriceExport,
  type ScheduledPrice,
} from './types';

// Minimal structural view of a Google Play oneTimeProducts resource
export interface GoogleOneTimeProductInput {
  productId?: string;
  purchaseOptions?: Array<{
    purchaseOptionId?: string;
    regionalPricingAndAvailabilityConfigs?: Array<{
      regionCode?: string;
      price?: { currencyCode?: string; units?: string; nanos?: number };
      availability?: string;
    }>;
  }>;
}

interface ExportContext {
  exportedAt?: string;
}

function sortByTerritory(prices: ExportPrice[]): ExportPrice[] {
  return [...prices].sort((a, b) => (a.territory < b.territory ? -1 : a.territory > b.territory ? 1 : 0));
}

/** Normalize an Apple (alpha-3) or Google (alpha-2) territory code to alpha-2. */
export function toAlpha2(code: string): string {
  const upper = code.toUpperCase();
  if (upper.length === 3) {
    return alpha3ToAlpha2(upper) ?? upper;
  }
  return upper;
}

function moneyAmount(price: Money | { units?: string; nanos?: number }): string {
  return moneyToDecimal(price.units, price.nanos);
}

export function googleOneTimeProductToExport(
  packageName: string,
  product: GoogleOneTimeProductInput,
  { exportedAt = new Date().toISOString() }: ExportContext = {}
): PriceExport {
  // The editor works on the first purchase option, so export that one.
  const option = product.purchaseOptions?.[0];
  const prices: ExportPrice[] = [];

  for (const config of option?.regionalPricingAndAvailabilityConfigs ?? []) {
    if (!config.regionCode || !config.price) continue;
    prices.push({
      territory: toAlpha2(config.regionCode),
      currency: config.price.currencyCode ?? '',
      amount: moneyAmount(config.price),
      ...(config.availability ? { availability: config.availability } : {}),
    });
  }

  return {
    schemaVersion: PRICE_EXPORT_SCHEMA_VERSION,
    exportedAt,
    platform: 'google',
    app: { packageName },
    product: {
      type: 'inapp',
      id: product.productId ?? '',
      ...(option?.purchaseOptionId ? { purchaseOptionId: option.purchaseOptionId } : {}),
    },
    prices: sortByTerritory(prices),
  };
}

function basePlanAvailability(available: boolean | undefined): string | undefined {
  if (available === undefined) return undefined;
  return available ? 'AVAILABLE' : 'NO_NEW_SUBSCRIBERS';
}

export function googleBasePlanToExport(
  packageName: string,
  productId: string,
  basePlan: BasePlan,
  { exportedAt = new Date().toISOString() }: ExportContext = {}
): PriceExport {
  const prices: ExportPrice[] = (basePlan.regionalConfigs ?? []).map((config) => {
    const availability = basePlanAvailability(config.newSubscriberAvailability);
    return {
      territory: toAlpha2(config.regionCode),
      currency: config.price.currencyCode,
      amount: moneyAmount(config.price),
      ...(availability ? { availability } : {}),
    };
  });

  const other = basePlan.otherRegionsConfig;
  const otherAvailability = basePlanAvailability(other?.newSubscriberAvailability);

  return {
    schemaVersion: PRICE_EXPORT_SCHEMA_VERSION,
    exportedAt,
    platform: 'google',
    app: { packageName },
    product: { type: 'subscription', id: productId, basePlanId: basePlan.basePlanId },
    prices: sortByTerritory(prices),
    ...(other?.usdPrice && other?.eurPrice
      ? {
          otherRegions: {
            usdAmount: moneyAmount(other.usdPrice),
            eurAmount: moneyAmount(other.eurPrice),
            ...(otherAvailability ? { availability: otherAvailability } : {}),
          },
        }
      : {}),
  };
}

function applePriceTerritory(key: string, price: AppleProductPrice): string {
  return toAlpha2(price.territoryCode || key);
}

function applePricesToExport(
  current: Record<string, AppleProductPrice>,
  scheduled: Record<string, AppleProductPrice> | undefined
): ExportPrice[] {
  const byTerritory = new Map<string, ExportPrice>();

  for (const [key, price] of Object.entries(current)) {
    const territory = applePriceTerritory(key, price);
    byTerritory.set(territory, {
      territory,
      currency: price.currency,
      amount: normalizeDecimal(price.customerPrice),
      ...(price.proceeds ? { proceeds: normalizeDecimal(price.proceeds) } : {}),
    });
  }

  for (const [key, price] of Object.entries(scheduled ?? {})) {
    if (!price.startDate) continue;
    const territory = applePriceTerritory(key, price);
    const entry: ScheduledPrice = {
      amount: normalizeDecimal(price.customerPrice),
      startDate: price.startDate,
      ...(price.proceeds ? { proceeds: normalizeDecimal(price.proceeds) } : {}),
    };
    const existing = byTerritory.get(territory);
    if (existing) {
      existing.scheduled = [...(existing.scheduled ?? []), entry].sort((a, b) =>
        a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0
      );
    } else {
      // Scheduled-only territory: keep it so the export loses nothing.
      byTerritory.set(territory, {
        territory,
        currency: price.currency,
        amount: null,
        scheduled: [entry],
      });
    }
  }

  return sortByTerritory([...byTerritory.values()]);
}

export interface AppleInAppPurchaseInput {
  id: string;
  productId: string;
  baseTerritory?: string;
  prices: Record<string, AppleProductPrice>;
}

export function appleInAppPurchaseToExport(
  bundleId: string,
  product: AppleInAppPurchaseInput,
  { exportedAt = new Date().toISOString() }: ExportContext = {}
): PriceExport {
  return {
    schemaVersion: PRICE_EXPORT_SCHEMA_VERSION,
    exportedAt,
    platform: 'apple',
    app: { bundleId },
    product: {
      type: 'inapp',
      id: product.productId,
      storeId: product.id,
      ...(product.baseTerritory ? { baseTerritory: toAlpha2(product.baseTerritory) } : {}),
    },
    prices: applePricesToExport(product.prices, undefined),
  };
}

export interface AppleSubscriptionInput {
  id: string;
  productId: string;
  prices: Record<string, AppleProductPrice>;
  scheduledPrices?: Record<string, AppleProductPrice>;
}

export function appleSubscriptionToExport(
  bundleId: string,
  subscription: AppleSubscriptionInput,
  { exportedAt = new Date().toISOString() }: ExportContext = {}
): PriceExport {
  return {
    schemaVersion: PRICE_EXPORT_SCHEMA_VERSION,
    exportedAt,
    platform: 'apple',
    app: { bundleId },
    product: { type: 'subscription', id: subscription.productId, storeId: subscription.id },
    prices: applePricesToExport(subscription.prices, subscription.scheduledPrices),
  };
}
