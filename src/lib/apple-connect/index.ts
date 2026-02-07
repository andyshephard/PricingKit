// Apple App Store Connect API Module

// Re-export types
export * from './types';

// Re-export client utilities
export {
  generateJWT,
  clearTokenCache,
  validateAppleCredentials,
  appleApiRequest,
  AppleApiError,
  createAppleSession,
  getAppleSessionCredentials,
  deleteAppleSession,
  testAppleConnection,
  getAppIdForBundleId,
} from './client';

// Re-export territory utilities
export {
  APPLE_TERRITORIES,
  alpha2ToAlpha3,
  alpha3ToAlpha2,
  getTerritoryByAlpha2,
  getTerritoryByAlpha3,
  getCurrencyForTerritory,
  getAllTerritories,
  getTerritoriesSortedByName,
  getTerritoriesForCurrency,
} from './territories';

// Re-export product operations
export {
  listInAppPurchases,
  getInAppPurchase,
  getBaseTerritoryForProduct,
  getInAppPurchasePrices,
  getAvailablePricePoints,
  updateInAppPurchasePrice,
  updateInAppPurchasePrices,
  resolvePPPPricesToPricePoints,
  findClosestPricePoint,
  getInAppPurchasePricePointsForTerritory,
  type PPPResolutionResult,
} from './products';

// Re-export subscription operations
export {
  listSubscriptionGroups,
  listSubscriptions,
  getSubscription,
  getSubscriptionById,
  getSubscriptionPrices,
  getSubscriptionPricePoints,
  updateSubscriptionPrice,
  deleteSubscriptionPrice,
  formatSubscriptionPeriod,
  type SubscriptionPricesResult,
} from './subscriptions';
