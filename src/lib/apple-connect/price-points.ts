// Subscription price points read by territory, for snapping plans to the
// prices Apple actually accepts. Territories come from the `territory`
// relationship, never from decoding Apple's base64 IDs.

import type { AppleConnectCredentials, AppleSubscriptionPricePoint, AppleTerritory } from './types';
import { appleListPages } from './pagination';
import { APPLE_PRICE_POINT_PAGE_LIMIT } from './subscriptions';
import type { RequestContext } from '../utils/request-budget';
import { toApiError } from '../utils/api-error';

export interface TerritoryPricePoint {
  id: string;
  /** alpha-3 territory ID */
  territory: string;
  currency?: string;
  customerPrice: string;
  proceeds: string;
}

/**
 * Territories per request when reading several ladders at once. App Store
 * Connect documents filter[territory] as a list; the comma-separated form is
 * the API's usual encoding for list filters (not confirmed for this endpoint
 * in Apple's docs, see docs/plan-files.md). Each ladder has up to ~800
 * points, so 10 territories fit in one 8000-point page.
 */
export const TERRITORIES_PER_LADDER_REQUEST = 10;

function collect(
  page: { data: AppleSubscriptionPricePoint[]; included?: unknown[] },
  into: Map<string, TerritoryPricePoint[]>,
  currencies: Map<string, string>
): void {
  for (const item of (page.included ?? []) as AppleTerritory[]) {
    if (item.type === 'territories' && item.attributes?.currency) currencies.set(item.id, item.attributes.currency);
  }
  for (const point of page.data) {
    const territory = point.relationships?.territory?.data?.id;
    if (!territory) continue; // can't place it safely
    const list = into.get(territory) ?? [];
    list.push({
      id: point.id,
      territory,
      customerPrice: point.attributes.customerPrice,
      proceeds: point.attributes.proceeds,
    });
    into.set(territory, list);
  }
}

/**
 * Every price point of a subscription in each of `territories` (alpha-3),
 * with each territory's currency. Reads up to TERRITORIES_PER_LADDER_REQUEST
 * territories per request.
 */
export async function listSubscriptionPricePointsByTerritory(
  credentials: AppleConnectCredentials,
  subscriptionId: string,
  territories: string[],
  ctx: RequestContext = {},
  options: { territoriesPerRequest?: number } = {}
): Promise<Map<string, TerritoryPricePoint[]>> {
  const perRequest = Math.max(1, options.territoriesPerRequest ?? TERRITORIES_PER_LADDER_REQUEST);
  const byTerritory = new Map<string, TerritoryPricePoint[]>();
  const currencies = new Map<string, string>();
  const unique = [...new Set(territories)];
  try {
    for (let i = 0; i < unique.length; i += perRequest) {
      const chunk = unique.slice(i, i + perRequest);
      for await (const page of appleListPages<AppleSubscriptionPricePoint>(credentials, `/subscriptions/${subscriptionId}/pricePoints`, {
        queryParams: {
          'filter[territory]': chunk.join(','),
          include: 'territory',
          'fields[subscriptionPricePoints]': 'customerPrice,proceeds,territory',
          'fields[territories]': 'currency',
          limit: String(APPLE_PRICE_POINT_PAGE_LIMIT),
        },
        budget: ctx.budget,
      })) {
        collect(page, byTerritory, currencies);
      }
    }
  } catch (error) {
    throw toApiError(error, 'apple');
  }
  for (const [territory, points] of byTerritory) {
    const currency = currencies.get(territory);
    if (currency) for (const point of points) point.currency = currency;
  }
  return byTerritory;
}

/**
 * Apple's equivalent of one price point in other territories
 * (GET /v1/subscriptionPricePoints/{id}/equalizations). This is Apple's own
 * equalisation of a single price, so it fits plans that want "the same tier
 * everywhere"; per-territory targets (PPP, percent of each territory's own
 * price) need the full ladders from listSubscriptionPricePointsByTerritory.
 */
export async function getSubscriptionPricePointEqualizations(
  credentials: AppleConnectCredentials,
  pricePointId: string,
  options: { territories?: string[] } = {},
  ctx: RequestContext = {}
): Promise<TerritoryPricePoint[]> {
  const byTerritory = new Map<string, TerritoryPricePoint[]>();
  const currencies = new Map<string, string>();
  try {
    for await (const page of appleListPages<AppleSubscriptionPricePoint>(
      credentials,
      `/subscriptionPricePoints/${encodeURIComponent(pricePointId)}/equalizations`,
      {
        queryParams: {
          ...(options.territories?.length ? { 'filter[territory]': options.territories.join(',') } : {}),
          include: 'territory',
          'fields[subscriptionPricePoints]': 'customerPrice,proceeds,territory',
          'fields[territories]': 'currency',
          limit: String(APPLE_PRICE_POINT_PAGE_LIMIT),
        },
        budget: ctx.budget,
      }
    )) {
      collect(page, byTerritory, currencies);
    }
  } catch (error) {
    throw toApiError(error, 'apple');
  }
  return [...byTerritory.values()].flat().map((p) => ({ ...p, currency: currencies.get(p.territory) }));
}
