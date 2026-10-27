// App Store Connect subscription offer writes: promotional offers,
// introductory offers, offer codes and win-back offers.
//
// Request bodies follow App Store Connect API 4.5.1 (OpenAPI spec):
//   POST   /v1/subscriptionPromotionalOffers      SubscriptionPromotionalOfferCreateRequest
//   PATCH  /v1/subscriptionPromotionalOffers/{id} SubscriptionPromotionalOfferUpdateRequest (prices only)
//   DELETE /v1/subscriptionPromotionalOffers/{id}
//   POST   /v1/subscriptionIntroductoryOffers     SubscriptionIntroductoryOfferCreateRequest (one territory each)
//   PATCH  /v1/subscriptionIntroductoryOffers/{id} SubscriptionIntroductoryOfferUpdateRequest (endDate only)
//   DELETE /v1/subscriptionIntroductoryOffers/{id}
//   POST   /v1/subscriptionOfferCodes             SubscriptionOfferCodeCreateRequest
//   PATCH  /v1/subscriptionOfferCodes/{id}        SubscriptionOfferCodeUpdateRequest (active only; there is no DELETE)
//   POST   /v1/winBackOffers                      WinBackOfferCreateRequest
//   PATCH  /v1/winBackOffers/{id}                 WinBackOfferUpdateRequest (eligibility, dates, priority; no prices)
//   DELETE /v1/winBackOffers/{id}
//
// Every helper goes through appleApiRequest, so each request is charged to
// the caller's RequestBudget, and a POST (create) is retried only on 429: a
// create that timed out or answered 5xx may exist, so it is reported and
// detected by its key on the next read, never sent twice.
//
// Confirmed on a test app with PricingKit (Oct 2026): local IDs for inline
// prices ("${price-USA}") work for promotional offer creates, and a
// promotional offer PATCH replaces the whole price list with the one sent
// (175 territories after the PATCH, no duplicates). A promo create can
// answer a transient 500 having created nothing; the next read doesn't find
// it and a resume creates it once.
// Still unconfirmed (see CLAUDE.md): the win-back inline price relationships
// (the spec lists none) and free-trial prices without a price point on create.

import { appleApiRequest } from './client';
import type { AppleConnectCredentials } from './types';
import { toAppleTerritoryId } from './subscriptions';
import type { RequestContext } from '../utils/request-budget';

export type AppleOfferMode = 'FREE_TRIAL' | 'PAY_AS_YOU_GO' | 'PAY_UP_FRONT';
export type AppleOfferDuration = 'THREE_DAYS' | 'ONE_WEEK' | 'TWO_WEEKS' | 'ONE_MONTH' | 'TWO_MONTHS' | 'THREE_MONTHS' | 'SIX_MONTHS' | 'ONE_YEAR';

const ISO_TO_APPLE_DURATION: Record<string, AppleOfferDuration> = {
  P3D: 'THREE_DAYS',
  P1W: 'ONE_WEEK',
  P2W: 'TWO_WEEKS',
  P1M: 'ONE_MONTH',
  P2M: 'TWO_MONTHS',
  P3M: 'THREE_MONTHS',
  P6M: 'SIX_MONTHS',
  P1Y: 'ONE_YEAR',
};

/** ISO offer duration (P1Y) -> Apple SubscriptionOfferDuration (ONE_YEAR) */
export function isoToAppleOfferDuration(iso: string): AppleOfferDuration {
  const value = ISO_TO_APPLE_DURATION[iso];
  if (!value) throw new RangeError(`No Apple offer duration for ${iso}`);
  return value;
}

/** One territory's offer price. pricePointId is omitted for a free trial. */
export interface OfferPriceInput {
  /** alpha-2 or alpha-3; sent as Apple's alpha-3 territory ID */
  territory: string;
  pricePointId?: string;
}

interface Ref {
  type: string;
  id: string;
}

const subscriptionRef = (id: string) => ({ data: { type: 'subscriptions', id } });

/** Local ID for an inline-created price, unique per territory within one request */
export function inlinePriceId(territoryAlpha3: string): string {
  return `\${price-${territoryAlpha3}}`;
}

/** The `prices` relationship plus `included` inline prices of a create or update request */
function inlinePrices(type: string, prices: OfferPriceInput[]): { data: Ref[]; included: unknown[] } {
  const seen = new Set<string>();
  const data: Ref[] = [];
  const included: unknown[] = [];
  for (const price of prices) {
    const alpha3 = toAppleTerritoryId(price.territory);
    if (seen.has(alpha3)) throw new RangeError(`Two prices for territory ${alpha3}`);
    seen.add(alpha3);
    const id = inlinePriceId(alpha3);
    data.push({ type, id });
    included.push({
      type,
      id,
      relationships: {
        territory: { data: { type: 'territories', id: alpha3 } },
        ...(price.pricePointId ? { subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: price.pricePointId } } } : {}),
      },
    });
  }
  return { data, included };
}

type Created = { data?: { id?: string } };

function createdId(response: Created, what: string): string {
  const id = response?.data?.id;
  if (!id) throw new Error(`App Store Connect created the ${what} but returned no ID`);
  return id;
}

// ---------------------------------------------------------------------------
// Promotional offers

export interface PromotionalOfferInput {
  subscriptionId: string;
  /** Reference name in App Store Connect */
  name: string;
  /** The code the app signs offers with; unique across the subscription group */
  offerCode: string;
  duration: AppleOfferDuration;
  offerMode: AppleOfferMode;
  numberOfPeriods: number;
  prices: OfferPriceInput[];
}

export function promotionalOfferCreateBody(input: PromotionalOfferInput) {
  const prices = inlinePrices('subscriptionPromotionalOfferPrices', input.prices);
  return {
    data: {
      type: 'subscriptionPromotionalOffers',
      attributes: {
        duration: input.duration,
        name: input.name,
        numberOfPeriods: input.numberOfPeriods,
        offerCode: input.offerCode,
        offerMode: input.offerMode,
      },
      relationships: {
        subscription: subscriptionRef(input.subscriptionId),
        prices: { data: prices.data },
      },
    },
    included: prices.included,
  };
}

export async function createPromotionalOffer(credentials: AppleConnectCredentials, input: PromotionalOfferInput, ctx: RequestContext = {}): Promise<{ id: string }> {
  const response = await appleApiRequest<Created>(credentials, '/subscriptionPromotionalOffers', {
    method: 'POST',
    body: promotionalOfferCreateBody(input),
    budget: ctx.budget,
  });
  return { id: createdId(response, 'promotional offer') };
}

/**
 * Body for replacing a promotional offer's prices: unchanged territories by
 * their existing price ID, changed or new ones as inline creates. The list is
 * the offer's complete price list.
 */
export function promotionalOfferPricesUpdateBody(offerId: string, keep: string[], add: OfferPriceInput[]) {
  const prices = inlinePrices('subscriptionPromotionalOfferPrices', add);
  return {
    data: {
      type: 'subscriptionPromotionalOffers',
      id: offerId,
      relationships: {
        prices: { data: [...keep.map((id) => ({ type: 'subscriptionPromotionalOfferPrices', id })), ...prices.data] },
      },
    },
    included: prices.included,
  };
}

export async function replacePromotionalOfferPrices(
  credentials: AppleConnectCredentials,
  offerId: string,
  keep: string[],
  add: OfferPriceInput[],
  ctx: RequestContext = {}
): Promise<void> {
  await appleApiRequest(credentials, `/subscriptionPromotionalOffers/${encodeURIComponent(offerId)}`, {
    method: 'PATCH',
    body: promotionalOfferPricesUpdateBody(offerId, keep, add),
    budget: ctx.budget,
  });
}

export async function deletePromotionalOffer(credentials: AppleConnectCredentials, offerId: string, ctx: RequestContext = {}): Promise<void> {
  await appleApiRequest(credentials, `/subscriptionPromotionalOffers/${encodeURIComponent(offerId)}`, { method: 'DELETE', budget: ctx.budget });
}

// ---------------------------------------------------------------------------
// Introductory offers (one resource per territory)

export interface IntroductoryOfferInput {
  subscriptionId: string;
  territory: string;
  /** Omitted for a free trial */
  pricePointId?: string;
  duration: AppleOfferDuration;
  offerMode: AppleOfferMode;
  numberOfPeriods: number;
  /** YYYY-MM-DD; omitted = starts now */
  startDate?: string;
  /** YYYY-MM-DD; omitted = no end */
  endDate?: string;
}

export function introductoryOfferCreateBody(input: IntroductoryOfferInput) {
  return {
    data: {
      type: 'subscriptionIntroductoryOffers',
      attributes: {
        duration: input.duration,
        offerMode: input.offerMode,
        numberOfPeriods: input.numberOfPeriods,
        ...(input.startDate ? { startDate: input.startDate } : {}),
        ...(input.endDate ? { endDate: input.endDate } : {}),
      },
      relationships: {
        subscription: subscriptionRef(input.subscriptionId),
        territory: { data: { type: 'territories', id: toAppleTerritoryId(input.territory) } },
        ...(input.pricePointId ? { subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: input.pricePointId } } } : {}),
      },
    },
  };
}

export async function createIntroductoryOffer(credentials: AppleConnectCredentials, input: IntroductoryOfferInput, ctx: RequestContext = {}): Promise<{ id: string }> {
  const response = await appleApiRequest<Created>(credentials, '/subscriptionIntroductoryOffers', {
    method: 'POST',
    body: introductoryOfferCreateBody(input),
    budget: ctx.budget,
  });
  return { id: createdId(response, 'introductory offer') };
}

export function introductoryOfferEndDateBody(id: string, endDate: string | null) {
  return { data: { type: 'subscriptionIntroductoryOffers', id, attributes: { endDate } } };
}

/** Set (or clear, with null) an introductory offer's end date */
export async function setIntroductoryOfferEndDate(credentials: AppleConnectCredentials, id: string, endDate: string | null, ctx: RequestContext = {}): Promise<void> {
  await appleApiRequest(credentials, `/subscriptionIntroductoryOffers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: introductoryOfferEndDateBody(id, endDate),
    budget: ctx.budget,
  });
}

export async function deleteIntroductoryOffer(credentials: AppleConnectCredentials, id: string, ctx: RequestContext = {}): Promise<void> {
  await appleApiRequest(credentials, `/subscriptionIntroductoryOffers/${encodeURIComponent(id)}`, { method: 'DELETE', budget: ctx.budget });
}

// ---------------------------------------------------------------------------
// Offer codes

export interface OfferCodeInput {
  subscriptionId: string;
  name: string;
  customerEligibilities: Array<'NEW' | 'EXISTING' | 'EXPIRED'>;
  offerEligibility: 'STACK_WITH_INTRO_OFFERS' | 'REPLACE_INTRO_OFFERS';
  duration: AppleOfferDuration;
  offerMode: AppleOfferMode;
  numberOfPeriods: number;
  autoRenewEnabled?: boolean;
  prices: OfferPriceInput[];
}

export function offerCodeCreateBody(input: OfferCodeInput) {
  const prices = inlinePrices('subscriptionOfferCodePrices', input.prices);
  return {
    data: {
      type: 'subscriptionOfferCodes',
      attributes: {
        name: input.name,
        customerEligibilities: input.customerEligibilities,
        offerEligibility: input.offerEligibility,
        duration: input.duration,
        offerMode: input.offerMode,
        numberOfPeriods: input.numberOfPeriods,
        ...(input.autoRenewEnabled !== undefined ? { autoRenewEnabled: input.autoRenewEnabled } : {}),
      },
      relationships: {
        subscription: subscriptionRef(input.subscriptionId),
        prices: { data: prices.data },
      },
    },
    included: prices.included,
  };
}

export async function createOfferCode(credentials: AppleConnectCredentials, input: OfferCodeInput, ctx: RequestContext = {}): Promise<{ id: string }> {
  const response = await appleApiRequest<Created>(credentials, '/subscriptionOfferCodes', {
    method: 'POST',
    body: offerCodeCreateBody(input),
    budget: ctx.budget,
  });
  return { id: createdId(response, 'offer code') };
}

export function offerCodeActiveBody(id: string, active: boolean) {
  return { data: { type: 'subscriptionOfferCodes', id, attributes: { active } } };
}

export async function setOfferCodeActive(credentials: AppleConnectCredentials, id: string, active: boolean, ctx: RequestContext = {}): Promise<void> {
  await appleApiRequest(credentials, `/subscriptionOfferCodes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: offerCodeActiveBody(id, active),
    budget: ctx.budget,
  });
}

// ---------------------------------------------------------------------------
// Win-back offers

export interface WinBackOfferInput {
  subscriptionId: string;
  referenceName: string;
  offerId: string;
  duration: AppleOfferDuration;
  offerMode: AppleOfferMode;
  periodCount: number;
  paidSubscriptionDurationInMonths: number;
  timeSinceLastSubscribedInMonths: { minimum: number; maximum: number };
  waitBetweenOffersInMonths?: number;
  startDate: string;
  endDate?: string;
  priority: 'HIGH' | 'NORMAL';
  promotionIntent?: 'NOT_PROMOTED' | 'USE_AUTO_GENERATED_ASSETS';
  prices: OfferPriceInput[];
}

export function winBackOfferCreateBody(input: WinBackOfferInput) {
  const prices = inlinePrices('winBackOfferPrices', input.prices);
  return {
    data: {
      type: 'winBackOffers',
      attributes: {
        referenceName: input.referenceName,
        offerId: input.offerId,
        duration: input.duration,
        offerMode: input.offerMode,
        periodCount: input.periodCount,
        customerEligibilityPaidSubscriptionDurationInMonths: input.paidSubscriptionDurationInMonths,
        customerEligibilityTimeSinceLastSubscribedInMonths: {
          minimum: input.timeSinceLastSubscribedInMonths.minimum,
          maximum: input.timeSinceLastSubscribedInMonths.maximum,
        },
        ...(input.waitBetweenOffersInMonths !== undefined ? { customerEligibilityWaitBetweenOffersInMonths: input.waitBetweenOffersInMonths } : {}),
        startDate: input.startDate,
        ...(input.endDate ? { endDate: input.endDate } : {}),
        priority: input.priority,
        ...(input.promotionIntent ? { promotionIntent: input.promotionIntent } : {}),
      },
      relationships: {
        subscription: subscriptionRef(input.subscriptionId),
        prices: { data: prices.data },
      },
    },
    included: prices.included,
  };
}

export async function createWinBackOffer(credentials: AppleConnectCredentials, input: WinBackOfferInput, ctx: RequestContext = {}): Promise<{ id: string }> {
  const response = await appleApiRequest<Created>(credentials, '/winBackOffers', {
    method: 'POST',
    body: winBackOfferCreateBody(input),
    budget: ctx.budget,
  });
  return { id: createdId(response, 'win-back offer') };
}

export interface WinBackOfferUpdate {
  paidSubscriptionDurationInMonths?: number;
  timeSinceLastSubscribedInMonths?: { minimum: number; maximum: number };
  waitBetweenOffersInMonths?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  priority?: 'HIGH' | 'NORMAL';
  promotionIntent?: 'NOT_PROMOTED' | 'USE_AUTO_GENERATED_ASSETS';
}

export function winBackOfferUpdateBody(id: string, update: WinBackOfferUpdate) {
  const attributes: Record<string, unknown> = {};
  if (update.paidSubscriptionDurationInMonths !== undefined) attributes.customerEligibilityPaidSubscriptionDurationInMonths = update.paidSubscriptionDurationInMonths;
  if (update.timeSinceLastSubscribedInMonths) attributes.customerEligibilityTimeSinceLastSubscribedInMonths = { ...update.timeSinceLastSubscribedInMonths };
  if (update.waitBetweenOffersInMonths !== undefined) attributes.customerEligibilityWaitBetweenOffersInMonths = update.waitBetweenOffersInMonths;
  if (update.startDate !== undefined) attributes.startDate = update.startDate;
  if (update.endDate !== undefined) attributes.endDate = update.endDate;
  if (update.priority) attributes.priority = update.priority;
  if (update.promotionIntent) attributes.promotionIntent = update.promotionIntent;
  return { data: { type: 'winBackOffers', id, attributes } };
}

export async function updateWinBackOffer(credentials: AppleConnectCredentials, id: string, update: WinBackOfferUpdate, ctx: RequestContext = {}): Promise<void> {
  await appleApiRequest(credentials, `/winBackOffers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: winBackOfferUpdateBody(id, update),
    budget: ctx.budget,
  });
}

export async function deleteWinBackOffer(credentials: AppleConnectCredentials, id: string, ctx: RequestContext = {}): Promise<void> {
  await appleApiRequest(credentials, `/winBackOffers/${encodeURIComponent(id)}`, { method: 'DELETE', budget: ctx.budget });
}
