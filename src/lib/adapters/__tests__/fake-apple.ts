// A small in-memory App Store Connect for adapter tests: just enough of
// /subscriptions/{id}/prices, /subscriptions/{id}/pricePoints,
// POST /subscriptionPrices and DELETE /subscriptionPrices/{id}.
// IDs mimic Apple's base64 JSON shape because getSubscriptionPrices reads them.
import { AppleApiError } from '@/lib/apple-connect/client';
import type { RequestBudget } from '@/lib/utils/request-budget';

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64');

export const SUB_ID = '9000000001';

interface Price {
  id: string;
  alpha2: string;
  pricePointId: string;
  startDate: string | null;
}

interface Point {
  id: string;
  alpha3: string;
  customerPrice: string;
  proceeds: string;
}

const TERRITORIES: Record<string, { alpha3: string; currency: string; ladder: string[] }> = {
  US: { alpha3: 'USA', currency: 'USD', ladder: ['19.99', '24.99', '29.99', '34.99'] },
  GB: { alpha3: 'GBR', currency: 'GBP', ladder: ['19.99', '24.99', '26.99', '29.99'] },
  DE: { alpha3: 'DEU', currency: 'EUR', ladder: ['19.99', '27.99', '29.99', '31.99'] },
};

export type Call = { method: string; endpoint: string; options: Record<string, unknown> };

export class FakeAppleServer {
  prices: Price[] = [];
  points = new Map<string, Point>();
  calls: Call[] = [];
  private counter = 0;
  /** Fail the next POST for this territory (alpha-3) with this status */
  failCreate = new Map<string, number>();
  /** The next POST for this territory (alpha-3) takes effect but then fails with this status */
  failCreateAfterWrite = new Map<string, number>();
  /** Price IDs returned without their price point relationship */
  dropPointRelationship = new Set<string>();
  /** Fail every DELETE with this status */
  failDelete?: number;

  constructor() {
    for (const [, t] of Object.entries(TERRITORIES)) {
      t.ladder.forEach((price, tier) => {
        const id = b64({ s: SUB_ID, t: t.alpha3, p: String(10000 + tier) });
        this.points.set(id, { id, alpha3: t.alpha3, customerPrice: price, proceeds: (Number(price) * 0.7).toFixed(2) });
      });
    }
  }

  point(alpha2: string, price: string): string {
    const alpha3 = TERRITORIES[alpha2].alpha3;
    return [...this.points.values()].find((p) => p.alpha3 === alpha3 && p.customerPrice === price)!.id;
  }

  seed(alpha2: string, price: string, startDate: string | null = null): string {
    const id = b64({ s: SUB_ID, c: alpha2, n: ++this.counter });
    this.prices.push({ id, alpha2, pricePointId: this.point(alpha2, price), startDate });
    return id;
  }

  writes(): string[] {
    return this.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.endpoint}`);
  }

  handle = async (_credentials: unknown, endpoint: string, options: Record<string, unknown> = {}) => {
    const method = (options.method as string) ?? 'GET';
    // Like the real client: a spent budget refuses before anything is sent
    (options.budget as RequestBudget | undefined)?.consume('apple');
    this.calls.push({ method, endpoint, options });
    const query = (options.queryParams ?? {}) as Record<string, string>;

    if (method === 'GET' && endpoint === `/subscriptions/${SUB_ID}/prices`) {
      const used = new Set(this.prices.map((p) => p.pricePointId));
      return {
        data: this.prices.map((p) => ({
          id: p.id,
          type: 'subscriptionPrices',
          attributes: { startDate: p.startDate },
          relationships: {
            subscriptionPricePoint: this.dropPointRelationship.has(p.id) ? { data: null } : { data: { id: p.pricePointId, type: 'subscriptionPricePoints' } },
            territory: { data: { id: TERRITORIES[p.alpha2].alpha3, type: 'territories' } },
          },
        })),
        included: [
          ...[...used].map((id) => {
            const pt = this.points.get(id)!;
            return { id, type: 'subscriptionPricePoints', attributes: { customerPrice: pt.customerPrice, proceeds: pt.proceeds } };
          }),
          ...Object.values(TERRITORIES).map((t) => ({ id: t.alpha3, type: 'territories', attributes: { currency: t.currency } })),
        ],
        links: { self: 'x' },
      };
    }

    if (method === 'GET' && endpoint === `/subscriptions/${SUB_ID}/pricePoints`) {
      const wanted = (query['filter[territory]'] ?? '').split(',');
      const data = [...this.points.values()]
        .filter((p) => wanted.includes(p.alpha3))
        .map((p) => ({
          id: p.id,
          type: 'subscriptionPricePoints',
          attributes: { customerPrice: p.customerPrice, proceeds: p.proceeds },
          relationships: { territory: { data: { id: p.alpha3, type: 'territories' } } },
        }));
      const included = Object.values(TERRITORIES)
        .filter((t) => wanted.includes(t.alpha3))
        .map((t) => ({ id: t.alpha3, type: 'territories', attributes: { currency: t.currency } }));
      return { data, included, links: { self: 'x' } };
    }

    if (method === 'POST' && endpoint === '/subscriptionPrices') {
      const body = options.body as {
        data: { attributes: { startDate: string | null }; relationships: { territory: { data: { id: string } }; subscriptionPricePoint: { data: { id: string } } } };
      };
      const alpha3 = body.data.relationships.territory.data.id;
      const status = this.failCreate.get(alpha3);
      if (status) {
        this.failCreate.delete(alpha3);
        throw new AppleApiError(status, 'ENTITY_ERROR', 'Rejected', `Create refused for ${alpha3}`);
      }
      const ghost = this.failCreateAfterWrite.get(alpha3);
      if (ghost) this.failCreateAfterWrite.delete(alpha3);
      const alpha2 = Object.entries(TERRITORIES).find(([, t]) => t.alpha3 === alpha3)![0];
      const startDate = body.data.attributes.startDate;
      if (!startDate) {
        // UNVERIFIED ASSUMPTION: an immediate create replaces the territory's
        // older active (null-dated or past) entries. Real App Store Connect may
        // keep them and date the new entry instead; the strict reader treats a
        // tie on the latest start date as ambiguous. To be checked against a
        // test app (Phase 2b) before relying on this fake for that case.
        this.prices = this.prices.filter((p) => p.alpha2 !== alpha2 || (p.startDate !== null && new Date(p.startDate) > new Date()));
      }
      const id = b64({ s: SUB_ID, c: alpha2, n: ++this.counter });
      this.prices.unshift({ id, alpha2, pricePointId: body.data.relationships.subscriptionPricePoint.data.id, startDate });
      if (ghost) throw new AppleApiError(ghost, 'UNEXPECTED_ERROR', 'Server error', 'Gateway timeout after the create');
      return { data: { id, type: 'subscriptionPrices' } };
    }

    if (method === 'DELETE' && endpoint.startsWith('/subscriptionPrices/')) {
      if (this.failDelete) throw new AppleApiError(this.failDelete, 'UNEXPECTED_ERROR', 'Server error', 'Delete failed');
      const id = endpoint.slice('/subscriptionPrices/'.length);
      const before = this.prices.length;
      this.prices = this.prices.filter((p) => p.id !== id);
      if (this.prices.length === before) throw new AppleApiError(404, 'NOT_FOUND', 'Not found', 'No such price');
      return {};
    }

    // Ownership: one app (com.example.app) whose only group holds SUB_ID
    if (method === 'GET' && endpoint === '/apps') {
      return { data: [{ type: 'apps', id: 'app-1', attributes: { bundleId: 'com.example.app' } }].filter((a) => a.attributes.bundleId === query['filter[bundleId]']) };
    }
    if (method === 'GET' && endpoint === '/apps/app-1/subscriptionGroups') return { data: [{ type: 'subscriptionGroups', id: 'group-1' }], links: { self: 'x' } };
    if (method === 'GET' && endpoint === `/subscriptions/${SUB_ID}`) {
      return { data: { type: 'subscriptions', id: SUB_ID, relationships: { group: { data: { type: 'subscriptionGroups', id: 'group-1' } } } } };
    }

    throw new Error(`FakeAppleServer: unexpected ${method} ${endpoint}`);
  };
}
