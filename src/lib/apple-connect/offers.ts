// Read-only App Store Connect subscription offers: introductory offers,
// promotional offers, offer codes and win-back offers, with their prices per
// territory. Endpoints, fields and includes follow App Store Connect API 4.5
// (OpenAPI spec). Like listSubscriptionPriceEntries, nothing is guessed:
// territories come from the `territory` relationship, prices from the
// `subscriptionPricePoint` relationship and currencies from the included
// territory. Whatever is missing is reported on the offer, never filled in.

import {
  appleDurationToIso,
  isDecimalString,
  mapWithConcurrency,
  normalizeDecimal,
  OFFER_MODES,
  type AppleOfferKind,
  type OfferEligibility,
  type OfferMode,
  type OfferTerritoryPrice,
  type StoreOffer,
} from '@/lib/pricing';
import type { AppleConnection } from './types';
import { appleListAll } from './pagination';
import { alpha3ToAlpha2 } from './territories';
import type { RequestContext } from '../utils/request-budget';
import { ApiError, toApiError } from '../utils/api-error';

/** App Store Connect's maximum page size for every offer list and offer price list */
export const APPLE_OFFER_PAGE_LIMIT = 200;
/** Offers whose prices are read at the same time */
export const OFFER_PRICE_READ_CONCURRENCY = 4;

const PRICE_FIELDS = {
  include: 'territory,subscriptionPricePoint',
  'fields[subscriptionPricePoints]': 'customerPrice,proceeds',
  'fields[territories]': 'currency',
  limit: String(APPLE_OFFER_PAGE_LIMIT),
};

interface Relationship {
  data?: { id: string; type?: string } | null;
}

interface OfferPriceData {
  id: string;
  relationships?: { territory?: Relationship; subscriptionPricePoint?: Relationship };
}

interface IncludedItem {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

interface Lookups {
  points: Map<string, { customerPrice: unknown; proceeds: unknown }>;
  currencies: Map<string, string>;
}

function lookups(included: unknown[]): Lookups {
  const points = new Map<string, { customerPrice: unknown; proceeds: unknown }>();
  const currencies = new Map<string, string>();
  for (const item of included as IncludedItem[]) {
    if (item.type === 'subscriptionPricePoints' && item.attributes) {
      points.set(item.id, { customerPrice: item.attributes.customerPrice, proceeds: item.attributes.proceeds });
    } else if (item.type === 'territories' && typeof item.attributes?.currency === 'string') {
      currencies.set(item.id, item.attributes.currency);
    }
  }
  return { points, currencies };
}

/** What one price entry resolves to: a placed price, a territory problem, or an entry that can't be placed */
type PriceRead =
  | { territory: string; price: OfferTerritoryPrice }
  | { territory: string; problem: string }
  | { problem: string };

/**
 * Read one offer price entry strictly. A free trial has no price point
 * (confirmed against a real account: every free-trial territory reads that way); any
 * other mode needs one.
 */
function readPrice(
  entryId: string,
  rel: { territory?: Relationship; subscriptionPricePoint?: Relationship } | undefined,
  { points, currencies }: Lookups,
  mode: OfferMode | null
): PriceRead {
  const alpha3 = rel?.territory?.data?.id;
  if (!alpha3) return { problem: `price ${entryId} has no territory` };
  const territory = alpha3ToAlpha2(alpha3);
  if (!territory) return { problem: `price ${entryId} names unknown territory ${alpha3}` };
  const currency = currencies.get(alpha3);
  const pointId = rel?.subscriptionPricePoint?.data?.id;

  if (mode === 'FREE_TRIAL' && !pointId) {
    return currency
      ? { territory, price: { currency, amount: '0', free: true } }
      : { territory, problem: `price ${entryId} in ${territory} has no currency` };
  }
  if (!pointId) return { territory, problem: `price ${entryId} in ${territory} has no price point` };
  const point = points.get(pointId);
  if (!point) return { territory, problem: `price ${entryId} in ${territory}: price point ${pointId} was not returned` };
  if (!isDecimalString(point.customerPrice)) return { territory, problem: `price ${entryId} in ${territory}: unreadable customer price` };
  if (!currency) return { territory, problem: `price ${entryId} in ${territory} has no currency` };
  return {
    territory,
    price: {
      currency,
      amount: normalizeDecimal(point.customerPrice),
      pricePointId: pointId,
      ...(isDecimalString(point.proceeds) ? { proceeds: normalizeDecimal(point.proceeds) } : {}),
    },
  };
}

/** Place price reads on an offer. Two entries for one territory make that territory a problem. */
function placePrices(offer: StoreOffer, reads: PriceRead[]): void {
  const seen = new Map<string, number>();
  for (const read of reads) {
    if (!('territory' in read)) {
      (offer.problems ??= []).push(read.problem);
      continue;
    }
    const count = (seen.get(read.territory) ?? 0) + 1;
    seen.set(read.territory, count);
    if (count > 1) {
      delete offer.prices[read.territory];
      (offer.territoryProblems ??= {})[read.territory] = `${count} prices for one territory`;
      continue;
    }
    if ('price' in read) offer.prices[read.territory] = read.price;
    else (offer.territoryProblems ??= {})[read.territory] = read.problem;
  }
}

function readMode(value: unknown, problems: string[]): OfferMode | null {
  if (typeof value === 'string' && (OFFER_MODES as readonly string[]).includes(value)) return value as OfferMode;
  problems.push(`unknown offer mode ${JSON.stringify(value)}`);
  return null;
}

function newOffer(
  kind: AppleOfferKind,
  storeId: string,
  key: string,
  attributes: Record<string, unknown> | undefined,
  periodsAttribute: 'numberOfPeriods' | 'periodCount'
): StoreOffer {
  const problems: string[] = [];
  const offer: StoreOffer = { kind, storeId, key, mode: null, duration: null, prices: {} };
  offer.mode = readMode(attributes?.offerMode, problems);
  const duration = appleDurationToIso(attributes?.duration);
  if (duration) offer.duration = duration;
  else problems.push(`unknown offer duration ${JSON.stringify(attributes?.duration)}`);
  const periods = attributes?.[periodsAttribute];
  if (typeof periods === 'number') offer.periods = periods;
  if (problems.length) offer.problems = problems;
  return offer;
}

/** Read every page of an offer's price list (promotional offer, offer code or win-back offer) */
async function listOfferPrices(
  connection: AppleConnection,
  path: string,
  priceType: 'subscriptionPromotionalOfferPrices' | 'subscriptionOfferCodePrices' | 'winBackOfferPrices',
  ctx: RequestContext
): Promise<{ data: OfferPriceData[]; included: unknown[] }> {
  return appleListAll<OfferPriceData>(connection, path, {
    queryParams: { ...PRICE_FIELDS, [`fields[${priceType}]`]: 'territory,subscriptionPricePoint' },
    budget: ctx.budget,
  });
}

/** Narrow a list read to one offer (by store ID or key) before any price is read */
export interface OfferListOptions {
  only?: string;
}

function pick(offers: StoreOffer[], options: OfferListOptions): StoreOffer[] {
  return options.only === undefined ? offers : offers.filter((o) => o.storeId === options.only || o.key === options.only);
}

async function withPrices(
  connection: AppleConnection,
  offers: StoreOffer[],
  pathFor: (offer: StoreOffer) => string,
  priceType: 'subscriptionPromotionalOfferPrices' | 'subscriptionOfferCodePrices' | 'winBackOfferPrices',
  ctx: RequestContext
): Promise<StoreOffer[]> {
  await mapWithConcurrency(offers, OFFER_PRICE_READ_CONCURRENCY, async (offer) => {
    const page = await listOfferPrices(connection, pathFor(offer), priceType, ctx);
    const refs = lookups(page.included);
    const reads = page.data.map((p) => readPrice(p.id, p.relationships, refs, offer.mode));
    placePrices(offer, reads);
    // Keep each placed price's own ID: a price replace (promotional offers) sends unchanged territories by ID
    page.data.forEach((p, i) => {
      const read = reads[i];
      if ('territory' in read && offer.prices[read.territory]) (offer.priceRefs ??= {})[read.territory] = p.id;
    });
  });
  return offers;
}

// ---------------------------------------------------------------------------
// Introductory offers: one resource per territory

interface IntroOfferData {
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: { territory?: Relationship; subscriptionPricePoint?: Relationship };
}

/**
 * Introductory offers of a subscription, grouped by their terms (mode,
 * duration, periods, start and end date): Apple stores one offer per
 * territory, while the core models one offer with a price per territory.
 */
export async function listSubscriptionIntroductoryOffers(
  connection: AppleConnection,
  subscriptionId: string,
  ctx: RequestContext = {},
  options: OfferListOptions = {}
): Promise<StoreOffer[]> {
  try {
    const page = await appleListAll<IntroOfferData>(connection, `/subscriptions/${encodeURIComponent(subscriptionId)}/introductoryOffers`, {
      queryParams: {
        ...PRICE_FIELDS,
        'fields[subscriptionIntroductoryOffers]': 'startDate,endDate,duration,offerMode,numberOfPeriods,territory,subscriptionPricePoint',
      },
      budget: ctx.budget,
    });
    const refs = lookups(page.included);
    const groups = new Map<string, { offer: StoreOffer; reads: PriceRead[] }>();
    for (const item of page.data) {
      const a = item.attributes ?? {};
      const start = typeof a.startDate === 'string' ? a.startDate : undefined;
      const end = typeof a.endDate === 'string' ? a.endDate : undefined;
      const key = ['intro', a.offerMode, a.duration, a.numberOfPeriods ?? 1, start ?? '', end ?? ''].join(':');
      let group = groups.get(key);
      if (!group) {
        const offer = newOffer('apple.intro', key, key, a, 'numberOfPeriods');
        offer.eligibility = { type: 'apple.intro' };
        if (start || end) offer.schedule = { ...(start ? { start } : {}), ...(end ? { end } : {}) };
        offer.storeRefs = {};
        group = { offer, reads: [] };
        groups.set(key, group);
      }
      const read = readPrice(item.id, item.relationships, refs, group.offer.mode);
      if ('territory' in read) group.offer.storeRefs![read.territory] = item.id;
      group.reads.push(read);
    }
    const offers = [...groups.values()].map(({ offer, reads }) => {
      placePrices(offer, reads);
      return offer;
    });
    return pick(offers, options);
  } catch (error) {
    throw toApiError(error, 'apple');
  }
}

// ---------------------------------------------------------------------------
// Promotional offers

interface OfferData {
  id: string;
  attributes?: Record<string, unknown>;
}

function promoFrom(item: OfferData): StoreOffer {
  const a = item.attributes ?? {};
  const offer = newOffer('apple.promo', item.id, typeof a.offerCode === 'string' ? a.offerCode : item.id, a, 'numberOfPeriods');
  if (typeof a.name === 'string') offer.name = a.name;
  offer.eligibility = { type: 'apple.developerDetermined' };
  return offer;
}

export async function listSubscriptionPromotionalOffers(
  connection: AppleConnection,
  subscriptionId: string,
  ctx: RequestContext = {},
  options: OfferListOptions = {}
): Promise<StoreOffer[]> {
  try {
    // Prices are read per offer: the list's include=prices is capped at 50 per offer
    const page = await appleListAll<OfferData>(connection, `/subscriptions/${encodeURIComponent(subscriptionId)}/promotionalOffers`, {
      queryParams: {
        'fields[subscriptionPromotionalOffers]': 'duration,name,numberOfPeriods,offerCode,offerMode',
        limit: String(APPLE_OFFER_PAGE_LIMIT),
      },
      budget: ctx.budget,
    });
    return await withPrices(
      connection,
      pick(page.data.map(promoFrom), options),
      (o) => `/subscriptionPromotionalOffers/${encodeURIComponent(o.storeId)}/prices`,
      'subscriptionPromotionalOfferPrices',
      ctx
    );
  } catch (error) {
    throw toApiError(error, 'apple');
  }
}

// ---------------------------------------------------------------------------
// Offer codes

function offerCodeFrom(item: OfferData): StoreOffer {
  const a = item.attributes ?? {};
  const offer = newOffer('apple.offerCode', item.id, typeof a.name === 'string' ? a.name : item.id, a, 'numberOfPeriods');
  if (typeof a.name === 'string') offer.name = a.name;
  const customer = Array.isArray(a.customerEligibilities) ? a.customerEligibilities.filter((c): c is 'NEW' | 'EXISTING' | 'EXPIRED' => c === 'NEW' || c === 'EXISTING' || c === 'EXPIRED') : [];
  const stacking = a.offerEligibility === 'STACK_WITH_INTRO_OFFERS' || a.offerEligibility === 'REPLACE_INTRO_OFFERS' ? a.offerEligibility : undefined;
  if (stacking) offer.eligibility = { type: 'apple.offerCode', customerEligibilities: customer, offerEligibility: stacking };
  else (offer.problems ??= []).push(`unknown offerEligibility ${JSON.stringify(a.offerEligibility)}`);
  const status: Record<string, string | number | boolean | null> = {};
  for (const field of ['active', 'autoRenewEnabled', 'totalNumberOfCodes', 'productionCodeCount', 'sandboxCodeCount'] as const) {
    const v = a[field];
    if (typeof v === 'boolean' || typeof v === 'number') status[field] = v;
  }
  if (Object.keys(status).length) offer.status = status;
  return offer;
}

export async function listSubscriptionOfferCodes(
  connection: AppleConnection,
  subscriptionId: string,
  ctx: RequestContext = {},
  options: OfferListOptions = {}
): Promise<StoreOffer[]> {
  try {
    const page = await appleListAll<OfferData>(connection, `/subscriptions/${encodeURIComponent(subscriptionId)}/offerCodes`, {
      queryParams: {
        'fields[subscriptionOfferCodes]':
          'name,customerEligibilities,offerEligibility,duration,offerMode,numberOfPeriods,totalNumberOfCodes,productionCodeCount,sandboxCodeCount,active,autoRenewEnabled',
        limit: String(APPLE_OFFER_PAGE_LIMIT),
      },
      budget: ctx.budget,
    });
    return await withPrices(
      connection,
      pick(page.data.map(offerCodeFrom), options),
      (o) => `/subscriptionOfferCodes/${encodeURIComponent(o.storeId)}/prices`,
      'subscriptionOfferCodePrices',
      ctx
    );
  } catch (error) {
    throw toApiError(error, 'apple');
  }
}

// ---------------------------------------------------------------------------
// Win-back offers

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function winBackFrom(item: OfferData): StoreOffer {
  const a = item.attributes ?? {};
  const offer = newOffer('apple.winBack', item.id, typeof a.offerId === 'string' ? a.offerId : item.id, a, 'periodCount');
  if (typeof a.referenceName === 'string') offer.name = a.referenceName;
  const paid = nonNegativeInt(a.customerEligibilityPaidSubscriptionDurationInMonths);
  const since = a.customerEligibilityTimeSinceLastSubscribedInMonths as { minimum?: unknown; maximum?: unknown } | undefined;
  const min = nonNegativeInt(since?.minimum);
  const max = nonNegativeInt(since?.maximum);
  const wait = nonNegativeInt(a.customerEligibilityWaitBetweenOffersInMonths);
  if (paid !== undefined && min !== undefined && max !== undefined) {
    const eligibility: OfferEligibility = {
      type: 'apple.winBack',
      paidSubscriptionDurationInMonths: paid,
      timeSinceLastSubscribedInMonths: { minimum: min, maximum: max },
      ...(wait !== undefined ? { waitBetweenOffersInMonths: wait } : {}),
    };
    offer.eligibility = eligibility;
  } else {
    (offer.problems ??= []).push('win-back eligibility is incomplete');
  }
  const start = typeof a.startDate === 'string' ? a.startDate : undefined;
  const end = typeof a.endDate === 'string' ? a.endDate : undefined;
  if (start || end) offer.schedule = { ...(start ? { start } : {}), ...(end ? { end } : {}) };
  const status: Record<string, string | number | boolean | null> = {};
  if (typeof a.priority === 'string') status.priority = a.priority;
  if (typeof a.promotionIntent === 'string') status.promotionIntent = a.promotionIntent;
  if (Object.keys(status).length) offer.status = status;
  return offer;
}

export async function listSubscriptionWinBackOffers(
  connection: AppleConnection,
  subscriptionId: string,
  ctx: RequestContext = {},
  options: OfferListOptions = {}
): Promise<StoreOffer[]> {
  try {
    const page = await appleListAll<OfferData>(connection, `/subscriptions/${encodeURIComponent(subscriptionId)}/winBackOffers`, {
      queryParams: {
        'fields[winBackOffers]':
          'referenceName,offerId,duration,offerMode,periodCount,customerEligibilityPaidSubscriptionDurationInMonths,customerEligibilityTimeSinceLastSubscribedInMonths,customerEligibilityWaitBetweenOffersInMonths,startDate,endDate,priority,promotionIntent',
        limit: String(APPLE_OFFER_PAGE_LIMIT),
      },
      budget: ctx.budget,
    });
    return await withPrices(
      connection,
      pick(page.data.map(winBackFrom), options),
      (o) => `/winBackOffers/${encodeURIComponent(o.storeId)}/prices`,
      'winBackOfferPrices',
      ctx
    );
  } catch (error) {
    throw toApiError(error, 'apple');
  }
}

export const LISTERS: Record<AppleOfferKind, typeof listSubscriptionPromotionalOffers> = {
  'apple.intro': listSubscriptionIntroductoryOffers,
  'apple.promo': listSubscriptionPromotionalOffers,
  'apple.offerCode': listSubscriptionOfferCodes,
  'apple.winBack': listSubscriptionWinBackOffers,
};

/**
 * One offer of a subscription, by store ID or key, with its prices. Read
 * through the subscription's own list, so an ID from another subscription is
 * never found. Returns null when there is no such offer.
 */
export async function getSubscriptionOffer(
  connection: AppleConnection,
  subscriptionId: string,
  kind: AppleOfferKind,
  idOrKey: string,
  ctx: RequestContext = {}
): Promise<StoreOffer | null> {
  const found = await LISTERS[kind](connection, subscriptionId, ctx, { only: idOrKey });
  if (found.length > 1) {
    throw new ApiError(`${found.length} ${kind} offers match ${idOrKey}; use the store ID`, {
      status: 409,
      code: 'AMBIGUOUS_OFFER',
      platform: 'apple',
      retryable: false,
    });
  }
  return found[0] ?? null;
}

/** Every offer of one kind of a subscription, each with its prices */
export async function listSubscriptionOffersOfKind(
  connection: AppleConnection,
  subscriptionId: string,
  kind: AppleOfferKind,
  ctx: RequestContext = {}
): Promise<StoreOffer[]> {
  return LISTERS[kind](connection, subscriptionId, ctx);
}

/** Every offer of a subscription, all four kinds, each with its prices */
export async function listSubscriptionOffers(
  connection: AppleConnection,
  subscriptionId: string,
  ctx: RequestContext = {}
): Promise<StoreOffer[]> {
  // One kind after another: each kind already reads its prices concurrently
  const intro = await listSubscriptionIntroductoryOffers(connection, subscriptionId, ctx);
  const promo = await listSubscriptionPromotionalOffers(connection, subscriptionId, ctx);
  const codes = await listSubscriptionOfferCodes(connection, subscriptionId, ctx);
  const winBack = await listSubscriptionWinBackOffers(connection, subscriptionId, ctx);
  return [...intro, ...promo, ...codes, ...winBack];
}
