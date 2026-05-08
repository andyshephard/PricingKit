import { googlePlayFetch } from './client';
import type {
  ServiceAccountCredentials,
  Subscription,
  BasePlan,
  RegionalBasePlanConfig,
  Money,
  RegionsVersion,
} from './types';
import { GOOGLE_PLAY_REGIONS, moneyToNumber } from './types';
import { calculateBulkPrices } from './currency';

interface GoogleApiSubscription extends Subscription {
  regionsVersion?: RegionsVersion;
}

interface SubscriptionListResponse {
  subscriptions?: GoogleApiSubscription[];
  nextPageToken?: string;
}

interface SubscriptionUpdateRequestBody {
  packageName: string;
  productId: string;
  basePlans?: BasePlan[];
}

/**
 * Get the latest available regions version for Google Play pricing.
 * Required for subscription price updates. Format: YYYY/MM.
 */
export function getLatestRegionsVersion(): string {
  return '2025/03';
}

export async function listSubscriptions(
  credentials: ServiceAccountCredentials,
  packageName: string
): Promise<Subscription[]> {
  const subscriptions: Subscription[] = [];
  let pageToken: string | undefined;

  do {
    const response = await googlePlayFetch<SubscriptionListResponse>(
      credentials,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions`,
      {
        query: {
          pageSize: 100,
          pageToken,
        },
      }
    );

    if (response.subscriptions) {
      subscriptions.push(...response.subscriptions);
    }

    pageToken = response.nextPageToken ?? undefined;
  } while (pageToken);

  return subscriptions;
}

export async function getSubscription(
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string
): Promise<Subscription | null> {
  try {
    const subscription = await googlePlayFetch<GoogleApiSubscription>(
      credentials,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions/${encodeURIComponent(productId)}`
    );

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
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string,
  basePlanId: string
): Promise<BasePlan | null> {
  const subscription = await getSubscription(credentials, packageName, productId);
  if (!subscription) {
    return null;
  }
  return subscription.basePlans?.find(bp => bp.basePlanId === basePlanId) || null;
}

export async function updateBasePlanPrices(
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string,
  basePlanId: string,
  regionalConfigs: RegionalBasePlanConfig[]
): Promise<BasePlan> {
  const subscription = await getSubscription(credentials, packageName, productId);
  if (!subscription) {
    throw new Error(`Subscription ${productId} not found`);
  }

  const basePlan = subscription.basePlans?.find(bp => bp.basePlanId === basePlanId);
  if (!basePlan) {
    throw new Error(`Base plan ${basePlanId} not found in subscription ${productId}`);
  }

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

  const mergedConfigs = Array.from(configMap.values());
  const usConfig = mergedConfigs.find(c => c.regionCode === 'US');
  if (!usConfig) {
    throw new Error(`US price not found for base plan ${basePlanId}. Cannot calculate regional prices without a base USD price.`);
  }
  const baseUsdPrice = moneyToNumber(usConfig.price);

  const allRegionCodes = GOOGLE_PLAY_REGIONS.map(r => r.code);
  const missingRegions = allRegionCodes.filter(code => !configMap.has(code));

  if (missingRegions.length > 0) {
    const calculatedPrices = calculateBulkPrices(
      baseUsdPrice,
      missingRegions,
      'direct', // Use simple exchange rate for fill-in regions
      'nearest-99',
      undefined,
      undefined,
      undefined,
      undefined,
      'USD',
      'US'
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

  const regionsVersionString = subscription.regionsVersion?.version || getLatestRegionsVersion();

  const requestBody: SubscriptionUpdateRequestBody = {
    packageName,
    productId,
    basePlans: updatedBasePlans,
  };

  const response = await googlePlayFetch<GoogleApiSubscription>(
    credentials,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions/${encodeURIComponent(productId)}`,
    {
      method: 'PATCH',
      query: {
        'regionsVersion.version': regionsVersionString,
        updateMask: 'basePlans',
      },
      body: requestBody,
    }
  );

  return response.basePlans?.find(bp => bp.basePlanId === basePlanId) || basePlan;
}

export async function deleteBasePlanRegionPrice(
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string,
  basePlanId: string,
  regionCode: string
): Promise<BasePlan> {
  const subscription = await getSubscription(credentials, packageName, productId);
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

  const configMap = new Map<string, RegionalBasePlanConfig>();
  for (const config of filteredConfigs) {
    configMap.set(config.regionCode, config);
  }

  const usConfig = filteredConfigs.find(c => c.regionCode === 'US');
  if (!usConfig) {
    throw new Error(`US price not found for base plan ${basePlanId}. Cannot calculate regional prices without a base USD price.`);
  }
  const baseUsdPrice = moneyToNumber(usConfig.price);

  const allRegionCodes = GOOGLE_PLAY_REGIONS.map(r => r.code);
  const missingRegions = allRegionCodes.filter(code => !configMap.has(code));

  if (missingRegions.length > 0) {
    const calculatedPrices = calculateBulkPrices(
      baseUsdPrice,
      missingRegions,
      'direct',
      'nearest-99',
      undefined,
      undefined,
      undefined,
      undefined,
      'USD',
      'US'
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

  const regionsVersionString = subscription.regionsVersion?.version || getLatestRegionsVersion();

  const deleteRequestBody: SubscriptionUpdateRequestBody = {
    packageName,
    productId,
    basePlans: updatedBasePlans,
  };

  const response = await googlePlayFetch<GoogleApiSubscription>(
    credentials,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions/${encodeURIComponent(productId)}`,
    {
      method: 'PATCH',
      query: {
        'regionsVersion.version': regionsVersionString,
        updateMask: 'basePlans',
      },
      body: deleteRequestBody,
    }
  );

  return response.basePlans?.find(bp => bp.basePlanId === basePlanId) || basePlan;
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
