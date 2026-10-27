import type {
  AppleConnectCredentials,
  AppleSubscriptionGroup,
  AppleSubscription,
  AppleApiListResponse,
  AppleApiResponse,
  NormalizedAppleSubscription,
  NormalizedAppleSubscriptionGroup,
  AppleProductPrice,
  AppleSubscriptionLocalization,
  AppleSubscriptionPricePoint,
  AppleTerritory,
} from './types';
import { appleApiRequest, getAppIdForBundleId } from './client';
import { appleListPages } from './pagination';
import { alpha2ToAlpha3, alpha3ToAlpha2 } from './territories';
import { ApiError, getErrorStatus, toApiError } from '../utils/api-error';
import { executeWithRateLimit, type RateLimitOptions } from '../utils/rate-limit';
import type { RequestBudget, RequestContext } from '../utils/request-budget';

// List all subscription groups for an app
export async function listSubscriptionGroups(
  credentials: AppleConnectCredentials,
  ctx: RequestContext = {}
): Promise<NormalizedAppleSubscriptionGroup[]> {
  // console.log('[Apple] listSubscriptionGroups - Starting for bundleId:', credentials.bundleId);

  const appId = await getAppIdForBundleId(credentials, ctx);
  if (!appId) {
    console.error('[Apple] listSubscriptionGroups - No app ID found');
    throw new ApiError(`App with Bundle ID "${credentials.bundleId}" not found`, {
      status: 404,
      code: 'APP_NOT_FOUND',
      platform: 'apple',
    });
  }

  // console.log('[Apple] listSubscriptionGroups - Got app ID:', appId);

  const allGroups: NormalizedAppleSubscriptionGroup[] = [];

  const queryParams = {
    limit: '200',
    'fields[subscriptionGroups]': 'referenceName',
  };

  for await (const page of appleListPages<AppleSubscriptionGroup>(
    credentials,
    `/apps/${appId}/subscriptionGroups`,
    { queryParams, budget: ctx.budget }
  )) {
    // For each group, fetch its subscriptions directly
    for (const group of page.data) {
      const groupSubs = await fetchGroupSubscriptions(credentials, group.id, group.attributes.referenceName, ctx);
      allGroups.push({
        id: group.id,
        name: group.attributes.referenceName,
        subscriptions: groupSubs,
      });
    }
  }

  // console.log('[Apple] listSubscriptionGroups - Total groups found:', allGroups.length);
  // console.log('[Apple] listSubscriptionGroups - Total subscriptions:', allGroups.reduce((acc, g) => acc + g.subscriptions.length, 0));
  return allGroups;
}

// Fetch subscriptions for a specific group
async function fetchGroupSubscriptions(
  credentials: AppleConnectCredentials,
  groupId: string,
  groupName: string,
  ctx: RequestContext = {}
): Promise<NormalizedAppleSubscription[]> {
  const subscriptions: NormalizedAppleSubscription[] = [];

  const queryParams = {
    limit: '200',
    'fields[subscriptions]': 'name,productId,state,subscriptionPeriod,groupLevel',
  };

  for await (const page of appleListPages<AppleSubscription>(
    credentials,
    `/subscriptionGroups/${groupId}/subscriptions`,
    { queryParams, budget: ctx.budget }
  )) {
    for (const sub of page.data) {
      subscriptions.push({
        id: sub.id,
        productId: sub.attributes.productId,
        name: sub.attributes.name,
        state: sub.attributes.state,
        period: sub.attributes.subscriptionPeriod,
        groupId: groupId,
        groupName: groupName,
        prices: {},
        localizations: {},
      });
    }
  }

  return subscriptions;
}

// List all subscriptions (flattened from groups)
export async function listSubscriptions(
  credentials: AppleConnectCredentials,
  ctx: RequestContext = {}
): Promise<NormalizedAppleSubscription[]> {
  const groups = await listSubscriptionGroups(credentials, ctx);
  return groups.flatMap((g) => g.subscriptions);
}

// Get a single subscription by productId.
// Returns null only when the subscription genuinely doesn't exist; API
// failures (auth, rate limit, 5xx, network) are thrown as ApiError.
export async function getSubscription(
  credentials: AppleConnectCredentials,
  productId: string,
  ctx: RequestContext = {}
): Promise<NormalizedAppleSubscription | null> {
  try {
    // Get all subscription groups to find the subscription
    // (throws APP_NOT_FOUND if the bundle ID doesn't resolve to an app)
    const groups = await listSubscriptionGroups(credentials, ctx);

    for (const group of groups) {
      const sub = group.subscriptions.find((s) => s.productId === productId);
      if (sub) {
        // Fetch additional details including localizations
        const details = await getSubscriptionDetails(credentials, sub.id, ctx);
        return details ?? sub;
      }
    }

    return null;
  } catch (error) {
    throw toApiError(error, 'apple');
  }
}

// Get subscription details with localizations
async function getSubscriptionDetails(
  credentials: AppleConnectCredentials,
  subscriptionId: string,
  ctx: RequestContext = {}
): Promise<NormalizedAppleSubscription | null> {
  try {
    // Single item endpoint returns AppleApiResponse (not list)
    const response = await appleApiRequest<
      AppleApiResponse<AppleSubscription> | AppleApiListResponse<AppleSubscription>
    >(credentials, `/subscriptions/${subscriptionId}`, {
      queryParams: {
        include: 'subscriptionLocalizations',
        'fields[subscriptions]':
          'name,productId,state,subscriptionPeriod,groupLevel,familySharable',
        'fields[subscriptionLocalizations]': 'name,description,locale',
      },
      budget: ctx.budget,
    });

    // Handle both single item response and list response
    const sub = Array.isArray(response.data)
      ? response.data[0]
      : response.data;

    if (!sub) {
      return null;
    }

    // Get localizations from included
    const localizations: Record<
      string,
      { name: string; description?: string }
    > = {};
    if (response.included) {
      for (const item of response.included) {
        if (item.type === 'subscriptionLocalizations') {
          const loc = item as AppleSubscriptionLocalization;
          localizations[loc.attributes.locale] = {
            name: loc.attributes.name,
            description: loc.attributes.description,
          };
        }
      }
    }

    return {
      id: sub.id,
      productId: sub.attributes.productId,
      name: sub.attributes.name,
      state: sub.attributes.state,
      period: sub.attributes.subscriptionPeriod,
      groupId: sub.relationships?.group?.data?.id ?? '',
      groupName: '', // Would need another call to get group name
      prices: {},
      localizations,
    };
  } catch (error) {
    // A 404 means the subscription doesn't exist; anything else is a real failure
    if (getErrorStatus(error) === 404) {
      return null;
    }
    throw toApiError(error, 'apple');
  }
}

// Get a subscription by its Apple subscription ID (numeric ID like "1234567890")
export async function getSubscriptionById(
  credentials: AppleConnectCredentials,
  subscriptionId: string,
  ctx: RequestContext = {}
): Promise<NormalizedAppleSubscription | null> {
  return getSubscriptionDetails(credentials, subscriptionId, ctx);
}

// Type for subscription price data from API
type SubscriptionPriceData = {
  id: string;
  type: string;
  attributes: {
    startDate?: string;
    preserved?: boolean;
  };
  relationships?: {
    subscriptionPricePoint?: {
      data: { id: string; type: string };
    };
    territory?: {
      data: { id: string; type: string };
    };
  };
};

// Result type for subscription prices
export interface SubscriptionPricesResult {
  current: Record<string, AppleProductPrice>;
  scheduled: Record<string, AppleProductPrice>; // Future scheduled prices by territory (most recent future price per territory)
}

// Get prices for a subscription
export async function getSubscriptionPrices(
  credentials: AppleConnectCredentials,
  subscriptionId: string,
  ctx: RequestContext = {}
): Promise<SubscriptionPricesResult> {
  try {
    const currentPrices: Record<string, AppleProductPrice> = {};
    const scheduledPrices: Record<string, AppleProductPrice> = {};

    // Build price points map by their full ID (to handle multiple per territory)
    const pricePointsById = new Map<string, { customerPrice: string; proceeds: string; territoryAlpha2: string }>();
    const territories = new Map<string, { currency: string }>();

    // Collect all price data across paginated responses
    const allPriceData: SubscriptionPriceData[] = [];

    const queryParams = {
      include: 'territory,subscriptionPricePoint',
      limit: '200',
      'fields[subscriptionPrices]': 'startDate,territory,subscriptionPricePoint',
      'fields[subscriptionPricePoints]': 'customerPrice,proceeds',
      'fields[territories]': 'currency',
    };

    for await (const response of appleListPages<SubscriptionPriceData>(
      credentials,
      `/subscriptions/${subscriptionId}/prices`,
      { queryParams, budget: ctx.budget }
    )) {
      allPriceData.push(...response.data);

      // Process included data (price points and territories)
      if (response.included) {
        for (const item of response.included) {
          if (item.type === 'subscriptionPricePoints') {
            const pp = item as AppleSubscriptionPricePoint;
            // Decode price point ID to get 3-letter territory code
            try {
              const decoded = JSON.parse(Buffer.from(pp.id, 'base64').toString('utf-8'));
              const alpha3 = decoded.t; // 3-letter code like "FRA"
              if (alpha3) {
                const alpha2 = alpha3ToAlpha2(alpha3); // Convert to "FR"
                if (alpha2) {
                  pricePointsById.set(pp.id, {
                    customerPrice: pp.attributes.customerPrice,
                    proceeds: pp.attributes.proceeds,
                    territoryAlpha2: alpha2,
                  });
                }
              }
            } catch { /* ignore decode errors */ }
          } else if (item.type === 'territories') {
            const territory = item as AppleTerritory;
            const alpha2 = alpha3ToAlpha2(territory.id);
            if (alpha2) {
              territories.set(alpha2, { currency: territory.attributes.currency });
            }
          }
        }
      }
    }

    // Separate prices into current (active) and scheduled (future)
    const now = new Date();
    const activePriceData: SubscriptionPriceData[] = [];
    const futurePriceData: SubscriptionPriceData[] = [];

    for (const price of allPriceData) {
      const startDate = price.attributes.startDate;
      if (!startDate) {
        activePriceData.push(price); // null startDate = immediate/current
      } else if (new Date(startDate) <= now) {
        activePriceData.push(price); // Already active
      } else {
        futurePriceData.push(price); // Future scheduled
      }
    }

    // Sort active prices by startDate descending (most recent first)
    // null startDate = original price, should be treated as oldest
    activePriceData.sort((a, b) => {
      const dateA = a.attributes.startDate ? new Date(a.attributes.startDate).getTime() : 0;
      const dateB = b.attributes.startDate ? new Date(b.attributes.startDate).getTime() : 0;
      return dateB - dateA; // Descending order
    });

    // Helper function to process price data into a prices record
    const processPrices = (
      priceDataList: SubscriptionPriceData[],
      targetRecord: Record<string, AppleProductPrice>,
      includeStartDate: boolean
    ) => {
      for (const price of priceDataList) {
        try {
          const decoded = JSON.parse(Buffer.from(price.id, 'base64').toString('utf-8'));
          const territoryCode = decoded.c; // 2-letter code like "US"
          if (!territoryCode) continue;

          // Skip if we already have a price for this territory (first one wins)
          if (targetRecord[territoryCode]) continue;

          // Try to get the price point ID from the relationship first
          let pricePointId = price.relationships?.subscriptionPricePoint?.data?.id;
          let pricePoint = pricePointId ? pricePointsById.get(pricePointId) : null;

          // Fallback: find price point by matching territory
          if (!pricePoint) {
            for (const [ppId, ppData] of pricePointsById) {
              if (ppData.territoryAlpha2 === territoryCode) {
                pricePointId = ppId;
                pricePoint = ppData;
                break; // Take first match for this territory
              }
            }
          }

          const territory = territories.get(territoryCode);

          if (pricePoint && pricePointId) {
            targetRecord[territoryCode] = {
              territoryCode,
              currency: territory?.currency ?? 'USD',
              customerPrice: pricePoint.customerPrice,
              proceeds: pricePoint.proceeds,
              pricePointId: pricePointId,
              subscriptionPriceId: price.id, // Include subscription price ID for deletion
              ...(includeStartDate && price.attributes.startDate
                ? { startDate: price.attributes.startDate }
                : {}),
            };
          }
        } catch { /* ignore decode errors */ }
      }
    };

    // Process current prices
    processPrices(activePriceData, currentPrices, false);

    // Process scheduled (future) prices
    processPrices(futurePriceData, scheduledPrices, true);

    // console.log('[Apple] getSubscriptionPrices - Total prices from API:', allPriceData.length);
    // console.log('[Apple] getSubscriptionPrices - Current prices:', Object.keys(currentPrices).length);
    // console.log('[Apple] getSubscriptionPrices - Scheduled prices:', Object.keys(scheduledPrices).length);
    // console.log('[Apple] getSubscriptionPrices - Price points in map:', pricePointsById.size);
    return { current: currentPrices, scheduled: scheduledPrices };
  } catch (error) {
    // Don't report "no prices" when the read failed
    console.error('[Apple] getSubscriptionPrices - Error:', error);
    throw toApiError(error, 'apple');
  }
}

/** Page size for subscription price point reads (Apple's documented maximum) */
export const APPLE_PRICE_POINT_PAGE_LIMIT = 8000;

// Get available subscription price points for a territory
export async function getSubscriptionPricePoints(
  credentials: AppleConnectCredentials,
  subscriptionId: string,
  territoryCode: string = 'USA',
  ctx: RequestContext = {}
): Promise<
  Array<{
    id: string;
    customerPrice: string;
    proceeds: string;
  }>
> {
  try {
    const allPricePoints: Array<{
      id: string;
      customerPrice: string;
      proceeds: string;
    }> = [];

    // Apple documents limit up to 8000 here: one request covers a territory's
    // whole ladder instead of ~4 pages of 200
    const queryParams = {
      'filter[territory]': territoryCode,
      limit: String(APPLE_PRICE_POINT_PAGE_LIMIT),
      'fields[subscriptionPricePoints]': 'customerPrice,proceeds',
    };

    for await (const response of appleListPages<AppleSubscriptionPricePoint>(
      credentials,
      `/subscriptions/${subscriptionId}/pricePoints`,
      { queryParams, budget: ctx.budget }
    )) {
      for (const pp of response.data) {
        allPricePoints.push({
          id: pp.id,
          customerPrice: pp.attributes.customerPrice,
          proceeds: pp.attributes.proceeds,
        });
      }
    }

    return allPricePoints;
  } catch (error) {
    // Don't report "no price points" when the read failed
    throw toApiError(error, 'apple');
  }
}

/**
 * Normalise a territory code to the alpha-3 ID Apple expects on write
 * endpoints (e.g. "US" -> "USA"). Alpha-3 codes are passed through.
 * Throws a 400 ApiError for codes that aren't Apple territories.
 */
export function toAppleTerritoryId(territoryCode: string): string {
  const code = territoryCode.trim().toUpperCase();
  if (code.length === 2) {
    const alpha3 = alpha2ToAlpha3(code);
    if (alpha3) return alpha3;
  } else if (code.length === 3 && alpha3ToAlpha2(code)) {
    return code;
  }
  throw new ApiError(`Unknown Apple territory "${territoryCode}"`, {
    status: 400,
    code: 'INVALID_TERRITORY',
    platform: 'apple',
  });
}

// Update subscription price
export async function updateSubscriptionPrice(
  credentials: AppleConnectCredentials,
  subscriptionId: string,
  pricePointId: string,
  territoryCode: string,
  startDate?: string,
  preserveCurrentPrice: boolean = true,
  ctx: RequestContext = {}
): Promise<void> {
  await appleApiRequest(credentials, `/subscriptionPrices`, {
    method: 'POST',
    budget: ctx.budget,
    body: {
      data: {
        type: 'subscriptionPrices',
        attributes: {
          startDate: startDate ?? null,
          preserveCurrentPrice: preserveCurrentPrice,
        },
        relationships: {
          subscription: {
            data: {
              id: subscriptionId,
              type: 'subscriptions',
            },
          },
          subscriptionPricePoint: {
            data: {
              id: pricePointId,
              type: 'subscriptionPricePoints',
            },
          },
          territory: {
            data: {
              // Apple territory IDs are alpha-3; callers often hold alpha-2
              id: toAppleTerritoryId(territoryCode),
              type: 'territories',
            },
          },
        },
      },
    },
  });
}

// Delete subscription price for a territory
export async function deleteSubscriptionPrice(
  credentials: AppleConnectCredentials,
  subscriptionPriceId: string,
  ctx: RequestContext = {}
): Promise<void> {
  await appleApiRequest(
    credentials,
    `/subscriptionPrices/${subscriptionPriceId}`,
    {
      method: 'DELETE',
      budget: ctx.budget,
    }
  );
}

export interface SubscriptionPriceChange {
  pricePointId: string;
  startDate?: string;
}

/** The scheduled price a change would replace, as it was before the change */
export interface ScheduledPriceSnapshot {
  subscriptionPriceId: string;
  pricePointId: string;
  startDate?: string;
  customerPrice?: string;
  currency?: string;
}

export interface TerritoryPriceOutcome {
  territoryCode: string;
  /**
   * created  - new price added, nothing replaced
   * replaced - new price added and the previous scheduled price removed
   * failed   - new price not added; any previous scheduled price is untouched
   */
  status: 'created' | 'replaced' | 'failed';
  error?: string;
  errorStatus?: number;
  previousScheduled?: ScheduledPriceSnapshot;
  /** New price exists but something non-fatal went wrong (e.g. old scheduled price left in place) */
  warning?: string;
}

function describeError(error: unknown): { message: string; status?: number } {
  const apiError = toApiError(error, 'apple');
  const detail = (apiError as { detail?: unknown }).detail;
  return {
    message: typeof detail === 'string' && detail ? detail : apiError.message,
    status: apiError.status,
  };
}

function describeScheduled(previous: ScheduledPriceSnapshot): string {
  const amount =
    previous.customerPrice !== undefined
      ? `${previous.customerPrice}${previous.currency ? ` ${previous.currency}` : ''}`
      : `price point ${previous.pricePointId}`;
  return `${amount}${previous.startDate ? ` from ${previous.startDate}` : ''}`;
}

/**
 * Apply subscription price changes per territory without ever deleting an
 * existing scheduled price before its replacement exists.
 *
 * For each territory:
 * 1. Create the new price first. If that works, delete the old scheduled
 *    price (if any) - a failed delete is reported as a warning, not a failure.
 * 2. If the create fails, nothing is deleted. Apple answers ordinary
 *    validation errors with 409 too and documents no error code specific to
 *    "a scheduled price already exists", so a 409 is never treated as a
 *    conflict to resolve by deleting. When a scheduled price exists the
 *    failure says so, and the user can clear it (Clear scheduled) and retry.
 *
 * Never throws for per-territory failures; every territory gets an outcome.
 */
export async function applySubscriptionPriceChanges(
  credentials: AppleConnectCredentials,
  subscriptionId: string,
  changes: Record<string, SubscriptionPriceChange>,
  scheduledPrices: Record<string, AppleProductPrice>,
  options: {
    preserveCurrentPrice?: boolean;
    rateLimit?: Pick<RateLimitOptions, 'concurrency' | 'delayBetweenBatches'>;
    /** Every create and delete consumes from this budget */
    budget?: RequestBudget;
    onProgress?: (completed: number, total: number) => void;
  } = {}
): Promise<TerritoryPriceOutcome[]> {
  const { preserveCurrentPrice = true } = options;
  const ctx: RequestContext = { budget: options.budget };

  const applyOne = async (
    territoryCode: string,
    { pricePointId, startDate }: SubscriptionPriceChange
  ): Promise<TerritoryPriceOutcome> => {
    const create = () =>
      updateSubscriptionPrice(
        credentials,
        subscriptionId,
        pricePointId,
        territoryCode,
        startDate,
        preserveCurrentPrice,
        ctx
      );

    // Only a future-dated change replaces the existing scheduled price
    const existing = startDate ? scheduledPrices[territoryCode] : undefined;
    const previous: ScheduledPriceSnapshot | undefined =
      existing?.subscriptionPriceId && existing.pricePointId
        ? {
            subscriptionPriceId: existing.subscriptionPriceId,
            pricePointId: existing.pricePointId,
            startDate: existing.startDate,
            customerPrice: existing.customerPrice,
            currency: existing.currency,
          }
        : undefined;

    try {
      await create();
    } catch (createError) {
      const createFailure = describeError(createError);
      // Nothing was deleted, so the previous scheduled price (if any) is untouched
      const error =
        previous && createFailure.status === 409
          ? `${createFailure.message} (a scheduled price already exists for ${territoryCode}: ${describeScheduled(previous)}. If this is the conflict, clear the scheduled price first, then apply again.)`
          : createFailure.message;
      return {
        territoryCode,
        status: 'failed',
        error,
        errorStatus: createFailure.status,
        ...(previous ? { previousScheduled: previous } : {}),
      };
    }

    if (!previous) {
      return { territoryCode, status: 'created' };
    }

    // New price exists; now it's safe to remove the one it replaces
    try {
      await deleteSubscriptionPrice(credentials, previous.subscriptionPriceId, ctx);
    } catch (deleteError) {
      // Already gone is fine; anything else leaves both prices scheduled
      if (getErrorStatus(deleteError) !== 404) {
        return {
          territoryCode,
          status: 'created',
          previousScheduled: previous,
          warning: `New price added but the previous scheduled price could not be removed: ${describeError(deleteError).message}`,
        };
      }
    }
    return { territoryCode, status: 'replaced', previousScheduled: previous };
  };

  const tasks = Object.entries(changes).map(
    ([territoryCode, change]) => () => applyOne(territoryCode, change)
  );

  // Tasks never throw; appleApiRequest retries 429 itself (never 5xx for a create)
  return executeWithRateLimit(tasks, {
    concurrency: options.rateLimit?.concurrency ?? 2,
    delayBetweenBatches: options.rateLimit?.delayBetweenBatches ?? 500,
    maxRetries: 0,
    onProgress: options.onProgress,
  });
}

// Map subscription period to human-readable string
export function formatSubscriptionPeriod(period: string): string {
  const periodMap: Record<string, string> = {
    ONE_WEEK: '1 Week',
    ONE_MONTH: '1 Month',
    TWO_MONTHS: '2 Months',
    THREE_MONTHS: '3 Months',
    SIX_MONTHS: '6 Months',
    ONE_YEAR: '1 Year',
  };
  return periodMap[period] ?? period;
}
