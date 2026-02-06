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
import { alpha3ToAlpha2 } from './territories';

// List all subscription groups for an app
export async function listSubscriptionGroups(
  credentials: AppleConnectCredentials
): Promise<NormalizedAppleSubscriptionGroup[]> {
  // console.log('[Apple] listSubscriptionGroups - Starting for bundleId:', credentials.bundleId);

  const appId = await getAppIdForBundleId(credentials);
  if (!appId) {
    console.error('[Apple] listSubscriptionGroups - No app ID found');
    throw new Error(`App with Bundle ID "${credentials.bundleId}" not found`);
  }

  // console.log('[Apple] listSubscriptionGroups - Got app ID:', appId);

  const allGroups: NormalizedAppleSubscriptionGroup[] = [];
  let nextUrl: string | null = `/apps/${appId}/subscriptionGroups`;

  const queryParams = {
    limit: '200',
    'fields[subscriptionGroups]': 'referenceName',
  };

  // First, get all subscription groups
  const MAX_PAGES = 100;
  let pageCount = 0;
  const seenUrls = new Set<string>();
  while (nextUrl) {
    if (++pageCount > MAX_PAGES) {
      console.warn('[Apple] listSubscriptionGroups - Hit max page limit, stopping pagination');
      break;
    }
    // Prevent infinite loops if the API returns the same URL
    if (seenUrls.has(nextUrl)) {
      // console.log('[Apple] listSubscriptionGroups - Breaking loop: already visited URL');
      break;
    }
    seenUrls.add(nextUrl);

    const currentUrl = nextUrl;
    let endpoint: string;
    let useInitialQueryParams: boolean;

    if (currentUrl.startsWith('http')) {
      const parsedUrl = new URL(currentUrl);
      endpoint = parsedUrl.pathname.replace('/v1', '');
      if (parsedUrl.search) {
        endpoint += parsedUrl.search;
        useInitialQueryParams = false;
      } else {
        useInitialQueryParams = true;
      }
    } else {
      endpoint = currentUrl;
      useInitialQueryParams = !currentUrl.includes('?');
    }

    // console.log('[Apple] listSubscriptionGroups - Fetching groups from:', endpoint);

    const response: AppleApiListResponse<AppleSubscriptionGroup> = await appleApiRequest<
      AppleApiListResponse<AppleSubscriptionGroup>
    >(credentials, endpoint, {
      queryParams: useInitialQueryParams ? queryParams : undefined,
    });

    // console.log('[Apple] listSubscriptionGroups - Found', response.data?.length ?? 0, 'groups');

    // For each group, fetch its subscriptions directly
    for (const group of response.data) {
      // console.log('[Apple] listSubscriptionGroups - Fetching subscriptions for group:', group.attributes.referenceName);

      const groupSubs = await fetchGroupSubscriptions(credentials, group.id, group.attributes.referenceName);

      allGroups.push({
        id: group.id,
        name: group.attributes.referenceName,
        subscriptions: groupSubs,
      });
    }

    nextUrl = response.links?.next ?? null;
  }

  // console.log('[Apple] listSubscriptionGroups - Total groups found:', allGroups.length);
  // console.log('[Apple] listSubscriptionGroups - Total subscriptions:', allGroups.reduce((acc, g) => acc + g.subscriptions.length, 0));
  return allGroups;
}

// Fetch subscriptions for a specific group
async function fetchGroupSubscriptions(
  credentials: AppleConnectCredentials,
  groupId: string,
  groupName: string
): Promise<NormalizedAppleSubscription[]> {
  const subscriptions: NormalizedAppleSubscription[] = [];
  let nextUrl: string | null = `/subscriptionGroups/${groupId}/subscriptions`;

  const queryParams = {
    limit: '200',
    'fields[subscriptions]': 'name,productId,state,subscriptionPeriod,groupLevel',
  };

  const MAX_SUB_PAGES = 100;
  let subPageCount = 0;
  const seenUrls = new Set<string>();
  while (nextUrl) {
    if (++subPageCount > MAX_SUB_PAGES) {
      console.warn(`[Apple] fetchGroupSubscriptions - Hit max page limit for group ${groupName}`);
      break;
    }
    // Prevent infinite loops if the API returns the same URL
    if (seenUrls.has(nextUrl)) {
      break;
    }
    seenUrls.add(nextUrl);

    const currentUrl = nextUrl;
    let endpoint: string;
    let useInitialQueryParams: boolean;

    if (currentUrl.startsWith('http')) {
      const parsedUrl = new URL(currentUrl);
      endpoint = parsedUrl.pathname.replace('/v1', '');
      if (parsedUrl.search) {
        endpoint += parsedUrl.search;
        useInitialQueryParams = false;
      } else {
        useInitialQueryParams = true;
      }
    } else {
      endpoint = currentUrl;
      useInitialQueryParams = !currentUrl.includes('?');
    }

    const response: AppleApiListResponse<AppleSubscription> = await appleApiRequest<
      AppleApiListResponse<AppleSubscription>
    >(credentials, endpoint, {
      queryParams: useInitialQueryParams ? queryParams : undefined,
    });

    // console.log('[Apple] fetchGroupSubscriptions - Found', response.data?.length ?? 0, 'subscriptions in group', groupName);

    for (const sub of response.data) {
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

    nextUrl = response.links?.next ?? null;
  }

  return subscriptions;
}

// List all subscriptions (flattened from groups)
export async function listSubscriptions(
  credentials: AppleConnectCredentials
): Promise<NormalizedAppleSubscription[]> {
  const groups = await listSubscriptionGroups(credentials);
  return groups.flatMap((g) => g.subscriptions);
}

// Get a single subscription by productId
export async function getSubscription(
  credentials: AppleConnectCredentials,
  productId: string
): Promise<NormalizedAppleSubscription | null> {
  try {
    const appId = await getAppIdForBundleId(credentials);
    if (!appId) {
      return null;
    }

    // First, get all subscription groups to find the subscription
    const groups = await listSubscriptionGroups(credentials);

    for (const group of groups) {
      const sub = group.subscriptions.find((s) => s.productId === productId);
      if (sub) {
        // Fetch additional details including localizations
        const details = await getSubscriptionDetails(credentials, sub.id);
        return details ?? sub;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Get subscription details with localizations
async function getSubscriptionDetails(
  credentials: AppleConnectCredentials,
  subscriptionId: string
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
  } catch {
    return null;
  }
}

// Get a subscription by its Apple subscription ID (numeric ID like "6746950587")
export async function getSubscriptionById(
  credentials: AppleConnectCredentials,
  subscriptionId: string
): Promise<NormalizedAppleSubscription | null> {
  return getSubscriptionDetails(credentials, subscriptionId);
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
  subscriptionId: string
): Promise<SubscriptionPricesResult> {
  try {
    const currentPrices: Record<string, AppleProductPrice> = {};
    const scheduledPrices: Record<string, AppleProductPrice> = {};

    // Build price points map by their full ID (to handle multiple per territory)
    const pricePointsById = new Map<string, { customerPrice: string; proceeds: string; territoryAlpha2: string }>();
    const territories = new Map<string, { currency: string }>();

    // Collect all price data across paginated responses
    const allPriceData: SubscriptionPriceData[] = [];

    let nextUrl: string | null = `/subscriptions/${subscriptionId}/prices`;
    const queryParams = {
      include: 'territory,subscriptionPricePoint',
      limit: '200',
      'fields[subscriptionPrices]': 'startDate,territory,subscriptionPricePoint',
      'fields[subscriptionPricePoints]': 'customerPrice,proceeds',
      'fields[territories]': 'currency',
    };

    // Paginate through all prices
    const MAX_PRICE_PAGES = 100;
    let pricePageCount = 0;
    const seenUrls = new Set<string>();
    while (nextUrl) {
      if (++pricePageCount > MAX_PRICE_PAGES) {
        console.warn('[Apple] getSubscriptionPrices - Hit max page limit, stopping pagination');
        break;
      }
      // Prevent infinite loops if the API returns the same URL
      if (seenUrls.has(nextUrl)) {
        break;
      }
      seenUrls.add(nextUrl);

      const currentUrl: string = nextUrl;
      let endpoint: string;
      let useInitialQueryParams: boolean;

      if (currentUrl.startsWith('http')) {
        // Full URL from pagination - extract path and preserve any query params
        const parsedUrl = new URL(currentUrl);
        endpoint = parsedUrl.pathname.replace('/v1', '');
        // If the pagination URL has query params (like cursor), use it as-is
        // by appending the search params to the endpoint
        if (parsedUrl.search) {
          endpoint += parsedUrl.search;
          useInitialQueryParams = false;
        } else {
          useInitialQueryParams = true;
        }
      } else {
        endpoint = currentUrl;
        useInitialQueryParams = !currentUrl.includes('?');
      }

      const response: AppleApiListResponse<SubscriptionPriceData> = await appleApiRequest<
        AppleApiListResponse<SubscriptionPriceData>
      >(credentials, endpoint, {
        queryParams: useInitialQueryParams ? queryParams : undefined,
      });

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

      nextUrl = response.links?.next ?? null;
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
    console.error('[Apple] getSubscriptionPrices - Error:', error);
    return { current: {}, scheduled: {} };
  }
}

// Get available subscription price points for a territory
export async function getSubscriptionPricePoints(
  credentials: AppleConnectCredentials,
  subscriptionId: string,
  territoryCode: string = 'USA'
): Promise<
  Array<{
    id: string;
    customerPrice: string;
    proceeds: string;
  }>
> {
  try {
    const response = await appleApiRequest<
      AppleApiListResponse<AppleSubscriptionPricePoint>
    >(credentials, `/subscriptions/${subscriptionId}/pricePoints`, {
      queryParams: {
        'filter[territory]': territoryCode,
        limit: '200',
        'fields[subscriptionPricePoints]': 'customerPrice,proceeds',
      },
    });

    return response.data.map((pp) => ({
      id: pp.id,
      customerPrice: pp.attributes.customerPrice,
      proceeds: pp.attributes.proceeds,
    }));
  } catch {
    return [];
  }
}

// Update subscription price
export async function updateSubscriptionPrice(
  credentials: AppleConnectCredentials,
  subscriptionId: string,
  pricePointId: string,
  territoryCode: string,
  startDate?: string
): Promise<void> {
  await appleApiRequest(credentials, `/subscriptionPrices`, {
    method: 'POST',
    body: {
      data: {
        type: 'subscriptionPrices',
        attributes: {
          startDate: startDate ?? null,
          preserveCurrentPrice: false,
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
              id: territoryCode,
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
  subscriptionPriceId: string
): Promise<void> {
  await appleApiRequest(
    credentials,
    `/subscriptionPrices/${subscriptionPriceId}`,
    {
      method: 'DELETE',
    }
  );
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
