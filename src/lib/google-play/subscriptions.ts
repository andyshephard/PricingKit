import { googlePlayFetch } from './client';
import { convertRegionPrices } from './pricing';
import { ApiError } from '../utils/api-error';
import type { RequestContext } from '../utils/request-budget';
import type {
  ServiceAccountCredentials,
  Subscription,
  BasePlan,
  RegionalBasePlanConfig,
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

/** Where a base plan PATCH gets `regionsVersion.version` from */
export interface RegionsVersionOptions {
  /** The version to send (e.g. the one recorded in a reviewed plan) */
  regionsVersion?: string;
}

/**
 * Play's current regions version, from a price conversion's `regionVersion`
 * (a read-only POST). The Subscription resource has no regionsVersion field
 * in the Android Publisher v3 discovery document, so it can't come from there.
 * Undefined when Play reports none.
 */
export async function fetchCurrentRegionsVersion(
  credentials: ServiceAccountCredentials,
  packageName: string,
  ctx: RequestContext = {}
): Promise<string | undefined> {
  const response = await convertRegionPrices(credentials, packageName, { currencyCode: 'USD', units: '1' }, ctx);
  const version = response?.regionVersion?.version;
  return typeof version === 'string' && version ? version : undefined;
}

/**
 * `regionsVersion.version` for a base plan PATCH, which Google requires:
 * the caller's (a plan's recorded version), else one the resource reports
 * (none does today), else Play's current one from a price conversion. Never a
 * hard-coded guess: if Play reports none, the edit is refused.
 */
async function resolveRegionsVersion(
  credentials: ServiceAccountCredentials,
  packageName: string,
  subscription: GoogleApiSubscription,
  options: RegionsVersionOptions,
  ctx: RequestContext
): Promise<string> {
  const version = options.regionsVersion ?? subscription.regionsVersion?.version ?? (await fetchCurrentRegionsVersion(credentials, packageName, ctx));
  if (!version) {
    throw new ApiError('Google Play reported no regions version, which a base plan price edit needs; nothing was changed', {
      status: 422,
      code: 'NO_REGIONS_VERSION',
      platform: 'google',
      retryable: false,
    });
  }
  return version;
}

async function patchBasePlanRegionalConfigs(
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string,
  subscription: GoogleApiSubscription,
  basePlanId: string,
  regionalConfigs: RegionalBasePlanConfig[],
  ctx: RequestContext = {},
  options: RegionsVersionOptions = {}
): Promise<GoogleApiSubscription> {
  const regionsVersion = await resolveRegionsVersion(credentials, packageName, subscription, options, ctx);
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
      budget: ctx.budget,
      method: 'PATCH',
      query: {
        'regionsVersion.version': regionsVersion,
        updateMask: 'basePlans',
      },
      body: requestBody,
    }
  );
}

export async function listSubscriptions(
  credentials: ServiceAccountCredentials,
  packageName: string,
  ctx: RequestContext = {}
): Promise<Subscription[]> {
  const subscriptions: Subscription[] = [];
  let pageToken: string | undefined;

  do {
    const response = await googlePlayFetch<SubscriptionListResponse>(
      credentials,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions`,
      {
        budget: ctx.budget,
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
  productId: string,
  ctx: RequestContext = {}
): Promise<Subscription | null> {
  try {
    const subscription = await googlePlayFetch<GoogleApiSubscription>(
      credentials,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions/${encodeURIComponent(productId)}`,
      { budget: ctx.budget }
    );

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
  basePlanId: string,
  ctx: RequestContext = {}
): Promise<BasePlan | null> {
  const subscription = await getSubscription(credentials, packageName, productId, ctx);
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
  regionalConfigs: RegionalBasePlanConfig[],
  ctx: RequestContext = {},
  options: RegionsVersionOptions = {}
): Promise<BasePlan> {
  const subscription = await getSubscription(credentials, packageName, productId, ctx);
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
    updatedConfigs,
    ctx,
    options
  );

  return response.basePlans?.find(bp => bp.basePlanId === basePlanId) || basePlan;
}

export async function deleteBasePlanRegionPrice(
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string,
  basePlanId: string,
  regionCode: string,
  ctx: RequestContext = {},
  options: RegionsVersionOptions = {}
): Promise<BasePlan> {
  const subscription = await getSubscription(credentials, packageName, productId, ctx);
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
    filteredConfigs,
    ctx,
    options
  );

  return response.basePlans?.find(bp => bp.basePlanId === basePlanId) || basePlan;
}
