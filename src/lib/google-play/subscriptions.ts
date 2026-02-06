import type { AndroidPublisher } from './client';
import type { Subscription, BasePlan, RegionalBasePlanConfig, Money, RegionsVersion } from './types';
import { GOOGLE_PLAY_REGIONS, moneyToNumber } from './types';
import { calculateBulkPrices } from './currency';

/**
 * Type for Google API subscription response.
 * The googleapis types are loosely typed, so we define our own interface
 * that matches what we expect from the API.
 */
interface GoogleApiSubscription extends Subscription {
  regionsVersion?: RegionsVersion;
}

/**
 * Type for the request body when updating subscriptions.
 * This matches the Google Play Developer API v3 schema.
 */
interface SubscriptionUpdateRequestBody {
  packageName: string;
  productId: string;
  basePlans?: BasePlan[];
}

/**
 * Get the latest available regions version for Google Play pricing.
 * This is required for subscription price updates.
 *
 * Google releases new regions versions periodically (format: YYYY/MM).
 * We use the latest known version that supports current currency configurations
 * (e.g., Bulgaria using EUR as of 2026).
 */
export function getLatestRegionsVersion(): string {
  // Use the latest known regions version
  // This should be updated when Google releases new versions
  // As of 2025/03, Bulgaria uses EUR
  return '2025/03';
}

export async function listSubscriptions(
  client: AndroidPublisher,
  packageName: string
): Promise<Subscription[]> {
  const subscriptions: Subscription[] = [];
  let pageToken: string | undefined;

  do {
    const response = await client.monetization.subscriptions.list({
      packageName,
      pageToken,
      pageSize: 100,
    });

    if (response.data.subscriptions) {
      // Google API returns loosely-typed data; cast to our internal Subscription type
      const apiSubscriptions = response.data.subscriptions as GoogleApiSubscription[];
      subscriptions.push(...apiSubscriptions);
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return subscriptions;
}

export async function getSubscription(
  client: AndroidPublisher,
  packageName: string,
  productId: string
): Promise<Subscription | null> {
  try {
    const response = await client.monetization.subscriptions.get({
      packageName,
      productId,
    });

    // Google API returns loosely-typed data; cast to our internal type
    const subscription = response.data as GoogleApiSubscription;

    // Debug: log regionsVersion to help troubleshoot currency issues
    if (subscription.regionsVersion) {
      console.log(`Subscription ${productId} regionsVersion:`, subscription.regionsVersion);
    } else {
      console.warn(`Subscription ${productId} has no regionsVersion in API response`);
    }

    return subscription;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
      return null;
    }
    throw error;
  }
}

export async function getBasePlan(
  client: AndroidPublisher,
  packageName: string,
  productId: string,
  basePlanId: string
): Promise<BasePlan | null> {
  // Base plans are retrieved as part of the subscription
  const subscription = await getSubscription(client, packageName, productId);
  if (!subscription) {
    return null;
  }

  return subscription.basePlans?.find(bp => bp.basePlanId === basePlanId) || null;
}

export async function updateBasePlanPrices(
  client: AndroidPublisher,
  packageName: string,
  productId: string,
  basePlanId: string,
  regionalConfigs: RegionalBasePlanConfig[]
): Promise<BasePlan> {
  // Get current subscription to preserve other fields
  const subscription = await getSubscription(client, packageName, productId);
  if (!subscription) {
    throw new Error(`Subscription ${productId} not found`);
  }

  const basePlan = subscription.basePlans?.find(bp => bp.basePlanId === basePlanId);
  if (!basePlan) {
    throw new Error(`Base plan ${basePlanId} not found in subscription ${productId}`);
  }

  // Merge regional configs
  // Ensure newSubscriberAvailability is true for all regions - Google Play
  // requires this when offers are configured for those regions
  const existingConfigs = basePlan.regionalConfigs || [];
  const configMap = new Map<string, RegionalBasePlanConfig>();

  for (const config of existingConfigs) {
    configMap.set(config.regionCode, {
      ...config,
      newSubscriberAvailability: true,
    });
  }

  for (const config of regionalConfigs) {
    configMap.set(config.regionCode, {
      ...config,
      newSubscriberAvailability: true,
    });
  }

  // Get US price to use as base for calculating missing regions
  const mergedConfigs = Array.from(configMap.values());
  const usConfig = mergedConfigs.find(c => c.regionCode === 'US');
  if (!usConfig) {
    throw new Error(`US price not found for base plan ${basePlanId}. Cannot calculate regional prices without a base USD price.`);
  }
  const baseUsdPrice = moneyToNumber(usConfig.price);

  // Google Play requires explicit regionalConfigs for ALL regions when offers exist.
  // Generate configs for any missing regions using exchange rate conversion.
  const allRegionCodes = GOOGLE_PLAY_REGIONS.map(r => r.code);
  const missingRegions = allRegionCodes.filter(code => !configMap.has(code));

  if (missingRegions.length > 0) {
    // Calculate prices for missing regions using exchange rate strategy
    const calculatedPrices = calculateBulkPrices(
      baseUsdPrice,
      missingRegions,
      'direct', // Use simple exchange rate for fill-in regions
      'charm'
    );

    for (const calculated of calculatedPrices) {
      configMap.set(calculated.regionCode, {
        regionCode: calculated.regionCode,
        price: calculated.price,
        newSubscriberAvailability: true,
      });
    }
  }

  const updatedConfigs = Array.from(configMap.values());

  // Update the subscription with modified base plan
  const updatedBasePlans = subscription.basePlans?.map(bp => {
    if (bp.basePlanId === basePlanId) {
      return {
        ...bp,
        regionalConfigs: updatedConfigs,
      };
    }
    return bp;
  });

  // Get the current regionsVersion from the subscription - required for updates
  // The regionsVersion is typically in the format { version: "2022/02" }
  // If not available on subscription, fetch the latest from another source
  let regionsVersionString = subscription.regionsVersion?.version;

  if (!regionsVersionString) {
    regionsVersionString = getLatestRegionsVersion();
  }

  const requestBody: SubscriptionUpdateRequestBody = {
    packageName,
    productId,
    basePlans: updatedBasePlans,
  };

  const response = await client.monetization.subscriptions.patch({
    packageName,
    productId,
    'regionsVersion.version': regionsVersionString,
    updateMask: 'basePlans',
    requestBody,
  });

  const updatedSubscription = response.data as GoogleApiSubscription;
  return updatedSubscription.basePlans?.find(bp => bp.basePlanId === basePlanId) || basePlan;
}

export async function deleteBasePlanRegionPrice(
  client: AndroidPublisher,
  packageName: string,
  productId: string,
  basePlanId: string,
  regionCode: string
): Promise<BasePlan> {
  const subscription = await getSubscription(client, packageName, productId);
  if (!subscription) {
    throw new Error(`Subscription ${productId} not found`);
  }

  const basePlan = subscription.basePlans?.find(bp => bp.basePlanId === basePlanId);
  if (!basePlan) {
    throw new Error(`Base plan ${basePlanId} not found`);
  }

  const filteredConfigs = (basePlan.regionalConfigs || []).filter(
    config => config.regionCode !== regionCode
  );

  // Build config map from filtered configs
  const configMap = new Map<string, RegionalBasePlanConfig>();
  for (const config of filteredConfigs) {
    configMap.set(config.regionCode, config);
  }

  // Get US price to use as base for calculating missing regions
  const usConfig = filteredConfigs.find(c => c.regionCode === 'US');
  if (!usConfig) {
    throw new Error(`US price not found for base plan ${basePlanId}. Cannot calculate regional prices without a base USD price.`);
  }
  const baseUsdPrice = moneyToNumber(usConfig.price);

  // Google Play requires explicit regionalConfigs for ALL regions when offers exist.
  const allRegionCodes = GOOGLE_PLAY_REGIONS.map(r => r.code);
  const missingRegions = allRegionCodes.filter(code => !configMap.has(code));

  if (missingRegions.length > 0) {
    const calculatedPrices = calculateBulkPrices(
      baseUsdPrice,
      missingRegions,
      'direct',
      'charm'
    );

    for (const calculated of calculatedPrices) {
      configMap.set(calculated.regionCode, {
        regionCode: calculated.regionCode,
        price: calculated.price,
        newSubscriberAvailability: true,
      });
    }
  }

  const updatedConfigs = Array.from(configMap.values());

  const updatedBasePlans = subscription.basePlans?.map(bp => {
    if (bp.basePlanId === basePlanId) {
      return {
        ...bp,
        regionalConfigs: updatedConfigs,
      };
    }
    return bp;
  });

  // Get the current regionsVersion from the subscription - required for updates
  // If not available on subscription, use the latest known version
  let regionsVersionString = subscription.regionsVersion?.version;

  if (!regionsVersionString) {
    regionsVersionString = getLatestRegionsVersion();
  }

  const deleteRequestBody: SubscriptionUpdateRequestBody = {
    packageName,
    productId,
    basePlans: updatedBasePlans,
  };

  const response = await client.monetization.subscriptions.patch({
    packageName,
    productId,
    'regionsVersion.version': regionsVersionString,
    updateMask: 'basePlans',
    requestBody: deleteRequestBody,
  });

  const updatedSubscription = response.data as GoogleApiSubscription;
  return updatedSubscription.basePlans?.find(bp => bp.basePlanId === basePlanId) || basePlan;
}

export function calculateNewBasePlanPrice(
  currentConfig: RegionalBasePlanConfig,
  operation: { type: 'fixed' | 'percentage' | 'round'; value?: number; roundTo?: number }
): RegionalBasePlanConfig {
  const parsedUnits = parseFloat(currentConfig.price.units);
  if (isNaN(parsedUnits) || !Number.isFinite(parsedUnits)) {
    throw new Error(`Invalid price units value: "${currentConfig.price.units}"`);
  }
  const currentAmount = parsedUnits +
    (currentConfig.price.nanos ? currentConfig.price.nanos / 1_000_000_000 : 0);

  let newAmount: number;

  switch (operation.type) {
    case 'fixed':
      newAmount = operation.value ?? currentAmount;
      break;
    case 'percentage':
      newAmount = currentAmount * (1 + (operation.value ?? 0) / 100);
      break;
    case 'round':
      const roundTo = operation.roundTo ?? 0.99;
      newAmount = Math.floor(currentAmount) + roundTo;
      break;
    default:
      newAmount = currentAmount;
  }

  newAmount = Math.max(0, newAmount);

  let units = Math.floor(newAmount);
  let nanos = Math.round((newAmount - units) * 1_000_000_000);

  // Clamp nanos to valid range, carrying overflow into units
  if (nanos > 999_999_999) {
    units += Math.floor(nanos / 1_000_000_000);
    nanos = nanos % 1_000_000_000;
  }

  const newPrice: Money = {
    currencyCode: currentConfig.price.currencyCode,
    units: units.toString(),
    nanos: nanos > 0 ? nanos : undefined,
  };

  return {
    ...currentConfig,
    price: newPrice,
  };
}
