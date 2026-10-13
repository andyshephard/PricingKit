import { googlePlayFetch } from './client';
import type {
  ServiceAccountCredentials,
  Subscription,
  BasePlan,
  RegionalBasePlanConfig,
  Money,
  RegionsVersion,
} from './types';

interface SubscriptionListResponse {
  subscriptions?: Subscription[];
  nextPageToken?: string;
}

interface SubscriptionUpdateRequestBody {
  packageName: string;
  productId: string;
  basePlans?: BasePlan[];
}

interface ConvertedRegionPrice {
  regionCode?: string;
  price: Money;
  taxAmount?: Money;
}

interface ConvertRegionPricesResponse {
  convertedRegionPrices?: Record<string, ConvertedRegionPrice>;
  convertedOtherRegionsPrice?: {
    usdPrice: Money;
    eurPrice: Money;
  };
  regionVersion?: RegionsVersion;
}

async function convertRegionPrices(
  credentials: ServiceAccountCredentials,
  packageName: string,
  price: Money
): Promise<ConvertRegionPricesResponse> {
  const response = await googlePlayFetch<ConvertRegionPricesResponse>(
    credentials,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/pricing:convertRegionPrices`,
    {
      method: 'POST',
      body: { price },
    }
  );

  if (!response.regionVersion?.version) {
    throw new Error('Google Play did not return a regionVersion from pricing:convertRegionPrices');
  }

  if (!response.convertedRegionPrices || Object.keys(response.convertedRegionPrices).length === 0) {
    throw new Error('Google Play did not return regional prices from pricing:convertRegionPrices');
  }

  return response;
}

function moneyCacheKey(price: Money): string {
  return `${price.currencyCode}:${price.units}:${price.nanos ?? 0}`;
}

/**
 * Normalize a base plan against Google's current regional pricing metadata.
 *
 * Subscription GET responses do not contain the regions version required by
 * subscription PATCH. pricing:convertRegionPrices does, and also provides the
 * currency currently linked to every region for that version.
 *
 * Existing prices are retained when their currency is still current. If a
 * region has migrated currencies (for example an old AR/ARS configuration),
 * Google converts that exact old price into the region's current currency so
 * the economic value is preserved rather than silently resetting the region to
 * the US-derived default. Regions missing from the base plan are filled from
 * Google's conversion of the US base price.
 */
async function normalizeRegionalConfigsForCurrentVersion(
  credentials: ServiceAccountCredentials,
  packageName: string,
  configs: RegionalBasePlanConfig[]
): Promise<{
  regionalConfigs: RegionalBasePlanConfig[];
  regionsVersion: string;
  currentRegionPrices: Record<string, ConvertedRegionPrice>;
}> {
  const configMap = new Map(configs.map((config) => [config.regionCode, config]));
  const usConfig = configMap.get('US');

  if (!usConfig) {
    throw new Error('US price not found. Cannot resolve the current Google Play regions version.');
  }

  const currentSnapshot = await convertRegionPrices(credentials, packageName, usConfig.price);
  const currentRegionPrices = currentSnapshot.convertedRegionPrices!;
  const conversionCache = new Map<string, Promise<ConvertRegionPricesResponse>>();

  const convertExistingPrice = (price: Money): Promise<ConvertRegionPricesResponse> => {
    const key = moneyCacheKey(price);
    const cached = conversionCache.get(key);
    if (cached) {
      return cached;
    }

    const request = convertRegionPrices(credentials, packageName, price);
    conversionCache.set(key, request);
    return request;
  };

  const normalizedConfigs: RegionalBasePlanConfig[] = [];

  for (const [regionCode, currentRegionPrice] of Object.entries(currentRegionPrices)) {
    const existing = configMap.get(regionCode);
    let price = currentRegionPrice.price;

    if (existing) {
      if (existing.price.currencyCode === currentRegionPrice.price.currencyCode) {
        price = existing.price;
      } else {
        try {
          const convertedExisting = await convertExistingPrice(existing.price);
          const convertedForRegion = convertedExisting.convertedRegionPrices?.[regionCode];

          if (
            convertedForRegion?.price &&
            convertedForRegion.price.currencyCode === currentRegionPrice.price.currencyCode
          ) {
            price = convertedForRegion.price;
          } else {
            console.warn(
              `Could not preserve ${regionCode} price while migrating ${existing.price.currencyCode} → ${currentRegionPrice.price.currencyCode}; using Google's current converted base price.`
            );
          }
        } catch (error) {
          console.warn(
            `Could not convert legacy ${regionCode}/${existing.price.currencyCode} price; using Google's current converted base price.`,
            error
          );
        }
      }
    }

    normalizedConfigs.push({
      ...existing,
      regionCode,
      price,
      newSubscriberAvailability: true,
    });
  }

  return {
    regionalConfigs: normalizedConfigs,
    regionsVersion: currentSnapshot.regionVersion!.version,
    currentRegionPrices,
  };
}

/**
 * Sanitize untargeted base plans in the same subscription against the current regions version.
 * Google Play validates all base plans on PATCH. Any base plan retaining legacy currencies
 * (e.g. ARS for AR) or non-billable regions (e.g. ET) will fail the entire PATCH request.
 */
function sanitizeBasePlanForCurrentVersion(
  bp: BasePlan,
  currentRegionPrices: Record<string, ConvertedRegionPrice>
): BasePlan {
  if (!bp.regionalConfigs || bp.regionalConfigs.length === 0) {
    return bp;
  }

  const sanitizedConfigs: RegionalBasePlanConfig[] = [];
  for (const config of bp.regionalConfigs) {
    const currentRegion = currentRegionPrices[config.regionCode];
    // Drop regions that are not billable in the current regionsVersion (e.g. ET)
    if (!currentRegion) {
      continue;
    }

    let price = config.price;
    // If currency does not match the current region's required currency (e.g. ARS -> USD for AR),
    // update to current region's converted price
    if (price.currencyCode !== currentRegion.price.currencyCode) {
      price = currentRegion.price;
    }

    sanitizedConfigs.push({
      ...config,
      price,
    });
  }

  return {
    ...bp,
    regionalConfigs: sanitizedConfigs,
  };
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
    return await googlePlayFetch<Subscription>(
      credentials,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions/${encodeURIComponent(productId)}`
    );
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

  const configMap = new Map<string, RegionalBasePlanConfig>();

  for (const config of basePlan.regionalConfigs || []) {
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

  if (!configMap.has('US')) {
    throw new Error(`US price not found for base plan ${basePlanId}. Cannot calculate regional prices without a base USD price.`);
  }

  const { regionalConfigs: updatedConfigs, regionsVersion, currentRegionPrices } =
    await normalizeRegionalConfigsForCurrentVersion(
      credentials,
      packageName,
      Array.from(configMap.values())
    );

  const updatedBasePlans = subscription.basePlans?.map(bp => {
    if (bp.basePlanId === basePlanId) {
      return {
        ...bp,
        regionalConfigs: updatedConfigs,
      };
    }
    return sanitizeBasePlanForCurrentVersion(bp, currentRegionPrices);
  });

  const requestBody: SubscriptionUpdateRequestBody = {
    packageName,
    productId,
    basePlans: updatedBasePlans,
  };

  const response = await googlePlayFetch<Subscription>(
    credentials,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions/${encodeURIComponent(productId)}`,
    {
      method: 'PATCH',
      query: {
        'regionsVersion.version': regionsVersion,
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

  if (!filteredConfigs.some((config) => config.regionCode === 'US')) {
    throw new Error(`US price not found for base plan ${basePlanId}. Cannot calculate regional prices without a base USD price.`);
  }

  const { regionalConfigs: updatedConfigs, regionsVersion, currentRegionPrices } =
    await normalizeRegionalConfigsForCurrentVersion(
      credentials,
      packageName,
      filteredConfigs
    );

  const updatedBasePlans = subscription.basePlans?.map(bp => {
    if (bp.basePlanId === basePlanId) {
      return {
        ...bp,
        regionalConfigs: updatedConfigs,
      };
    }
    return sanitizeBasePlanForCurrentVersion(bp, currentRegionPrices);
  });

  const deleteRequestBody: SubscriptionUpdateRequestBody = {
    packageName,
    productId,
    basePlans: updatedBasePlans,
  };

  const response = await googlePlayFetch<Subscription>(
    credentials,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions/${encodeURIComponent(productId)}`,
    {
      method: 'PATCH',
      query: {
        'regionsVersion.version': regionsVersion,
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
