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

// List all subscription groups for an app
export async function listSubscriptionGroups(
  credentials: AppleConnectCredentials
): Promise<NormalizedAppleSubscriptionGroup[]> {
  console.log('[Apple] listSubscriptionGroups - Starting for bundleId:', credentials.bundleId);

  const appId = await getAppIdForBundleId(credentials);
  if (!appId) {
    console.error('[Apple] listSubscriptionGroups - No app ID found');
    throw new Error(`App with Bundle ID "${credentials.bundleId}" not found`);
  }

  console.log('[Apple] listSubscriptionGroups - Got app ID:', appId);

  const allGroups: NormalizedAppleSubscriptionGroup[] = [];
  let nextUrl: string | null = `/apps/${appId}/subscriptionGroups`;

  const queryParams = {
    limit: '200',
    'fields[subscriptionGroups]': 'referenceName',
  };

  // First, get all subscription groups
  while (nextUrl) {
    const currentUrl = nextUrl;
    const endpoint: string = currentUrl.startsWith('http')
      ? new URL(currentUrl).pathname.replace('/v1', '')
      : currentUrl;

    console.log('[Apple] listSubscriptionGroups - Fetching groups from:', endpoint);

    const response: AppleApiListResponse<AppleSubscriptionGroup> = await appleApiRequest<
      AppleApiListResponse<AppleSubscriptionGroup>
    >(credentials, endpoint, {
      queryParams: currentUrl.includes('?') ? undefined : queryParams,
    });

    console.log('[Apple] listSubscriptionGroups - Found', response.data?.length ?? 0, 'groups');

    // For each group, fetch its subscriptions directly
    for (const group of response.data) {
      console.log('[Apple] listSubscriptionGroups - Fetching subscriptions for group:', group.attributes.referenceName);

      const groupSubs = await fetchGroupSubscriptions(credentials, group.id, group.attributes.referenceName);

      allGroups.push({
        id: group.id,
        name: group.attributes.referenceName,
        subscriptions: groupSubs,
      });
    }

    nextUrl = response.links?.next ?? null;
  }

  console.log('[Apple] listSubscriptionGroups - Total groups found:', allGroups.length);
  console.log('[Apple] listSubscriptionGroups - Total subscriptions:', allGroups.reduce((acc, g) => acc + g.subscriptions.length, 0));
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

  while (nextUrl) {
    const currentUrl = nextUrl;
    const endpoint: string = currentUrl.startsWith('http')
      ? new URL(currentUrl).pathname.replace('/v1', '')
      : currentUrl;

    const response: AppleApiListResponse<AppleSubscription> = await appleApiRequest<
      AppleApiListResponse<AppleSubscription>
    >(credentials, endpoint, {
      queryParams: currentUrl.includes('?') ? undefined : queryParams,
    });

    console.log('[Apple] fetchGroupSubscriptions - Found', response.data?.length ?? 0, 'subscriptions in group', groupName);

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

  // Note: Prices are not fetched here for performance reasons.
  // The list view will show "—" for base price. Prices are fetched
  // on the detail view via getSubscriptionDetails or getSubscriptionPrices.

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

// Helper to decode subscription price ID (base64 encoded JSON)
function decodeSubscriptionPriceId(encodedId: string): { subscriptionId?: string; territoryCode?: string; priceTier?: string } | null {
  try {
    const decoded = Buffer.from(encodedId, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    return {
      subscriptionId: parsed.a,  // "a" is the subscription ID
      territoryCode: parsed.c,   // "c" is the territory code (e.g., "AE", "US")
      priceTier: parsed.p,       // "p" is the price tier reference
    };
  } catch {
    return null;
  }
}

// Get prices for a subscription
export async function getSubscriptionPrices(
  credentials: AppleConnectCredentials,
  subscriptionId: string
): Promise<Record<string, AppleProductPrice>> {
  try {
    const response = await appleApiRequest<
      AppleApiListResponse<{
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
      }>
    >(credentials, `/subscriptions/${subscriptionId}/prices`, {
      queryParams: {
        include: 'subscriptionPricePoint,territory',
        limit: '200',
        'fields[subscriptionPrices]': 'startDate,preserved',
        'fields[subscriptionPricePoints]': 'customerPrice,proceeds',
        'fields[territories]': 'currency',
      },
    });

    const prices: Record<string, AppleProductPrice> = {};

    // Build lookups from included data
    // Price points are keyed by their encoded ID which contains territory info
    const pricePointsByTerritory = new Map<
      string,
      { id: string; customerPrice: string; proceeds: string }
    >();
    const territories = new Map<string, { currency: string }>();

    if (response.included) {
      for (const item of response.included) {
        if (item.type === 'subscriptionPricePoints') {
          const pp = item as AppleSubscriptionPricePoint;
          // Decode the price point ID to get the territory code
          const decoded = decodeSubscriptionPriceId(pp.id);
          if (decoded?.territoryCode) {
            pricePointsByTerritory.set(decoded.territoryCode, {
              id: pp.id,
              customerPrice: pp.attributes.customerPrice,
              proceeds: pp.attributes.proceeds,
            });
          }
        } else if (item.type === 'territories') {
          const territory = item as AppleTerritory;
          territories.set(territory.id, {
            currency: territory.attributes.currency,
          });
        }
      }
    }

    // Process prices - decode the price ID to get territory code
    for (const price of response.data) {
      const decoded = decodeSubscriptionPriceId(price.id);
      if (!decoded?.territoryCode) continue;

      const territoryCode = decoded.territoryCode;
      const territory = territories.get(territoryCode);
      const pricePoint = pricePointsByTerritory.get(territoryCode);

      if (pricePoint) {
        prices[territoryCode] = {
          territoryCode: territoryCode,
          currency: territory?.currency ?? 'USD',
          customerPrice: pricePoint.customerPrice,
          proceeds: pricePoint.proceeds,
          pricePointId: pricePoint.id,
        };
      }
    }

    return prices;
  } catch {
    return {};
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
