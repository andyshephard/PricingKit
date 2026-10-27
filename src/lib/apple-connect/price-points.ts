// Subscription price points read by territory, for snapping plans to the
// prices Apple actually accepts. Territories come from the `territory`
// relationship, never from decoding Apple's base64 IDs.

import type { AppleConnectCredentials, AppleSubscriptionPricePoint, AppleTerritory } from './types';
import { appleListAll, appleListPages } from './pagination';
import { alpha3ToAlpha2 } from './territories';
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
 * in Apple's docs). Each ladder has up to ~800
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
      for await (const page of appleListPages<AppleSubscriptionPricePoint>(credentials, `/subscriptions/${encodeURIComponent(subscriptionId)}/pricePoints`, {
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
 * (GET /v1/subscriptionPricePoints/{id}/equalizations; Apple documents limit
 * up to 8000, the same as the pricePoints list). This is Apple's own
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

/** One subscriptionPrices entry, read without guessing anything */
export interface SubscriptionPriceEntry {
  subscriptionPriceId: string;
  /** alpha-2; undefined if Apple didn't say */
  territory?: string;
  /** null = no start date (the original price) */
  startDate: string | null;
  pricePoint?: { id: string; customerPrice: string; proceeds: string };
  currency?: string;
  /** Why this entry can't be used as-is (missing relationship, price point or currency) */
  problem?: string;
}

interface StrictPriceData {
  id: string;
  attributes?: { startDate?: string | null };
  relationships?: {
    subscriptionPricePoint?: { data?: { id: string } | null };
    territory?: { data?: { id: string } | null };
  };
}

/**
 * Every price entry of a subscription, current, past and future, with its
 * territory and price point taken from the relationships Apple returns. Unlike
 * getSubscriptionPrices (used by the existing UI routes), nothing falls back:
 * no "first price point of the territory", no USD currency, no picking one
 * of several future prices. Anything missing is reported on the entry.
 */
export async function listSubscriptionPriceEntries(
  credentials: AppleConnectCredentials,
  subscriptionId: string,
  ctx: RequestContext = {}
): Promise<SubscriptionPriceEntry[]> {
  let result: { data: StrictPriceData[]; included: unknown[] };
  try {
    result = await appleListAll<StrictPriceData>(credentials, `/subscriptions/${encodeURIComponent(subscriptionId)}/prices`, {
      queryParams: {
        include: 'territory,subscriptionPricePoint',
        limit: '200',
        'fields[subscriptionPrices]': 'startDate,territory,subscriptionPricePoint',
        'fields[subscriptionPricePoints]': 'customerPrice,proceeds',
        'fields[territories]': 'currency',
      },
      budget: ctx.budget,
    });
  } catch (error) {
    throw toApiError(error, 'apple');
  }

  const points = new Map<string, { customerPrice: string; proceeds: string }>();
  const currencies = new Map<string, string>();
  for (const item of result.included as Array<{ id: string; type: string; attributes?: Record<string, string> }>) {
    if (item.type === 'subscriptionPricePoints' && item.attributes) {
      points.set(item.id, { customerPrice: item.attributes.customerPrice, proceeds: item.attributes.proceeds });
    } else if (item.type === 'territories' && item.attributes?.currency) {
      currencies.set(item.id, item.attributes.currency);
    }
  }

  return result.data.map((price) => {
    const alpha3 = price.relationships?.territory?.data?.id;
    const territory = alpha3 ? alpha3ToAlpha2(alpha3) ?? undefined : undefined;
    const pointId = price.relationships?.subscriptionPricePoint?.data?.id;
    const point = pointId ? points.get(pointId) : undefined;
    const currency = alpha3 ? currencies.get(alpha3) : undefined;
    const problem = !territory
      ? `price ${price.id} has no territory`
      : !pointId
        ? `price ${price.id} in ${territory} has no price point`
        : !point
          ? `price ${price.id} in ${territory}: price point ${pointId} was not returned`
          : !currency
            ? `price ${price.id} in ${territory} has no currency`
            : undefined;
    return {
      subscriptionPriceId: price.id,
      ...(territory ? { territory } : {}),
      startDate: price.attributes?.startDate ?? null,
      ...(point && pointId ? { pricePoint: { id: pointId, ...point } } : {}),
      ...(currency ? { currency } : {}),
      ...(problem ? { problem } : {}),
    };
  });
}
