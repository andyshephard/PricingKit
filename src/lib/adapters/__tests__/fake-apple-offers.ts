// JSON:API fixtures for App Store Connect subscription offers, shaped like
// App Store Connect API 4.5 responses (OpenAPI spec): offer lists without
// prices, then each offer's prices with `territory` and
// `subscriptionPricePoint` relationships and both resources included.
// Pages link on with an absolute links.next URL, like Apple's.
import type { RequestBudget } from '@/lib/utils/request-budget';

export const OFFER_SUB_ID = '9000000002';
const API = 'https://api.appstoreconnect.apple.com/v1';

export type Handler = (endpoint: string, query: Record<string, string> | undefined) => unknown;

const CURRENCIES: Record<string, string> = { USA: 'USD', GBR: 'GBP', DEU: 'EUR', FRA: 'EUR', JPN: 'JPY', CAN: 'CAD' };

export const territoryResource = (alpha3: string) => ({
  type: 'territories',
  id: alpha3,
  attributes: { currency: CURRENCIES[alpha3] },
  links: { self: `${API}/territories/${alpha3}` },
});

export const pointResource = (id: string, customerPrice: string, proceeds: string, alpha3: string) => ({
  type: 'subscriptionPricePoints',
  id,
  attributes: { customerPrice, proceeds },
  relationships: { territory: { data: { type: 'territories', id: alpha3 } } },
});

/** One offer price entry. Pass null for a relationship Apple left empty, undefined to leave it out entirely. */
export function priceEntry(type: string, id: string, alpha3: string | null | undefined, pointId: string | null | undefined) {
  const relationships: Record<string, unknown> = {};
  if (alpha3 !== undefined) relationships.territory = { data: alpha3 === null ? null : { type: 'territories', id: alpha3 } };
  if (pointId !== undefined) relationships.subscriptionPricePoint = { data: pointId === null ? null : { type: 'subscriptionPricePoints', id: pointId } };
  return { type, id, relationships, links: { self: `${API}/${type}/${id}` } };
}

export function page(data: unknown[], included: unknown[] = [], next?: string) {
  return {
    data,
    included,
    links: { self: 'self', ...(next ? { next: `${API}${next}` } : {}) },
    meta: { paging: { total: data.length, limit: 200 } },
  };
}

export const promoOffer = (id: string, offerCode: string, name: string, offerMode = 'PAY_UP_FRONT', duration = 'ONE_YEAR') => ({
  type: 'subscriptionPromotionalOffers',
  id,
  attributes: { name, offerCode, duration, offerMode, numberOfPeriods: 1 },
  relationships: { prices: { links: { related: `${API}/subscriptionPromotionalOffers/${id}/prices` } } },
});

/**
 * A minimal router standing in for appleApiRequest. Routes match the
 * endpoint exactly (first page) or with its query string (a links.next page).
 * Like the real client, a spent budget refuses before anything is "sent".
 */
export class FakeOfferServer {
  routes = new Map<string, Handler>();
  calls: Array<{ endpoint: string; query?: Record<string, string>; method: string }> = [];

  on(endpoint: string, handler: Handler | unknown): this {
    this.routes.set(endpoint, typeof handler === 'function' ? (handler as Handler) : () => handler);
    return this;
  }

  handle = async (_credentials: unknown, endpoint: string, options: Record<string, unknown> = {}) => {
    (options.budget as RequestBudget | undefined)?.consume('apple');
    const method = (options.method as string) ?? 'GET';
    const query = options.queryParams as Record<string, string> | undefined;
    this.calls.push({ endpoint, query, method });
    if (method !== 'GET') throw new Error(`Unexpected ${method} ${endpoint}: offers are read-only`);
    const handler = this.routes.get(endpoint);
    if (!handler) throw new Error(`No fixture for GET ${endpoint}`);
    return handler(endpoint, query);
  };
}
