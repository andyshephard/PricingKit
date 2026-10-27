// A stateful in-memory App Store Connect for offer write tests: subscriptions
// with base prices and price points, and their promotional offers,
// introductory offers, offer codes and win-back offers, readable and writable
// through the same endpoints the Apple client uses.
//
// Confirmed against a real account (read-only): free-trial intro prices have
// no price point; a pay-up-front promotional offer's stored price is the
// total for its whole duration.
// ASSUMED, not confirmed (to be checked in the write test): a promotional
// offer PATCH replaces the offer's whole price list with the one sent; the
// 10-promotional-offer cap (enforced here like Apple's help pages describe);
// inline price IDs of the form "${...}".
import { AppleApiError } from '@/lib/apple-connect/client';
import type { RequestBudget } from '@/lib/utils/request-budget';

const API = 'https://api.appstoreconnect.apple.com/v1';

export const TERRITORIES: Record<string, { alpha2: string; currency: string }> = {
  USA: { alpha2: 'US', currency: 'USD' },
  GBR: { alpha2: 'GB', currency: 'GBP' },
  DEU: { alpha2: 'DE', currency: 'EUR' },
  JPN: { alpha2: 'JP', currency: 'JPY' },
};

interface Point {
  id: string;
  alpha3: string;
  customerPrice: string;
  proceeds: string;
}
interface OfferPrice {
  id: string;
  alpha3: string;
  pointId: string | null;
}
interface Offer {
  id: string;
  subscriptionId: string;
  type: 'subscriptionPromotionalOffers' | 'subscriptionOfferCodes' | 'winBackOffers';
  attributes: Record<string, unknown>;
  prices: OfferPrice[];
}
interface Intro {
  id: string;
  subscriptionId: string;
  alpha3: string;
  pointId: string | null;
  attributes: Record<string, unknown>;
}
interface Sub {
  id: string;
  period: string;
  base: Record<string, string>; // alpha3 -> customer price
}

export type Failure = { method: string; path: RegExp; status: number; afterWrite?: boolean; times?: number };

const PRICE_TYPE: Record<Offer['type'], string> = {
  subscriptionPromotionalOffers: 'subscriptionPromotionalOfferPrices',
  subscriptionOfferCodes: 'subscriptionOfferCodePrices',
  winBackOffers: 'winBackOfferPrices',
};

export class FakeOfferStore {
  subs = new Map<string, Sub>();
  points = new Map<string, Point>();
  offers: Offer[] = [];
  intros: Intro[] = [];
  calls: Array<{ method: string; endpoint: string; body?: unknown }> = [];
  failures: Failure[] = [];
  private n = 0;
  promoCap = 10;

  /** A subscription whose ladder in every territory is `ladder` (customer prices) */
  addSubscription(id: string, period: string, base: Record<string, string>, ladder: Record<string, string[]>): this {
    this.subs.set(id, { id, period, base });
    for (const [alpha3, prices] of Object.entries(ladder)) {
      for (const price of prices) {
        const pid = `pp-${id}-${alpha3}-${price}`;
        this.points.set(pid, { id: pid, alpha3, customerPrice: price, proceeds: (Number(price) * 0.85).toFixed(2) });
      }
    }
    return this;
  }

  point(subId: string, alpha3: string, price: string): string {
    const id = `pp-${subId}-${alpha3}-${price}`;
    if (!this.points.has(id)) throw new Error(`no point ${id}`);
    return id;
  }

  seedPromo(subId: string, offerCode: string, attrs: Partial<Record<string, unknown>>, prices: Record<string, string>): Offer {
    const offer: Offer = {
      id: `promo-${++this.n}`,
      subscriptionId: subId,
      type: 'subscriptionPromotionalOffers',
      attributes: { name: offerCode, offerCode, duration: 'ONE_YEAR', offerMode: 'PAY_UP_FRONT', numberOfPeriods: 1, ...attrs },
      prices: Object.entries(prices).map(([alpha3, price]) => ({ id: `price-${++this.n}`, alpha3, pointId: this.point(subId, alpha3, price) })),
    };
    this.offers.push(offer);
    return offer;
  }

  seedIntro(subId: string, alpha3: string, attrs: Record<string, unknown>, price: string | null): Intro {
    const intro: Intro = { id: `intro-${++this.n}`, subscriptionId: subId, alpha3, pointId: price === null ? null : this.point(subId, alpha3, price), attributes: { numberOfPeriods: 1, startDate: null, endDate: null, ...attrs } };
    this.intros.push(intro);
    return intro;
  }

  writes(): string[] {
    return this.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.endpoint}`);
  }

  private fail(method: string, endpoint: string, when: 'before' | 'after'): void {
    const i = this.failures.findIndex((f) => f.method === method && f.path.test(endpoint) && Boolean(f.afterWrite) === (when === 'after'));
    if (i < 0) return;
    const f = this.failures[i];
    if (!f.times || f.times <= 1) this.failures.splice(i, 1);
    else f.times--;
    throw new AppleApiError(f.status, f.status === 409 ? 'ENTITY_ERROR' : 'UNEXPECTED_ERROR', 'Error', `Injected ${f.status} on ${method} ${endpoint}`);
  }

  private pricesPage(prices: OfferPrice[], priceType: string) {
    const used = new Set(prices.map((p) => p.pointId).filter(Boolean) as string[]);
    return {
      data: prices.map((p) => ({
        type: priceType,
        id: p.id,
        relationships: {
          territory: { data: { type: 'territories', id: p.alpha3 } },
          subscriptionPricePoint: { data: p.pointId ? { type: 'subscriptionPricePoints', id: p.pointId } : null },
        },
      })),
      included: [
        ...[...used].map((id) => ({ type: 'subscriptionPricePoints', id, attributes: { customerPrice: this.points.get(id)!.customerPrice, proceeds: this.points.get(id)!.proceeds } })),
        ...[...new Set(prices.map((p) => p.alpha3))].map((t) => ({ type: 'territories', id: t, attributes: { currency: TERRITORIES[t].currency } })),
      ],
      links: { self: `${API}/x` },
    };
  }

  private inline(body: { data: { relationships: { prices?: { data: Array<{ id: string }> } } }; included?: unknown[] }): OfferPrice[] {
    const included = (body.included ?? []) as Array<{ id: string; relationships?: { territory?: { data: { id: string } }; subscriptionPricePoint?: { data: { id: string } } } }>;
    return (body.data.relationships.prices?.data ?? []).filter((ref) => ref.id.startsWith('${')).map((ref) => {
      const inc = included.find((i) => i.id === ref.id);
      if (!inc) throw new AppleApiError(409, 'ENTITY_ERROR', 'Error', `No included price ${ref.id}`);
      const alpha3 = inc.relationships?.territory?.data.id;
      if (!alpha3) throw new AppleApiError(409, 'ENTITY_ERROR', 'Error', 'Price without territory');
      return { id: `price-${++this.n}`, alpha3, pointId: inc.relationships?.subscriptionPricePoint?.data.id ?? null };
    });
  }

  handle = async (_credentials: unknown, endpoint: string, options: Record<string, unknown> = {}) => {
    (options.budget as RequestBudget | undefined)?.consume('apple');
    const method = (options.method as string) ?? 'GET';
    const body = options.body as Record<string, unknown> | undefined;
    const query = (options.queryParams ?? {}) as Record<string, string>;
    this.calls.push({ method, endpoint, ...(body ? { body: structuredClone(body) } : {}) });
    this.fail(method, endpoint, 'before');
    const result = this.route(method, endpoint, body, query);
    this.fail(method, endpoint, 'after');
    return result;
  };

  private route(method: string, endpoint: string, body: Record<string, unknown> | undefined, query: Record<string, string>): unknown {
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = endpoint.match(/^\/subscriptions\/(\d+)$/))) {
      const sub = this.subs.get(m[1]);
      if (!sub) throw new AppleApiError(404, 'NOT_FOUND', 'Not found', 'No subscription');
      return { data: { type: 'subscriptions', id: sub.id, attributes: { productId: `com.example.app.${sub.id}`, subscriptionPeriod: sub.period } } };
    }
    if (method === 'GET' && (m = endpoint.match(/^\/subscriptions\/(\d+)\/prices$/))) {
      const sub = this.subs.get(m[1])!;
      const entries = Object.entries(sub.base).map(([alpha3, price]) => ({ alpha3, pid: this.point(sub.id, alpha3, price) }));
      return {
        data: entries.map((e) => ({
          type: 'subscriptionPrices',
          id: `base-${sub.id}-${e.alpha3}`,
          attributes: { startDate: null },
          relationships: { territory: { data: { type: 'territories', id: e.alpha3 } }, subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: e.pid } } },
        })),
        included: [
          ...entries.map((e) => ({ type: 'subscriptionPricePoints', id: e.pid, attributes: { customerPrice: this.points.get(e.pid)!.customerPrice, proceeds: this.points.get(e.pid)!.proceeds } })),
          ...entries.map((e) => ({ type: 'territories', id: e.alpha3, attributes: { currency: TERRITORIES[e.alpha3].currency } })),
        ],
        links: { self: `${API}/x` },
      };
    }
    if (method === 'GET' && (m = endpoint.match(/^\/subscriptions\/(\d+)\/pricePoints$/))) {
      const wanted = (query['filter[territory]'] ?? '').split(',');
      const pts = [...this.points.values()].filter((p) => p.id.startsWith(`pp-${m![1]}-`) && wanted.includes(p.alpha3));
      return {
        data: pts.map((p) => ({ type: 'subscriptionPricePoints', id: p.id, attributes: { customerPrice: p.customerPrice, proceeds: p.proceeds }, relationships: { territory: { data: { type: 'territories', id: p.alpha3 } } } })),
        included: wanted.filter((t) => TERRITORIES[t]).map((t) => ({ type: 'territories', id: t, attributes: { currency: TERRITORIES[t].currency } })),
        links: { self: `${API}/x` },
      };
    }
    if (method === 'GET' && (m = endpoint.match(/^\/subscriptions\/(\d+)\/(promotionalOffers|offerCodes|winBackOffers)$/))) {
      const type = { promotionalOffers: 'subscriptionPromotionalOffers', offerCodes: 'subscriptionOfferCodes', winBackOffers: 'winBackOffers' }[m[2]]!;
      return { data: this.offers.filter((o) => o.subscriptionId === m![1] && o.type === type).map((o) => ({ type: o.type, id: o.id, attributes: { ...o.attributes } })), links: { self: `${API}/x` } };
    }
    if (method === 'GET' && (m = endpoint.match(/^\/subscriptions\/(\d+)\/introductoryOffers$/))) {
      const intros = this.intros.filter((i) => i.subscriptionId === m![1]);
      const page = this.pricesPage(intros.map((i) => ({ id: i.id, alpha3: i.alpha3, pointId: i.pointId })), 'subscriptionIntroductoryOffers') as { data: Array<Record<string, unknown>>; included: unknown[] };
      page.data.forEach((d, i) => (d.attributes = { ...intros[i].attributes }));
      return page;
    }
    if (method === 'GET' && (m = endpoint.match(/^\/(subscriptionPromotionalOffers|subscriptionOfferCodes|winBackOffers)\/([^/]+)\/prices$/))) {
      const offer = this.offers.find((o) => o.id === m![2])!;
      return this.pricesPage(offer.prices, PRICE_TYPE[offer.type]);
    }

    const data = (body?.data ?? {}) as { attributes?: Record<string, unknown>; relationships?: Record<string, { data: { id: string } }> };
    if (method === 'POST' && (endpoint === '/subscriptionPromotionalOffers' || endpoint === '/subscriptionOfferCodes' || endpoint === '/winBackOffers')) {
      const type = endpoint.slice(1) as Offer['type'];
      const subId = data.relationships!.subscription.data.id;
      const keyField = type === 'subscriptionPromotionalOffers' ? 'offerCode' : type === 'winBackOffers' ? 'offerId' : 'name';
      if (this.offers.some((o) => o.type === type && o.subscriptionId === subId && o.attributes[keyField] === data.attributes![keyField])) {
        throw new AppleApiError(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE', 'Error', `${keyField} already used`);
      }
      if (type === 'subscriptionPromotionalOffers' && this.offers.filter((o) => o.type === type && o.subscriptionId === subId).length >= this.promoCap) {
        throw new AppleApiError(409, 'ENTITY_ERROR', 'Error', 'Too many promotional offers');
      }
      const offer: Offer = {
        id: `${type}-${++this.n}`,
        subscriptionId: subId,
        type,
        attributes: { ...data.attributes, ...(type === 'subscriptionOfferCodes' ? { active: true } : {}), ...(type === 'winBackOffers' && !('endDate' in data.attributes!) ? { endDate: null } : {}) },
        prices: this.inline(body as never),
      };
      this.offers.push(offer);
      return { data: { type, id: offer.id } };
    }
    if (method === 'POST' && endpoint === '/subscriptionIntroductoryOffers') {
      const subId = data.relationships!.subscription.data.id;
      const alpha3 = data.relationships!.territory.data.id;
      const start = (data.attributes!.startDate as string | undefined) ?? null;
      const end = (data.attributes!.endDate as string | undefined) ?? null;
      const clash = this.intros.find(
        (i) => i.subscriptionId === subId && i.alpha3 === alpha3 && (i.attributes.startDate ?? '0000') < (end ?? '9999') && (start ?? '0000') < ((i.attributes.endDate as string | null) ?? '9999')
      );
      if (clash) throw new AppleApiError(409, 'ENTITY_ERROR', 'Error', 'Overlapping introductory offer');
      const intro: Intro = { id: `intro-${++this.n}`, subscriptionId: subId, alpha3, pointId: data.relationships!.subscriptionPricePoint?.data.id ?? null, attributes: { ...data.attributes, startDate: start, endDate: end } };
      this.intros.push(intro);
      return { data: { type: 'subscriptionIntroductoryOffers', id: intro.id } };
    }
    if ((m = endpoint.match(/^\/(subscriptionPromotionalOffers|subscriptionOfferCodes|winBackOffers)\/([^/]+)$/))) {
      const offer = this.offers.find((o) => o.id === m![2]);
      if (!offer) throw new AppleApiError(404, 'NOT_FOUND', 'Not found', 'No offer');
      if (method === 'DELETE') {
        if (offer.type === 'subscriptionOfferCodes') throw new AppleApiError(405, 'METHOD_NOT_ALLOWED', 'Error', 'Not allowed');
        this.offers = this.offers.filter((o) => o !== offer);
        return {};
      }
      if (method === 'PATCH') {
        if (offer.type === 'subscriptionPromotionalOffers') {
          // ASSUMED: the list sent replaces the whole price list
          const refs = (body as { data: { relationships: { prices: { data: Array<{ id: string }> } } } }).data.relationships.prices.data;
          const fresh = this.inline(body as never);
          const kept = refs.filter((r) => !r.id.startsWith('${')).map((r) => {
            const p = offer.prices.find((x) => x.id === r.id);
            if (!p) throw new AppleApiError(409, 'ENTITY_ERROR', 'Error', `Unknown price ${r.id}`);
            return p;
          });
          offer.prices = [...kept, ...fresh];
        } else {
          Object.assign(offer.attributes, data.attributes ?? {});
        }
        return { data: { type: offer.type, id: offer.id } };
      }
    }
    if ((m = endpoint.match(/^\/subscriptionIntroductoryOffers\/([^/]+)$/))) {
      const intro = this.intros.find((i) => i.id === m![1]);
      if (!intro) throw new AppleApiError(404, 'NOT_FOUND', 'Not found', 'No intro offer');
      if (method === 'DELETE') {
        this.intros = this.intros.filter((i) => i !== intro);
        return {};
      }
      if (method === 'PATCH') {
        Object.assign(intro.attributes, data.attributes ?? {});
        return { data: { type: 'subscriptionIntroductoryOffers', id: intro.id } };
      }
    }
    throw new Error(`FakeOfferStore: unexpected ${method} ${endpoint}`);
  }
}
