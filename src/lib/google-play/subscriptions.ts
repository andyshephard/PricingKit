import { googlePlayFetch } from './client';
import type {
  ServiceAccountCredentials,
  Subscription,
  BasePlan,
  RegionalBasePlanConfig,
  Money,
  RegionsVersion,
} from './types';

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
 * Fallback regions version, used ONLY when the subscription resource we fetched
 * has no `regionsVersion` of its own. Format: YYYY/MM.
 *
 * Google requires `regionsVersion.version` on every base plan price PATCH. We
 * always prefer the version the resource already reports so a price edit never
 * silently migrates the product onto a newer region set.
 */
export const FALLBACK_SUBSCRIPTION_REGIONS_VERSION = '2025/03';

/** @deprecated Prefer the subscription's own regionsVersion; this is only the fallback. */
export function getLatestRegionsVersion(): string {
  return FALLBACK_SUBSCRIPTION_REGIONS_VERSION;
}

function resolveRegionsVersion(subscription: GoogleApiSubscription, productId: string): string {
  if (subscription.regionsVersion?.version) {
    return subscription.regionsVersion.version;
  }
  console.warn(
    `Subscription ${productId} has no regionsVersion; falling back to ${FALLBACK_SUBSCRIPTION_REGIONS_VERSION}`
  );
  return FALLBACK_SUBSCRIPTION_REGIONS_VERSION;
}

async function patchBasePlanRegionalConfigs(
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string,
  subscription: GoogleApiSubscription,
  basePlanId: string,
  regionalConfigs: RegionalBasePlanConfig[]
): Promise<GoogleApiSubscription> {
  // Only the target base plan's regionalConfigs change. Every other field
  // (including otherRegionsConfig) and every other base plan is sent back
  // exactly as fetched, because updateMask=basePlans replaces the whole list.
  const updatedBasePlans = subscription.basePlans?.map(bp =>
    bp.basePlanId === basePlanId ? { ...bp, regionalConfigs } : bp
  );

  const requestBody: SubscriptionUpdateRequestBody = {
    packageName,
    productId,
    basePlans: updatedBasePlans,
  };

  return googlePlayFetch<GoogleApiSubscription>(
    credentials,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions/${encodeURIComponent(productId)}`,
    {
      method: 'PATCH',
      query: {
        'regionsVersion.version': resolveRegionsVersion(subscription, productId),
        updateMask: 'basePlans',
      },
      body: requestBody,
    }
  );
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

  // Change only the regions the caller passed in. Existing regions keep their
  // position, availability and any other fields; regions not in the request
  // are sent back as fetched. No fill-in of unconfigured regions: if Google
  // needs more (e.g. a USD/EUR price backing otherRegionsConfig), its own
  // validation error is surfaced instead of us guessing prices.
  const incoming = new Map<string, RegionalBasePlanConfig>();
  for (const config of regionalConfigs) {
    incoming.set(config.regionCode, config);
  }

  const updatedConfigs: RegionalBasePlanConfig[] = (basePlan.regionalConfigs || []).map(existing => {
    const update = incoming.get(existing.regionCode);
    if (!update) {
      return existing;
    }
    incoming.delete(existing.regionCode);
    return {
      ...existing,
      price: update.price,
      newSubscriberAvailability: update.newSubscriberAvailability ?? existing.newSubscriberAvailability,
    };
  });

  // Regions not yet configured on the base plan: open to new subscribers
  // unless the caller says otherwise.
  for (const config of incoming.values()) {
    updatedConfigs.push({
      ...config,
      newSubscriberAvailability: config.newSubscriberAvailability ?? true,
    });
  }

  const response = await patchBasePlanRegionalConfigs(
    credentials,
    packageName,
    productId,
    subscription,
    basePlanId,
    updatedConfigs
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

  const existingConfigs = basePlan.regionalConfigs || [];
  if (!existingConfigs.some(config => config.regionCode === regionCode)) {
    throw Object.assign(
      new Error(`Region ${regionCode} is not configured on base plan ${basePlanId}`),
      { code: 404 }
    );
  }

  // Remove exactly this region; every other region is sent back unchanged and
  // nothing is filled in. Google may refuse (e.g. a region that still has
  // subscribers, or the last USD/EUR price backing otherRegionsConfig); that
  // error propagates as-is so the user sees Google's reason.
  const filteredConfigs = existingConfigs.filter(config => config.regionCode !== regionCode);

  const response = await patchBasePlanRegionalConfigs(
    credentials,
    packageName,
    productId,
    subscription,
    basePlanId,
    filteredConfigs
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
