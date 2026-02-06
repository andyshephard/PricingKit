/**
 * Shared API Types
 *
 * This file contains normalized type definitions for cross-platform use
 * and standardized API response/request shapes.
 */

import type { Money, InAppProduct, Subscription, RegionalBasePlanConfig } from '@/lib/google-play/types';
import type {
  NormalizedAppleProduct,
  NormalizedAppleSubscription,
  AppleProductPrice,
} from '@/lib/apple-connect/types';

// ============================================================================
// Platform Types
// ============================================================================

export type Platform = 'google' | 'apple';

// ============================================================================
// Normalized Product Types (Cross-Platform)
// ============================================================================

/**
 * Raw Apple product shape as returned from Apple API before normalization
 */
export interface RawAppleProduct {
  productId: string;
  name: string;
  state: string;
  type: string;
  prices?: Record<string, AppleProductPrice>;
}

/**
 * Raw Apple subscription shape as returned from Apple API before normalization
 */
export interface RawAppleSubscription {
  id: string;
  productId: string;
  name: string;
  state: string;
  period: string;
  groupName?: string;
  prices?: Record<string, AppleProductPrice>;
}

/**
 * Unified product type that works across platforms
 */
export type UnifiedProduct = InAppProduct | (InAppProduct & { _appleProduct?: NormalizedAppleProduct });

/**
 * Unified subscription type that works across platforms
 */
export type UnifiedSubscription = Subscription | (Subscription & { _appleSubscription?: NormalizedAppleSubscription });

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Standard API error response shape
 */
export interface ApiErrorResponse {
  error: string;
  details?: Array<{
    code?: string;
    message?: string;
    path?: (string | number)[];
  }>;
}

/**
 * Products list API response
 */
export interface ProductsListResponse {
  products: InAppProduct[];
}

/**
 * Single product API response
 */
export interface ProductResponse {
  product: InAppProduct;
}

/**
 * Product update success response
 */
export interface ProductUpdateResponse {
  product: InAppProduct;
  updated?: number;
  skipped?: string[];
}

/**
 * Subscriptions list API response
 */
export interface SubscriptionsListResponse {
  subscriptions: Subscription[];
  subscriptionGroups?: Array<{
    id: string;
    name: string;
    subscriptions: Subscription[];
  }>;
}

/**
 * Single subscription API response
 */
export interface SubscriptionResponse {
  subscription: Subscription;
}

/**
 * Subscription update success response
 */
export interface SubscriptionUpdateResponse {
  basePlan?: unknown;
  subscription?: Subscription;
  success?: boolean;
}

// ============================================================================
// API Request Types
// ============================================================================

/**
 * Update product prices request body
 */
export interface UpdateProductPricesRequest {
  prices: Record<string, Money>;
  defaultPrice?: Money;
}

/**
 * Delete region price request body
 */
export interface DeleteRegionPriceRequest {
  regionCode: string;
}

/**
 * Update base plan prices request body
 */
export interface UpdateBasePlanPricesRequest {
  basePlanId: string;
  regionalConfigs: RegionalBasePlanConfig[];
}

/**
 * Delete base plan region price request body
 */
export interface DeleteBasePlanRegionPriceRequest {
  basePlanId: string;
  regionCode: string;
}

// ============================================================================
// Auth Types
// ============================================================================

/**
 * Auth status response
 */
export interface AuthStatusResponse {
  authenticated: boolean;
  packageName?: string;
  projectId?: string;
  clientEmail?: string;
  bundleId?: string;
}

/**
 * Auth success response
 */
export interface AuthSuccessResponse {
  success: true;
  projectId?: string;
  clientEmail?: string;
  bundleId?: string;
  keyId?: string;
  issuerId?: string;
}

// ============================================================================
// Exchange Rate Types
// ============================================================================

/**
 * Exchange rates API response
 */
export interface ExchangeRatesResponse {
  base: string;
  rates: Record<string, number>;
  timestamp?: number;
}

// ============================================================================
// PPP (Purchasing Power Parity) Types
// ============================================================================

/**
 * PPP multipliers response
 */
export interface PPPMultipliersResponse {
  multipliers: Record<string, number>;
  source?: string;
}

// ============================================================================
// Bulk Operations Types
// ============================================================================

/**
 * Bulk price update request item
 */
export interface BulkUpdateItem {
  type: 'product' | 'subscription';
  id: string;
  basePlanId?: string;
}

/**
 * Bulk price operation configuration
 */
export interface BulkPriceOperationConfig {
  mode: 'fixed' | 'percentage' | 'ppp';
  basePrice?: Money;
  percentage?: number;
  targetRegions: string[];
}

/**
 * Bulk update request body
 */
export interface BulkUpdateRequest {
  items: BulkUpdateItem[];
  operation: BulkPriceOperationConfig;
}

/**
 * Bulk update result for a single item
 */
export interface BulkUpdateItemResult {
  id: string;
  success: boolean;
  error?: string;
  updated?: number;
  skipped?: string[];
}

/**
 * Bulk update response
 */
export interface BulkUpdateResponse {
  total: number;
  successful: number;
  failed: number;
  results: BulkUpdateItemResult[];
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if an error response is an API error
 */
export function isApiError(error: unknown): error is ApiErrorResponse {
  return (
    typeof error === 'object' &&
    error !== null &&
    'error' in error &&
    typeof (error as ApiErrorResponse).error === 'string'
  );
}

/**
 * Check if a product has Apple-specific data
 */
export function hasAppleProductData(
  product: UnifiedProduct
): product is InAppProduct & { _appleProduct: NormalizedAppleProduct } {
  return '_appleProduct' in product && product._appleProduct !== undefined;
}

/**
 * Check if a subscription has Apple-specific data
 */
export function hasAppleSubscriptionData(
  subscription: UnifiedSubscription
): subscription is Subscription & { _appleSubscription: NormalizedAppleSubscription } {
  return '_appleSubscription' in subscription && subscription._appleSubscription !== undefined;
}
