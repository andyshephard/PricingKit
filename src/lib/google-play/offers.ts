// Google Play subscription offers (monetization.subscriptions.basePlans.offers).
//
// Endpoints and fields follow the Android Publisher v3 discovery document
// (revision 20261026):
//   list       GET    .../subscriptions/{productId}/basePlans/{basePlanId}/offers   (basePlanId "-" = every base plan)
//   get        GET    .../offers/{offerId}
//   create     POST   .../offers?offerId=&regionsVersion.version=      (the offer starts as DRAFT)
//   patch      PATCH  .../offers/{offerId}?updateMask=&regionsVersion.version=
//   activate   POST   .../offers/{offerId}:activate
//   deactivate POST   .../offers/{offerId}:deactivate
//   delete     DELETE .../offers/{offerId}                         (draft offers only)
//
// Reading is strict: anything this model can't hold (an unknown field, a
// region priced two ways, a phase that doesn't cover the offer's regions) is
// a problem on the StoreOffer, and an offer with problems is never written.

import {
  decimalFromJsonNumber,
  decimalToMoney,
  isPlayDuration,
  moneyToDecimal,
  type Decimal,
  type PlayOfferPhase,
  type PlayOfferState,
  type PlayOfferStatus,
  type PlayOtherRegionsPhasePrice,
  type PlayPhaseRegionPrice,
  type PlayScope,
  type PlayTargeting,
  type StoreOffer,
} from '@/lib/pricing';
import { compareDecimal } from '@/lib/pricing/decimal';
import { googlePlayFetch } from './client';
import type { RequestContext } from '../utils/request-budget';
import type { Money } from './types';
import type { TokenSource } from '../token-source';

export interface PlayOfferIdentity {
  packageName: string;
  productId: string;
  basePlanId: string;
}

/** The SubscriptionOffer resource as Play sends and accepts it */
export interface SubscriptionOfferResource {
  packageName?: string;
  productId?: string;
  basePlanId?: string;
  offerId?: string;
  state?: string;
  phases?: unknown[];
  targeting?: unknown;
  offerTags?: unknown[];
  regionalConfigs?: unknown[];
  otherRegionsConfig?: unknown;
}

interface ListSubscriptionOffersResponse {
  subscriptionOffers?: SubscriptionOfferResource[];
  nextPageToken?: string;
}

const OFFER_FIELDS = new Set(['packageName', 'productId', 'basePlanId', 'offerId', 'state', 'phases', 'targeting', 'offerTags', 'regionalConfigs', 'otherRegionsConfig']);
const PHASE_FIELDS = new Set(['duration', 'recurrenceCount', 'regionalConfigs', 'otherRegionsConfig']);
const PHASE_REGION_PRICE_FIELDS = ['price', 'relativeDiscount', 'absoluteDiscount', 'free'] as const;
const OTHER_REGIONS_PRICE_FIELDS = ['otherRegionsPrices', 'absoluteDiscounts', 'relativeDiscount', 'free'] as const;
const STATES = new Set(['DRAFT', 'ACTIVE', 'INACTIVE']);

function offersPath(packageName: string, productId: string, basePlanId: string): string {
  return `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions/${encodeURIComponent(productId)}/basePlans/${encodeURIComponent(basePlanId)}/offers`;
}

function offerPath(id: PlayOfferIdentity, offerId: string): string {
  return `${offersPath(id.packageName, id.productId, id.basePlanId)}/${encodeURIComponent(offerId)}`;
}

// ---------------------------------------------------------------------------
// Reads

/**
 * Every offer of a subscription's base plan, or of every base plan with
 * basePlanId "-", following nextPageToken. Every page is charged to the budget.
 */
export async function listSubscriptionOffers(
  tokens: TokenSource,
  packageName: string,
  productId: string,
  basePlanId = '-',
  ctx: RequestContext = {}
): Promise<SubscriptionOfferResource[]> {
  const offers: SubscriptionOfferResource[] = [];
  let pageToken: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await googlePlayFetch<ListSubscriptionOffersResponse>(tokens, offersPath(packageName, productId, basePlanId), {
      budget: ctx.budget,
      query: { pageSize: 100, pageToken },
    });
    offers.push(...(response?.subscriptionOffers ?? []));
    pageToken = response?.nextPageToken || undefined;
    // A token seen before would loop forever
    if (pageToken && seen.has(pageToken)) throw new Error(`Play returned the same offers page token twice for ${productId}/${basePlanId}`);
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  return offers;
}

export async function getSubscriptionOffer(
  tokens: TokenSource,
  id: PlayOfferIdentity,
  offerId: string,
  ctx: RequestContext = {}
): Promise<SubscriptionOfferResource | null> {
  try {
    return await googlePlayFetch<SubscriptionOfferResource>(tokens, offerPath(id, offerId), { budget: ctx.budget });
  } catch (error) {
    if ((error as { code?: unknown })?.code === 404) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Writes

/**
 * POST .../offers?offerId=&regionsVersion.version= : creates the offer as
 * DRAFT. Retried on 429 only: after a 5xx, a timeout or a network error the
 * offer may exist, so the client never sends it again (the executor's next
 * read, or a resume, decides).
 */
export async function createSubscriptionOffer(
  tokens: TokenSource,
  id: PlayOfferIdentity,
  body: SubscriptionOfferResource,
  regionsVersion: string,
  ctx: RequestContext = {}
): Promise<SubscriptionOfferResource> {
  return googlePlayFetch<SubscriptionOfferResource>(tokens, offersPath(id.packageName, id.productId, id.basePlanId), {
    method: 'POST',
    budget: ctx.budget,
    retryOnlyRateLimited: true,
    query: { offerId: body.offerId, 'regionsVersion.version': regionsVersion },
    body,
  });
}

/** PATCH .../offers/{offerId}?updateMask=&regionsVersion.version= */
export async function patchSubscriptionOffer(
  tokens: TokenSource,
  id: PlayOfferIdentity,
  body: SubscriptionOfferResource,
  updateMask: string[],
  regionsVersion: string,
  ctx: RequestContext = {}
): Promise<SubscriptionOfferResource> {
  if (updateMask.length === 0) throw new Error('patchSubscriptionOffer needs at least one field in updateMask');
  return googlePlayFetch<SubscriptionOfferResource>(tokens, offerPath(id, body.offerId!), {
    method: 'PATCH',
    budget: ctx.budget,
    query: { updateMask: updateMask.join(','), 'regionsVersion.version': regionsVersion },
    body,
  });
}

/** POST .../offers/{offerId}:activate or :deactivate (body: ActivateSubscriptionOfferRequest / Deactivate...). Retried on 429 only. */
export async function setSubscriptionOfferActive(
  tokens: TokenSource,
  id: PlayOfferIdentity,
  offerId: string,
  active: boolean,
  ctx: RequestContext = {}
): Promise<SubscriptionOfferResource> {
  return googlePlayFetch<SubscriptionOfferResource>(tokens, `${offerPath(id, offerId)}:${active ? 'activate' : 'deactivate'}`, {
    method: 'POST',
    budget: ctx.budget,
    retryOnlyRateLimited: true,
    body: { packageName: id.packageName, productId: id.productId, basePlanId: id.basePlanId, offerId },
  });
}

/** DELETE .../offers/{offerId}: Play deletes draft offers only, irreversibly */
export async function deleteSubscriptionOffer(
  tokens: TokenSource,
  id: PlayOfferIdentity,
  offerId: string,
  ctx: RequestContext = {}
): Promise<void> {
  await googlePlayFetch<void>(tokens, offerPath(id, offerId), { method: 'DELETE', budget: ctx.budget });
}

// ---------------------------------------------------------------------------
// Model -> resource

function money(currency: string, amount: Decimal): Money {
  return { currencyCode: currency, ...decimalToMoney(amount) } as Money;
}

function regionPriceResource(region: string, price: PlayPhaseRegionPrice): Record<string, unknown> {
  switch (price.type) {
    case 'price':
      return { regionCode: region, price: money(price.currency, price.amount) };
    case 'absoluteDiscount':
      return { regionCode: region, absoluteDiscount: money(price.currency, price.amount) };
    case 'relativeDiscount':
      return { regionCode: region, relativeDiscount: Number(price.fraction) };
    case 'free':
      return { regionCode: region, free: {} };
  }
}

function otherRegionsResource(price: PlayOtherRegionsPhasePrice): Record<string, unknown> {
  switch (price.type) {
    case 'price':
      return { otherRegionsPrices: { usdPrice: money('USD', price.usd), eurPrice: money('EUR', price.eur) } };
    case 'absoluteDiscount':
      return { absoluteDiscounts: { usdPrice: money('USD', price.usd), eurPrice: money('EUR', price.eur) } };
    case 'relativeDiscount':
      return { relativeDiscount: Number(price.fraction) };
    case 'free':
      return { free: {} };
  }
}

function scopeResource(scope: PlayScope): Record<string, unknown> {
  if (scope === 'anySubscriptionInApp') return { anySubscriptionInApp: {} };
  if (scope === 'thisSubscription') return { thisSubscription: {} };
  return { specificSubscriptionInApp: scope.specificSubscriptionInApp };
}

function targetingResource(targeting: PlayTargeting): Record<string, unknown> | undefined {
  switch (targeting.type) {
    case 'developerDetermined':
      return undefined;
    case 'acquisition':
      return { acquisitionRule: { scope: scopeResource(targeting.scope) } };
    case 'upgrade':
      return {
        upgradeRule: {
          scope: scopeResource(targeting.scope),
          ...(targeting.billingPeriodDuration ? { billingPeriodDuration: targeting.billingPeriodDuration } : {}),
          ...(targeting.oncePerUser !== undefined ? { oncePerUser: targeting.oncePerUser } : {}),
        },
      };
  }
}

/**
 * The SubscriptionOffer body for a create or a patch: every writable field
 * from the state (state itself is output only). Regions are sent sorted.
 * Developer-determined offers have no targeting field.
 */
export function playOfferResource(id: PlayOfferIdentity, state: PlayOfferState): SubscriptionOfferResource {
  const regions = Object.keys(state.regions).sort();
  const targeting = targetingResource(state.targeting);
  return {
    packageName: id.packageName,
    productId: id.productId,
    basePlanId: id.basePlanId,
    offerId: state.key,
    phases: state.phases.map((phase) => ({
      duration: phase.duration,
      recurrenceCount: phase.recurrenceCount,
      regionalConfigs: regions.map((r) => regionPriceResource(r, phase.regions[r])),
      ...(phase.otherRegions ? { otherRegionsConfig: otherRegionsResource(phase.otherRegions) } : {}),
    })),
    ...(targeting ? { targeting } : {}),
    offerTags: state.tags.map((tag) => ({ tag })),
    regionalConfigs: regions.map((r) => ({ regionCode: r, newSubscriberAvailability: state.regions[r].newSubscriberAvailability })),
    ...(state.otherRegionsNewSubscriberAvailability !== undefined
      ? { otherRegionsConfig: { otherRegionsNewSubscriberAvailability: state.otherRegionsNewSubscriberAvailability } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Resource -> model (strict)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function unknownKeys(value: Record<string, unknown>, allowed: Set<string> | readonly string[]): string[] {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  return Object.keys(value).filter((k) => !set.has(k));
}

/** Money -> { currency, amount }, or a reason it can't be read */
function readMoney(value: unknown, expectCurrency?: string): { currency: string; amount: Decimal } | string {
  if (!isObject(value)) return 'not a Money object';
  const extra = unknownKeys(value, ['currencyCode', 'units', 'nanos']);
  if (extra.length) return `unknown Money field ${extra.join(', ')}`;
  const currency = value.currencyCode;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return 'no currency code';
  if (expectCurrency && currency !== expectCurrency) return `in ${currency}, expected ${expectCurrency}`;
  if (value.units !== undefined && typeof value.units !== 'string' && typeof value.units !== 'number') return 'units is not a number';
  if (value.nanos !== undefined && typeof value.nanos !== 'number') return 'nanos is not a number';
  try {
    return { currency, amount: moneyToDecimal(value.units === undefined ? undefined : String(value.units), value.nanos as number | undefined) };
  } catch {
    return 'unreadable amount';
  }
}

function readFraction(value: unknown): { fraction: Decimal } | { error: string } {
  const fraction = decimalFromJsonNumber(value);
  if (fraction === undefined) return { error: 'relativeDiscount is not a plain number' };
  if (compareDecimal(fraction, '0') <= 0 || compareDecimal(fraction, '1') >= 0) return { error: `relativeDiscount ${fraction} is not between 0 and 1` };
  return { fraction };
}

function readRegionPrice(config: Record<string, unknown>): PlayPhaseRegionPrice | string {
  const extra = unknownKeys(config, ['regionCode', ...PHASE_REGION_PRICE_FIELDS]);
  if (extra.length) return `unknown field ${extra.join(', ')}`;
  const set = PHASE_REGION_PRICE_FIELDS.filter((f) => config[f] !== undefined);
  if (set.length !== 1) return set.length === 0 ? 'no price, discount or free' : `priced ${set.length} ways (${set.join(', ')})`;
  switch (set[0]) {
    case 'free':
      if (!isObject(config.free) || Object.keys(config.free).length > 0) return 'free is not an empty object';
      return { type: 'free' };
    case 'relativeDiscount': {
      const read = readFraction(config.relativeDiscount);
      return 'error' in read ? read.error : { type: 'relativeDiscount', fraction: read.fraction };
    }
    default: {
      const m = readMoney(config[set[0]]);
      if (typeof m === 'string') return `${set[0]}: ${m}`;
      return { type: set[0], currency: m.currency, amount: m.amount };
    }
  }
}

function readOtherRegionsPrice(config: unknown): PlayOtherRegionsPhasePrice | string {
  if (!isObject(config)) return 'otherRegionsConfig is not an object';
  const extra = unknownKeys(config, OTHER_REGIONS_PRICE_FIELDS);
  if (extra.length) return `otherRegionsConfig: unknown field ${extra.join(', ')}`;
  const set = OTHER_REGIONS_PRICE_FIELDS.filter((f) => config[f] !== undefined);
  if (set.length !== 1) return `otherRegionsConfig is priced ${set.length} ways`;
  switch (set[0]) {
    case 'free':
      if (!isObject(config.free) || Object.keys(config.free).length > 0) return 'otherRegionsConfig.free is not an empty object';
      return { type: 'free' };
    case 'relativeDiscount': {
      const read = readFraction(config.relativeDiscount);
      return 'error' in read ? `otherRegionsConfig: ${read.error}` : { type: 'relativeDiscount', fraction: read.fraction };
    }
    default: {
      const prices = config[set[0]];
      if (!isObject(prices) || unknownKeys(prices, ['usdPrice', 'eurPrice']).length) return `otherRegionsConfig.${set[0]} is not { usdPrice, eurPrice }`;
      const usd = readMoney(prices.usdPrice, 'USD');
      const eur = readMoney(prices.eurPrice, 'EUR');
      if (typeof usd === 'string' || typeof eur === 'string') return `otherRegionsConfig.${set[0]}: ${typeof usd === 'string' ? usd : eur}`;
      return { type: set[0] === 'otherRegionsPrices' ? 'price' : 'absoluteDiscount', usd: usd.amount, eur: eur.amount };
    }
  }
}

function readScope(value: unknown): PlayScope | string {
  if (!isObject(value)) return 'scope is missing';
  const keys = Object.keys(value);
  if (keys.length !== 1) return `scope has ${keys.length} entries (${keys.join(', ') || 'none'})`;
  if (keys[0] === 'anySubscriptionInApp' && isObject(value.anySubscriptionInApp)) return 'anySubscriptionInApp';
  if (keys[0] === 'thisSubscription' && isObject(value.thisSubscription)) return 'thisSubscription';
  if (keys[0] === 'specificSubscriptionInApp' && typeof value.specificSubscriptionInApp === 'string' && value.specificSubscriptionInApp) {
    return { specificSubscriptionInApp: value.specificSubscriptionInApp };
  }
  return `unknown scope ${keys[0]}`;
}

function readTargeting(value: unknown): PlayTargeting | string {
  // No targeting means developer-determined. Whether Play returns an absent field or {} for it is not
  // confirmed, so both read the same.
  if (value === undefined || (isObject(value) && Object.keys(value).length === 0)) return { type: 'developerDetermined' };
  if (!isObject(value)) return 'targeting is not an object';
  const extra = unknownKeys(value, ['acquisitionRule', 'upgradeRule']);
  if (extra.length) return `targeting: unknown field ${extra.join(', ')}`;
  if (value.acquisitionRule !== undefined && value.upgradeRule !== undefined) return 'targeting has both an acquisition and an upgrade rule';
  if (value.acquisitionRule !== undefined) {
    const rule = value.acquisitionRule;
    if (!isObject(rule) || unknownKeys(rule, ['scope']).length) return 'acquisitionRule has unknown fields';
    const scope = readScope(rule.scope);
    if (typeof scope === 'string' && scope !== 'anySubscriptionInApp' && scope !== 'thisSubscription') return `acquisitionRule: ${scope}`;
    if (typeof scope !== 'string') return 'acquisitionRule: a specific subscription scope is not allowed for acquisition';
    return { type: 'acquisition', scope };
  }
  const rule = value.upgradeRule;
  if (!isObject(rule) || unknownKeys(rule, ['scope', 'billingPeriodDuration', 'oncePerUser']).length) return 'upgradeRule has unknown fields';
  const scope = readScope(rule.scope);
  if (typeof scope === 'string' && scope !== 'anySubscriptionInApp' && scope !== 'thisSubscription') return `upgradeRule: ${scope}`;
  if (rule.billingPeriodDuration !== undefined && !isPlayDuration(rule.billingPeriodDuration)) return 'upgradeRule.billingPeriodDuration is not an ISO duration';
  if (rule.oncePerUser !== undefined && typeof rule.oncePerUser !== 'boolean') return 'upgradeRule.oncePerUser is not a boolean';
  return {
    type: 'upgrade',
    scope,
    ...(rule.billingPeriodDuration ? { billingPeriodDuration: rule.billingPeriodDuration as string } : {}),
    ...(rule.oncePerUser !== undefined ? { oncePerUser: rule.oncePerUser as boolean } : {}),
  };
}

const REGION = /^[A-Z]{2}$/;

/**
 * Read one SubscriptionOffer into a StoreOffer. Never throws and never
 * guesses: whatever can't be read becomes a problem (offer-wide) or a
 * territory problem (one region), and `play.offer` holds what could be read.
 */
export function parsePlayOffer(raw: unknown, expected?: { productId: string; basePlanId?: string }): StoreOffer {
  const problems: string[] = [];
  const territoryProblems: Record<string, string> = {};
  const regionProblem = (region: string, message: string) => {
    territoryProblems[region] = territoryProblems[region] ? `${territoryProblems[region]}; ${message}` : message;
  };
  const r: Record<string, unknown> = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push('the offer is not an object');

  const extra = unknownKeys(r, OFFER_FIELDS);
  if (extra.length) problems.push(`unknown field ${extra.join(', ')} (PricingKit won't write an offer it can't fully read)`);
  const offerId = typeof r.offerId === 'string' ? r.offerId : '';
  if (!offerId) problems.push('no offerId');
  const productId = typeof r.productId === 'string' ? r.productId : expected?.productId ?? '';
  const basePlanId = typeof r.basePlanId === 'string' ? r.basePlanId : expected?.basePlanId ?? '';
  if (!productId) problems.push('no productId');
  if (!basePlanId) problems.push('no basePlanId');
  if (expected && productId && productId !== expected.productId) problems.push(`belongs to subscription ${productId}, not ${expected.productId}`);
  if (expected?.basePlanId && basePlanId && basePlanId !== expected.basePlanId) problems.push(`belongs to base plan ${basePlanId}, not ${expected.basePlanId}`);

  let state: PlayOfferStatus = 'DRAFT';
  if (typeof r.state === 'string' && STATES.has(r.state)) state = r.state as PlayOfferStatus;
  else problems.push(`unknown state ${JSON.stringify(r.state ?? null)}`);

  // Offer regions
  const regions: PlayOfferState['regions'] = {};
  if (!Array.isArray(r.regionalConfigs) || r.regionalConfigs.length === 0) problems.push('no regionalConfigs');
  for (const config of Array.isArray(r.regionalConfigs) ? r.regionalConfigs : []) {
    if (!isObject(config) || typeof config.regionCode !== 'string' || !REGION.test(config.regionCode)) {
      problems.push('a regional config without a valid regionCode');
      continue;
    }
    const region = config.regionCode;
    const bad = unknownKeys(config, ['regionCode', 'newSubscriberAvailability']);
    if (bad.length) regionProblem(region, `unknown field ${bad.join(', ')}`);
    if (regions[region]) regionProblem(region, 'listed twice in regionalConfigs');
    if (config.newSubscriberAvailability !== undefined && typeof config.newSubscriberAvailability !== 'boolean') regionProblem(region, 'newSubscriberAvailability is not a boolean');
    // Play's documented default when the field is absent (proto3 JSON leaves false out)
    regions[region] = { newSubscriberAvailability: config.newSubscriberAvailability === true };
  }

  // Phases
  const phases: PlayOfferPhase[] = [];
  if (!Array.isArray(r.phases) || r.phases.length === 0 || r.phases.length > 2) problems.push(`an offer has 1 or 2 phases; this one has ${Array.isArray(r.phases) ? r.phases.length : 'none'}`);
  (Array.isArray(r.phases) ? r.phases : []).forEach((rawPhase, i) => {
    const label = `phase ${i + 1}`;
    if (!isObject(rawPhase)) {
      problems.push(`${label} is not an object`);
      return;
    }
    const bad = unknownKeys(rawPhase, PHASE_FIELDS);
    if (bad.length) problems.push(`${label}: unknown field ${bad.join(', ')}`);
    const duration = typeof rawPhase.duration === 'string' ? rawPhase.duration : '';
    if (!isPlayDuration(duration)) problems.push(`${label}: duration ${JSON.stringify(rawPhase.duration ?? null)} is not a single-unit ISO 8601 duration`);
    const recurrenceCount = rawPhase.recurrenceCount;
    if (typeof recurrenceCount !== 'number' || !Number.isInteger(recurrenceCount) || recurrenceCount < 1) problems.push(`${label}: recurrenceCount ${JSON.stringify(recurrenceCount ?? null)} is not a whole number from 1`);
    const prices: Record<string, PlayPhaseRegionPrice> = {};
    for (const config of Array.isArray(rawPhase.regionalConfigs) ? rawPhase.regionalConfigs : []) {
      if (!isObject(config) || typeof config.regionCode !== 'string' || !REGION.test(config.regionCode)) {
        problems.push(`${label}: a regional config without a valid regionCode`);
        continue;
      }
      const region = config.regionCode;
      if (prices[region]) {
        regionProblem(region, `${label}: listed twice`);
        continue;
      }
      const price = readRegionPrice(config);
      if (typeof price === 'string') regionProblem(region, `${label}: ${price}`);
      else prices[region] = price;
    }
    if (!Array.isArray(rawPhase.regionalConfigs)) problems.push(`${label}: no regionalConfigs`);
    // Each phase prices exactly the offer's regions
    for (const region of Object.keys(regions)) if (!prices[region] && !territoryProblems[region]) regionProblem(region, `${label}: no price for this region`);
    for (const region of Object.keys(prices)) if (!regions[region]) regionProblem(region, `${label}: priced, but not one of the offer's regions`);
    let otherRegions: PlayOtherRegionsPhasePrice | undefined;
    if (rawPhase.otherRegionsConfig !== undefined) {
      const other = readOtherRegionsPrice(rawPhase.otherRegionsConfig);
      if (typeof other === 'string') problems.push(`${label}: ${other}`);
      else otherRegions = other;
    }
    phases.push({ duration, recurrenceCount: typeof recurrenceCount === 'number' ? recurrenceCount : 0, regions: prices, ...(otherRegions ? { otherRegions } : {}) });
  });

  // Targeting
  let targeting: PlayTargeting = { type: 'developerDetermined' };
  const readTarget = readTargeting(r.targeting);
  if (typeof readTarget === 'string') problems.push(readTarget);
  else targeting = readTarget;

  // Tags
  const tags: string[] = [];
  if (r.offerTags !== undefined && !Array.isArray(r.offerTags)) problems.push('offerTags is not a list');
  for (const t of Array.isArray(r.offerTags) ? r.offerTags : []) {
    if (!isObject(t) || typeof t.tag !== 'string' || unknownKeys(t, ['tag']).length) problems.push('an offer tag without a tag');
    else if (tags.includes(t.tag)) problems.push(`offer tag ${t.tag} listed twice`);
    else tags.push(t.tag);
  }
  tags.sort();

  // Availability in locations Play launches later
  let otherRegionsNewSubscriberAvailability: boolean | undefined;
  if (r.otherRegionsConfig !== undefined) {
    const o = r.otherRegionsConfig;
    if (!isObject(o) || unknownKeys(o, ['otherRegionsNewSubscriberAvailability']).length) problems.push('otherRegionsConfig has unknown fields');
    else otherRegionsNewSubscriberAvailability = o.otherRegionsNewSubscriberAvailability === true;
  }

  const offer: PlayOfferState = {
    kind: 'play.offer',
    key: offerId,
    state,
    phases,
    targeting,
    tags,
    regions,
    ...(otherRegionsNewSubscriberAvailability !== undefined ? { otherRegionsNewSubscriberAvailability } : {}),
  };
  return {
    kind: 'play.offer',
    storeId: `${productId}/${basePlanId}/${offerId}`,
    key: offerId,
    mode: null,
    duration: null,
    eligibility: { type: 'play.targeting', rule: targeting },
    status: { state, ...(tags.length ? { tags: tags.join(',') } : {}) },
    prices: {},
    ...(Object.keys(territoryProblems).length ? { territoryProblems } : {}),
    ...(problems.length ? { problems } : {}),
    play: { productId, basePlanId, offer },
  };
}
