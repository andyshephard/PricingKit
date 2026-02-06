// Apple App Store Connect API Type Definitions

export interface AppleConnectCredentials {
  privateKey: string; // .p8 file contents
  keyId: string; // Key ID from App Store Connect
  issuerId: string; // Issuer ID from App Store Connect
  bundleId: string; // App's Bundle ID
}

// Apple uses price points (tiers) instead of exact amounts
export interface ApplePricePoint {
  id: string;
  type: 'appPricePoints';
  attributes: {
    customerPrice: string; // e.g., "0.99"
    proceeds: string; // Developer proceeds after Apple's cut
    priceTier?: string; // e.g., "1" for Tier 1
  };
  relationships?: {
    territory?: {
      data: {
        id: string; // Territory code (e.g., "USA")
        type: 'territories';
      };
    };
    equalizations?: {
      data: Array<{
        id: string;
        type: 'appPricePoints';
      }>;
    };
  };
}

// Territory information
export interface AppleTerritory {
  id: string; // ISO 3166-1 alpha-3 code (e.g., "USA", "GBR")
  type: 'territories';
  attributes: {
    currency: string; // Currency code (e.g., "USD", "GBP")
  };
}

// In-App Purchase types
export type AppleInAppPurchaseType =
  | 'CONSUMABLE'
  | 'NON_CONSUMABLE'
  | 'NON_RENEWING_SUBSCRIPTION';

export type AppleInAppPurchaseState =
  | 'MISSING_METADATA'
  | 'READY_TO_SUBMIT'
  | 'WAITING_FOR_REVIEW'
  | 'IN_REVIEW'
  | 'DEVELOPER_ACTION_NEEDED'
  | 'PENDING_BINARY_APPROVAL'
  | 'APPROVED'
  | 'DEVELOPER_REMOVED_FROM_SALE'
  | 'REMOVED_FROM_SALE'
  | 'REJECTED';

export interface AppleInAppPurchase {
  id: string;
  type: 'inAppPurchases';
  attributes: {
    name: string;
    productId: string; // The product identifier
    inAppPurchaseType: AppleInAppPurchaseType;
    state: AppleInAppPurchaseState;
    reviewNote?: string;
    familySharable?: boolean;
    contentHosting?: boolean;
  };
  relationships?: {
    pricePoints?: {
      data: Array<{
        id: string;
        type: 'inAppPurchasePricePoints';
      }>;
    };
    iapPriceSchedule?: {
      data: {
        id: string;
        type: 'inAppPurchasePriceSchedules';
      };
    };
    inAppPurchaseLocalizations?: {
      data: Array<{
        id: string;
        type: 'inAppPurchaseLocalizations';
      }>;
    };
  };
}

export interface AppleInAppPurchaseLocalization {
  id: string;
  type: 'inAppPurchaseLocalizations';
  attributes: {
    name: string;
    description?: string;
    locale: string; // e.g., "en-US"
    state?: string;
  };
}

// Price schedule for in-app purchases
export interface AppleInAppPurchasePriceSchedule {
  id: string;
  type: 'inAppPurchasePriceSchedules';
  relationships?: {
    manualPrices?: {
      data: Array<{
        id: string;
        type: 'inAppPurchasePrices';
      }>;
    };
    automaticPrices?: {
      data: Array<{
        id: string;
        type: 'inAppPurchasePrices';
      }>;
    };
    baseTerritory?: {
      data: {
        id: string;
        type: 'territories';
      };
    };
  };
}

export interface AppleInAppPurchasePrice {
  id: string;
  type: 'inAppPurchasePrices';
  attributes: {
    startDate?: string; // ISO date string
    endDate?: string;
  };
  relationships?: {
    inAppPurchasePricePoint?: {
      data: {
        id: string;
        type: 'inAppPurchasePricePoints';
      };
    };
    territory?: {
      data: {
        id: string;
        type: 'territories';
      };
    };
  };
}

// In-App Purchase price point (returned in included data)
export interface AppleInAppPurchasePricePoint {
  id: string;
  type: 'inAppPurchasePricePoints';
  attributes: {
    customerPrice: string;
    proceeds: string;
    priceTier?: string;
  };
  relationships?: {
    territory?: {
      data: {
        id: string;
        type: 'territories';
      };
    };
  };
}

// Subscription types
export type AppleSubscriptionState =
  | 'MISSING_METADATA'
  | 'READY_TO_SUBMIT'
  | 'WAITING_FOR_REVIEW'
  | 'IN_REVIEW'
  | 'DEVELOPER_ACTION_NEEDED'
  | 'PENDING_BINARY_APPROVAL'
  | 'APPROVED'
  | 'DEVELOPER_REMOVED_FROM_SALE'
  | 'REMOVED_FROM_SALE'
  | 'REJECTED';

export interface AppleSubscriptionGroup {
  id: string;
  type: 'subscriptionGroups';
  attributes: {
    referenceName: string;
  };
  relationships?: {
    subscriptions?: {
      data: Array<{
        id: string;
        type: 'subscriptions';
      }>;
    };
    subscriptionGroupLocalizations?: {
      data: Array<{
        id: string;
        type: 'subscriptionGroupLocalizations';
      }>;
    };
  };
}

export interface AppleSubscription {
  id: string;
  type: 'subscriptions';
  attributes: {
    name: string;
    productId: string;
    familySharable?: boolean;
    state: AppleSubscriptionState;
    subscriptionPeriod:
      | 'ONE_WEEK'
      | 'ONE_MONTH'
      | 'TWO_MONTHS'
      | 'THREE_MONTHS'
      | 'SIX_MONTHS'
      | 'ONE_YEAR';
    reviewNote?: string;
    groupLevel?: number;
  };
  relationships?: {
    subscriptionPrices?: {
      data: Array<{
        id: string;
        type: 'subscriptionPrices';
      }>;
    };
    introductoryOffers?: {
      data: Array<{
        id: string;
        type: 'subscriptionIntroductoryOffers';
      }>;
    };
    promotionalOffers?: {
      data: Array<{
        id: string;
        type: 'subscriptionPromotionalOffers';
      }>;
    };
    subscriptionLocalizations?: {
      data: Array<{
        id: string;
        type: 'subscriptionLocalizations';
      }>;
    };
    group?: {
      data: {
        id: string;
        type: 'subscriptionGroups';
      };
    };
  };
}

export interface AppleSubscriptionPrice {
  id: string;
  type: 'subscriptionPrices';
  attributes: {
    startDate?: string;
    preserved?: boolean;
  };
  relationships?: {
    subscriptionPricePoint?: {
      data: {
        id: string;
        type: 'subscriptionPricePoints';
      };
    };
    territory?: {
      data: {
        id: string;
        type: 'territories';
      };
    };
  };
}

export interface AppleSubscriptionPricePoint {
  id: string;
  type: 'subscriptionPricePoints';
  attributes: {
    customerPrice: string;
    proceeds: string;
  };
  relationships?: {
    territory?: {
      data: {
        id: string;
        type: 'territories';
      };
    };
    equalizations?: {
      data: Array<{
        id: string;
        type: 'subscriptionPricePoints';
      }>;
    };
  };
}

export interface AppleSubscriptionLocalization {
  id: string;
  type: 'subscriptionLocalizations';
  attributes: {
    name: string;
    description?: string;
    locale: string;
    state?: string;
  };
}

// Union type for all possible included items
export type AppleIncludedItem =
  | ApplePricePoint
  | AppleTerritory
  | AppleInAppPurchaseLocalization
  | AppleInAppPurchasePriceSchedule
  | AppleInAppPurchasePrice
  | AppleInAppPurchasePricePoint
  | AppleSubscription
  | AppleSubscriptionPrice
  | AppleSubscriptionPricePoint
  | AppleSubscriptionLocalization;

// API Response types
export interface AppleApiResponse<T> {
  data: T;
  included?: AppleIncludedItem[];
  links?: {
    self: string;
    next?: string;
    first?: string;
  };
  meta?: {
    paging?: {
      total: number;
      limit: number;
    };
  };
}

export interface AppleApiListResponse<T> {
  data: T[];
  included?: AppleIncludedItem[];
  links?: {
    self: string;
    next?: string;
    first?: string;
  };
  meta?: {
    paging?: {
      total: number;
      limit: number;
    };
  };
}

export interface AppleApiError {
  id: string;
  status: string;
  code: string;
  title: string;
  detail: string;
  source?: {
    pointer?: string;
    parameter?: string;
  };
}

export interface AppleApiErrorResponse {
  errors: AppleApiError[];
}

// Normalized types for internal use (similar to Google Play types)
export interface NormalizedAppleProduct {
  id: string;
  productId: string;
  name: string;
  type: AppleInAppPurchaseType;
  state: AppleInAppPurchaseState;
  prices: Record<string, AppleProductPrice>; // Territory code -> price info
  localizations: Record<string, { name: string; description?: string }>;
}

export interface AppleProductPrice {
  territoryCode: string;
  currency: string;
  customerPrice: string;
  proceeds: string;
  pricePointId: string;
  startDate?: string; // ISO 8601 date string (null/undefined = current price)
  subscriptionPriceId?: string; // The subscription price ID needed for deletion
}

export interface NormalizedAppleSubscription {
  id: string;
  productId: string;
  name: string;
  state: AppleSubscriptionState;
  period: string;
  groupId: string;
  groupName: string;
  prices: Record<string, AppleProductPrice>;
  scheduledPrices?: Record<string, AppleProductPrice>; // Future scheduled prices by territory
  localizations: Record<string, { name: string; description?: string }>;
}

export interface NormalizedAppleSubscriptionGroup {
  id: string;
  name: string;
  subscriptions: NormalizedAppleSubscription[];
}

// Helper function to format Apple price
export function formatApplePrice(
  customerPrice: string,
  currency: string
): string {
  const amount = parseFloat(customerPrice);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
}

// Helper to convert Apple price to number
export function applepriceToNumber(customerPrice: string): number {
  return parseFloat(customerPrice);
}
