// A stateful fake of the Google Play endpoints the offer code uses, for tests
// that mock googlePlayFetch. It follows the Android Publisher v3 discovery
// document where it is specific and makes these assumptions where it isn't
// (to be confirmed against a real Play test app):
//   - creating an offer whose offerId exists answers 409
//   - activate works on DRAFT and INACTIVE offers, deactivate on ACTIVE ones;
//     anything else answers 400
//   - delete works on DRAFT offers only (documented) and answers 400 otherwise
//   - a developer-determined offer reads back without a targeting field
//   - proto3 JSON: false booleans and zero units are left out of responses
// Nothing here talks to a network.

import { ApiError } from '@/lib/utils/api-error';
import type { RequestBudget } from '@/lib/utils/request-budget';

type Money = { currencyCode: string; units?: string; nanos?: number };
type Resource = Record<string, unknown> & { offerId: string; state: string };

export const PKG = 'com.example.app';
export const PRODUCT = 'com.example.pro';

/** Invented exchange rates for convertRegionPrices (per USD), no tax */
const FX: Record<string, { currency: string; perUsd: number }> = {
  US: { currency: 'USD', perUsd: 1 },
  GB: { currency: 'GBP', perUsd: 0.8 },
  DE: { currency: 'EUR', perUsd: 0.9 },
  JP: { currency: 'JPY', perUsd: 150 },
};

export function money(currency: string, amount: string): Money {
  const [units, fraction = ''] = amount.split('.');
  const nanos = Number(fraction.padEnd(9, '0').slice(0, 9));
  return { currencyCode: currency, ...(units !== '0' ? { units } : {}), ...(nanos ? { nanos } : {}) };
}

function amountOf(m: Money): number {
  return Number(m.units ?? '0') + (m.nanos ?? 0) / 1e9;
}

/** "Pretty" Play-like rounding: whole tens for JPY, .99 endings otherwise */
function pretty(currency: string, value: number): string {
  if (currency === 'JPY') return String(Math.max(10, Math.round(value / 10) * 10));
  const v = Math.max(0.99, Math.ceil(value) - 0.01);
  return v.toFixed(2);
}

function httpError(status: number, message: string): ApiError {
  return new ApiError(message, { status, code: status, platform: 'google' });
}

export interface FakeCall {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

export class FakePlayOffers {
  calls: FakeCall[] = [];
  regionsVersion: string | undefined = '2025/03';
  pageSize = 100;
  subscription: Record<string, unknown>;
  offers = new Map<string, Resource>();
  private failures: Array<{ match: (c: FakeCall) => boolean; status: number; tookEffect: boolean }> = [];

  constructor() {
    this.subscription = {
      packageName: PKG,
      productId: PRODUCT,
      basePlans: [
        {
          basePlanId: 'annual',
          state: 'ACTIVE',
          autoRenewingBasePlanType: { billingPeriodDuration: 'P1Y' },
          regionalConfigs: [
            { regionCode: 'US', price: money('USD', '59.99'), newSubscriberAvailability: true },
            { regionCode: 'GB', price: money('GBP', '49.99'), newSubscriberAvailability: true },
            { regionCode: 'JP', price: money('JPY', '9800'), newSubscriberAvailability: true },
          ],
        },
        {
          basePlanId: 'monthly',
          state: 'ACTIVE',
          autoRenewingBasePlanType: { billingPeriodDuration: 'P1M' },
          regionalConfigs: [{ regionCode: 'US', price: money('USD', '5.99'), newSubscriberAvailability: true }],
        },
        { basePlanId: 'prepaid', state: 'ACTIVE', prepaidBasePlanType: { billingPeriodDuration: 'P1M' }, regionalConfigs: [] },
      ],
    };
  }

  key(basePlanId: string, offerId: string): string {
    return `${basePlanId}/${offerId}`;
  }

  /** Put an offer straight into the store (as Play would return it) */
  seed(basePlanId: string, resource: Record<string, unknown>): void {
    this.offers.set(this.key(basePlanId, resource.offerId as string), { packageName: PKG, productId: PRODUCT, basePlanId, ...structuredClone(resource) } as unknown as Resource);
  }

  offer(basePlanId: string, offerId: string): Resource | undefined {
    return this.offers.get(this.key(basePlanId, offerId));
  }

  setBasePrice(basePlanId: string, region: string, amount: string): void {
    const plan = (this.subscription.basePlans as Array<Record<string, unknown>>).find((bp) => bp.basePlanId === basePlanId)!;
    const config = (plan.regionalConfigs as Array<{ regionCode: string; price: Money }>).find((c) => c.regionCode === region)!;
    config.price = money(config.price.currencyCode, amount);
  }

  /** The next matching request fails with `status`; with tookEffect it is applied first (a timeout after the write) */
  failNext(match: (c: FakeCall) => boolean, status: number, options: { tookEffect?: boolean } = {}): void {
    this.failures.push({ match, status, tookEffect: options.tookEffect ?? false });
  }

  /** Requests that change the store (convertRegionPrices is a read-only calculation) */
  writes(): string[] {
    return this.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith(':convertRegionPrices')).map((c) => `${c.method} ${c.path.replace(/^.*\/subscriptions\//, '')}`);
  }

  handle = async (_credentials: unknown, path: string, options: { method?: string; body?: unknown; query?: Record<string, unknown>; budget?: RequestBudget } = {}): Promise<unknown> => {
    const method = options.method ?? 'GET';
    options.budget?.consume('google');
    const call: FakeCall = { method, path, ...(options.query ? { query: options.query } : {}), ...(options.body !== undefined ? { body: structuredClone(options.body) } : {}) };
    this.calls.push(call);
    const failure = this.failures.find((f) => f.match(call));
    if (failure) {
      this.failures.splice(this.failures.indexOf(failure), 1);
      if (failure.tookEffect) this.route(method, path, options);
      throw httpError(failure.status, `injected ${failure.status}`);
    }
    return this.route(method, path, options);
  };

  private route(method: string, path: string, options: { body?: unknown; query?: Record<string, unknown> }): unknown {
    const app = `/androidpublisher/v3/applications/${encodeURIComponent(PKG)}`;
    if (!path.startsWith(app)) throw httpError(404, `No app at ${path}`);
    const rest = path.slice(app.length);
    if (rest === '/pricing:convertRegionPrices' && method === 'POST') return this.convert((options.body as { price: Money }).price);
    const sub = `/subscriptions/${encodeURIComponent(PRODUCT)}`;
    if (rest === sub && method === 'GET') return structuredClone(this.subscription);
    if (rest === sub && method === 'PATCH') {
      // Base plan price edits (updateMask=basePlans): the whole list is replaced
      if (options.query?.updateMask !== 'basePlans') throw httpError(400, 'unexpected updateMask');
      this.subscription = { ...this.subscription, basePlans: structuredClone((options.body as { basePlans: unknown }).basePlans) };
      return structuredClone(this.subscription);
    }
    if (rest.startsWith('/subscriptions/') && !rest.startsWith(sub)) throw httpError(404, 'Subscription not found');
    const match = /^\/subscriptions\/[^/]+\/basePlans\/([^/]+)\/offers(?:\/([^/:]+))?(?::(activate|deactivate))?$/.exec(rest);
    if (!match) throw httpError(404, `Unknown path ${rest}`);
    const basePlanId = decodeURIComponent(match[1]);
    const offerId = match[2] ? decodeURIComponent(match[2]) : undefined;
    const action = match[3];
    if (!offerId) {
      if (method === 'GET') return this.list(basePlanId, options.query ?? {});
      if (method === 'POST') return this.create(basePlanId, options.query ?? {}, options.body as Record<string, unknown>);
    } else {
      const existing = this.offer(basePlanId, offerId);
      if (!existing) throw httpError(404, `Offer ${offerId} not found`);
      if (action && method === 'POST') return this.setState(existing, action === 'activate');
      if (method === 'GET') return structuredClone(existing);
      if (method === 'PATCH') return this.patch(existing, options.query ?? {}, options.body as Record<string, unknown>);
      if (method === 'DELETE') {
        if (existing.state !== 'DRAFT') throw httpError(400, 'Only draft offers can be deleted');
        this.offers.delete(this.key(basePlanId, offerId));
        return undefined;
      }
    }
    throw httpError(405, `${method} ${rest}`);
  }

  private convert(price: Money) {
    const from = Object.values(FX).find((r) => r.currency === price.currencyCode);
    if (!from) throw httpError(400, `Unknown currency ${price.currencyCode}`);
    const usd = amountOf(price) / from.perUsd;
    const converted: Record<string, unknown> = {};
    for (const [region, r] of Object.entries(FX)) {
      converted[region] = { regionCode: region, price: money(r.currency, pretty(r.currency, usd * r.perUsd)), taxAmount: money(r.currency, '0') };
    }
    return { convertedRegionPrices: converted, ...(this.regionsVersion ? { regionVersion: { version: this.regionsVersion } } : {}) };
  }

  private list(basePlanId: string, query: Record<string, unknown>) {
    const all = [...this.offers.values()].filter((o) => basePlanId === '-' || o.basePlanId === basePlanId).map((o) => structuredClone(o));
    const start = query.pageToken ? Number(String(query.pageToken).replace('page-', '')) : 0;
    const size = Math.min(Number(query.pageSize ?? 50), this.pageSize);
    const page = all.slice(start, start + size);
    return { subscriptionOffers: page, ...(start + size < all.length ? { nextPageToken: `page-${start + size}` } : {}) };
  }

  private validate(body: Record<string, unknown>): void {
    const regions = ((body.regionalConfigs as Array<{ regionCode: string }>) ?? []).map((c) => c.regionCode).sort();
    const phases = (body.phases as Array<{ regionalConfigs: Array<{ regionCode: string }> }>) ?? [];
    if (regions.length === 0) throw httpError(400, 'regionalConfigs must contain at least one entry');
    if (phases.length < 1 || phases.length > 2) throw httpError(400, 'phases must contain one or two entries');
    for (const phase of phases) {
      if (JSON.stringify(phase.regionalConfigs.map((c) => c.regionCode).sort()) !== JSON.stringify(regions)) throw httpError(400, 'each phase must price exactly the offer regions');
    }
  }

  private stored(body: Record<string, unknown>, state: string, basePlanId: string): Resource {
    const out = structuredClone(body) as Resource;
    out.state = state;
    out.basePlanId = basePlanId;
    // proto3 JSON leaves false booleans out
    for (const config of (out.regionalConfigs as Array<Record<string, unknown>>) ?? []) if (config.newSubscriberAvailability === false) delete config.newSubscriberAvailability;
    return out;
  }

  private create(basePlanId: string, query: Record<string, unknown>, body: Record<string, unknown>) {
    if (!query['regionsVersion.version']) throw httpError(400, 'regionsVersion.version is required');
    if (!query.offerId || query.offerId !== body.offerId) throw httpError(400, 'offerId query and body differ');
    if (this.offer(basePlanId, body.offerId as string)) throw httpError(409, 'An offer with this ID already exists');
    this.validate(body);
    const resource = this.stored(body, 'DRAFT', basePlanId);
    this.offers.set(this.key(basePlanId, resource.offerId), resource);
    return structuredClone(resource);
  }

  private patch(existing: Resource, query: Record<string, unknown>, body: Record<string, unknown>) {
    if (!query['regionsVersion.version']) throw httpError(400, 'regionsVersion.version is required');
    const mask = String(query.updateMask ?? '').split(',').filter(Boolean);
    if (mask.length === 0) throw httpError(400, 'updateMask is required');
    const next = structuredClone(existing);
    for (const field of mask) {
      if (body[field] === undefined) delete next[field];
      else next[field] = structuredClone(body[field]);
    }
    this.validate(next);
    const stored = this.stored(next, existing.state, existing.basePlanId as string);
    this.offers.set(this.key(existing.basePlanId as string, existing.offerId), stored);
    return structuredClone(stored);
  }

  private setState(existing: Resource, activate: boolean) {
    if (activate && existing.state === 'ACTIVE') throw httpError(400, 'Offer is already active');
    if (!activate && existing.state !== 'ACTIVE') throw httpError(400, 'Only active offers can be deactivated');
    existing.state = activate ? 'ACTIVE' : 'INACTIVE';
    return structuredClone(existing);
  }
}

// ---------------------------------------------------------------------------
// Realistic offers as Play returns them

/** Developer-determined 50% off a year (single payment), tagged for a customer center */
export function retentionOfferResource(state = 'ACTIVE'): Record<string, unknown> {
  return {
    packageName: PKG,
    productId: PRODUCT,
    basePlanId: 'annual',
    offerId: 'annual-half-off',
    state,
    phases: [
      {
        duration: 'P1Y',
        recurrenceCount: 1,
        regionalConfigs: [
          { regionCode: 'GB', relativeDiscount: 0.5 },
          { regionCode: 'JP', relativeDiscount: 0.5 },
          { regionCode: 'US', relativeDiscount: 0.5 },
        ],
      },
    ],
    offerTags: [{ tag: 'rc-customer-center' }, { tag: 'rc-ignore-offer' }],
    regionalConfigs: [
      { regionCode: 'GB', newSubscriberAvailability: true },
      { regionCode: 'JP', newSubscriberAvailability: true },
      { regionCode: 'US', newSubscriberAvailability: true },
    ],
  };
}

/** A one-week free trial for customers who never had any subscription */
export function trialOfferResource(state = 'ACTIVE'): Record<string, unknown> {
  return {
    packageName: PKG,
    productId: PRODUCT,
    basePlanId: 'annual',
    offerId: 'new-customer-trial',
    state,
    phases: [{ duration: 'P1W', recurrenceCount: 1, regionalConfigs: ['GB', 'JP', 'US'].map((regionCode) => ({ regionCode, free: {} })) }],
    targeting: { acquisitionRule: { scope: { anySubscriptionInApp: {} } } },
    regionalConfigs: ['GB', 'JP', 'US'].map((regionCode) => ({ regionCode, newSubscriberAvailability: true })),
  };
}

/** Two phases: a free week, then three months at fixed prices, for upgraders from a monthly plan */
export function twoPhaseOfferResource(): Record<string, unknown> {
  return {
    packageName: PKG,
    productId: PRODUCT,
    basePlanId: 'annual',
    offerId: 'upgrade-intro',
    state: 'DRAFT',
    phases: [
      { duration: 'P7D', recurrenceCount: 1, regionalConfigs: [{ regionCode: 'US', free: {} }, { regionCode: 'GB', free: {} }], otherRegionsConfig: { free: {} } },
      {
        duration: 'P1M',
        recurrenceCount: 3,
        regionalConfigs: [
          { regionCode: 'US', price: { currencyCode: 'USD', units: '2', nanos: 990000000 } },
          { regionCode: 'GB', absoluteDiscount: { currencyCode: 'GBP', units: '1' } },
        ],
        otherRegionsConfig: { otherRegionsPrices: { usdPrice: { currencyCode: 'USD', units: '2', nanos: 990000000 }, eurPrice: { currencyCode: 'EUR', units: '2', nanos: 990000000 } } },
      },
    ],
    targeting: { upgradeRule: { scope: { specificSubscriptionInApp: 'com.example.basic' }, billingPeriodDuration: 'P1M', oncePerUser: true } },
    offerTags: [{ tag: 'upgrade' }],
    regionalConfigs: [{ regionCode: 'US', newSubscriberAvailability: true }, { regionCode: 'GB' }],
    otherRegionsConfig: { otherRegionsNewSubscriberAvailability: true },
  };
}
