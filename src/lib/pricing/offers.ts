// Subscription offers: the desired-state spec (OfferSpec) and the read model
// adapters fill in (StoreOffer). Framework-free, like the rest of the core.
//
// Phase 2a is read-only: offers can be read, derived and checked for drift,
// but no plan op creates or changes one yet (the ChangeSet offer op kinds stay
// reserved, see RESERVED_OP_KINDS in changeset.ts).

import { z } from 'zod';
import { compareDecimal, isDecimalString, normalizeDecimal, type Decimal } from './decimal';
import type { ProductRef } from './model';
import { productRefSchema } from './changeset';
import type { SnapMode } from './snap';

export const OFFER_SPEC_SCHEMA_VERSION = 1 as const;

export const APPLE_OFFER_KINDS = ['apple.intro', 'apple.promo', 'apple.offerCode', 'apple.winBack'] as const;
/** play.offer is modelled so specs stay forward compatible; nothing reads or derives it yet (Phase 3) */
export const OFFER_KINDS = [...APPLE_OFFER_KINDS, 'play.offer'] as const;
export type AppleOfferKind = (typeof APPLE_OFFER_KINDS)[number];
export type OfferKind = (typeof OFFER_KINDS)[number];

export const OFFER_MODES = ['FREE_TRIAL', 'PAY_AS_YOU_GO', 'PAY_UP_FRONT'] as const;
export type OfferMode = (typeof OFFER_MODES)[number];

/**
 * ISO 8601 durations the core understands. Apple's offer durations map onto
 * these one to one (THREE_DAYS = P3D ... ONE_YEAR = P1Y); Play uses ISO
 * durations natively.
 */
export const OFFER_DURATIONS = ['P3D', 'P1W', 'P2W', 'P1M', 'P2M', 'P3M', 'P6M', 'P1Y'] as const;
export type OfferDuration = (typeof OFFER_DURATIONS)[number];

/** Subscription billing periods (Apple: ONE_WEEK ... ONE_YEAR) */
export const BILLING_PERIODS = ['P1W', 'P1M', 'P2M', 'P3M', 'P6M', 'P1Y'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

const APPLE_DURATIONS: Record<string, OfferDuration> = {
  THREE_DAYS: 'P3D',
  ONE_WEEK: 'P1W',
  TWO_WEEKS: 'P2W',
  ONE_MONTH: 'P1M',
  TWO_MONTHS: 'P2M',
  THREE_MONTHS: 'P3M',
  SIX_MONTHS: 'P6M',
  ONE_YEAR: 'P1Y',
};

/** Apple offer duration enum (e.g. "ONE_YEAR") -> ISO duration; undefined if unknown */
export function appleDurationToIso(value: unknown): OfferDuration | undefined {
  return typeof value === 'string' ? APPLE_DURATIONS[value] : undefined;
}

/** Apple subscriptionPeriod enum (e.g. "ONE_MONTH") -> ISO billing period; undefined if unknown */
export function appleSubscriptionPeriodToIso(value: unknown): BillingPeriod | undefined {
  const iso = appleDurationToIso(value);
  return iso && (BILLING_PERIODS as readonly string[]).includes(iso) ? (iso as BillingPeriod) : undefined;
}

/** A duration as a whole number of days (D/W) or months (M/Y). Months and days don't convert exactly. */
export function durationParts(duration: OfferDuration | BillingPeriod): { unit: 'day' | 'month'; count: number } {
  const match = /^P(\d+)([DWMY])$/.exec(duration);
  if (!match) throw new RangeError(`Unsupported duration ${duration}`);
  const n = Number(match[1]);
  switch (match[2]) {
    case 'D':
      return { unit: 'day', count: n };
    case 'W':
      return { unit: 'day', count: n * 7 };
    case 'M':
      return { unit: 'month', count: n };
    default:
      return { unit: 'month', count: n * 12 };
  }
}

/**
 * offerDuration / billingPeriod as an exact fraction, or undefined when the
 * two are counted in different units (a week-based offer on a monthly
 * subscription has no exact ratio).
 */
export function durationRatio(offer: OfferDuration, billing: BillingPeriod): { numerator: number; denominator: number } | undefined {
  const a = durationParts(offer);
  const b = durationParts(billing);
  if (a.unit !== b.unit) return undefined;
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  const g = gcd(a.count, b.count);
  return { numerator: a.count / g, denominator: b.count / g };
}

// ---------------------------------------------------------------------------
// Pricing rules

/**
 * "X% of each territory's own current price", snapped to that territory's
 * valid price points.
 *
 * perPeriod         - offer price = current price x percent
 * totalOverDuration - offer price = current price x percent x (offer duration / billing period),
 *                     e.g. a 1-year pay-up-front offer on a monthly subscription = 12 x P x percent
 */
export interface PercentOfCurrentRule {
  type: 'percentOfCurrent';
  /** Percent of the current price, as a decimal string: "50" = half price */
  percent: Decimal;
  basis: 'perPeriod' | 'totalOverDuration';
  snap: SnapMode;
}

export type OfferPricingRule =
  | PercentOfCurrentRule
  | { type: 'fixed'; prices: Record<string, Decimal> }
  | { type: 'free' }
  /** Play only: a native relative discount that follows the base price by itself */
  | { type: 'play.relativeDiscount'; fraction: Decimal }
  /** Play only: a fixed amount off per region */
  | { type: 'play.absoluteDiscount'; amounts: Record<string, Decimal> };

// ---------------------------------------------------------------------------
// Eligibility

export const APPLE_CUSTOMER_ELIGIBILITIES = ['NEW', 'EXISTING', 'EXPIRED'] as const;
export const APPLE_OFFER_CODE_ELIGIBILITIES = ['STACK_WITH_INTRO_OFFERS', 'REPLACE_INTRO_OFFERS'] as const;

export type OfferEligibility =
  /** Introductory offer: Apple decides (customers new to the subscription group) */
  | { type: 'apple.intro' }
  /** Promotional offer: the app decides whom to show it to (signed offer) */
  | { type: 'apple.developerDetermined' }
  | {
      type: 'apple.offerCode';
      customerEligibilities: Array<(typeof APPLE_CUSTOMER_ELIGIBILITIES)[number]>;
      offerEligibility: (typeof APPLE_OFFER_CODE_ELIGIBILITIES)[number];
    }
  | {
      type: 'apple.winBack';
      paidSubscriptionDurationInMonths: number;
      timeSinceLastSubscribedInMonths: { minimum: number; maximum: number };
      waitBetweenOffersInMonths?: number;
    }
  /** Reserved for Phase 3 (Play targeting rules); not interpreted yet */
  | { type: 'play.targeting'; rule: Record<string, unknown> };

const ELIGIBILITY_FOR_KIND: Record<OfferKind, OfferEligibility['type'][]> = {
  'apple.intro': ['apple.intro'],
  'apple.promo': ['apple.developerDetermined'],
  'apple.offerCode': ['apple.offerCode'],
  'apple.winBack': ['apple.winBack'],
  'play.offer': ['play.targeting'],
};

// ---------------------------------------------------------------------------
// The spec

export interface OfferSpec {
  /** Stable key: Apple promo offerCode, win-back offerId, offer code name; Play offerId */
  id: string;
  productRef: ProductRef;
  kind: OfferKind;
  mode: OfferMode;
  duration: OfferDuration;
  /** Number of offer periods (pay as you go); 1 otherwise */
  periods?: number;
  pricing: OfferPricingRule;
  eligibility?: OfferEligibility;
  /** Play offer tags (Phase 3) */
  tags?: string[];
  /** YYYY-MM-DD */
  schedule?: { start?: string; end?: string };
  territories: 'all' | string[];
  /** Re-derive the offer when base prices change (sync engine, Phase 4) */
  syncWithBase: boolean;
}

const decimalSchema = z
  .string()
  .refine((v) => isDecimalString(v), { message: 'must be a plain decimal string such as "4.99"' })
  .transform((v) => normalizeDecimal(v));
const territorySchema = z.string().regex(/^[A-Z]{2}$/, 'territory must be ISO 3166-1 alpha-2, e.g. "GB"');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date, YYYY-MM-DD');
const monthsSchema = z.number().int().min(0);

export const percentOfCurrentRuleSchema = z
  .object({
    type: z.literal('percentOfCurrent'),
    percent: decimalSchema,
    basis: z.enum(['perPeriod', 'totalOverDuration']),
    snap: z.enum(['nearest', 'floor', 'ceil']),
  })
  .strict()
  // A malformed percent is already reported by decimalSchema; only range-check a real decimal
  .refine((r) => !isDecimalString(r.percent) || (compareDecimal(r.percent, '0') > 0 && compareDecimal(r.percent, '100') < 0), {
    message: 'percent must be above 0 and below 100',
    path: ['percent'],
  })
  // Targets are exact fractions of each price; four places is plenty and keeps them small
  .refine((r) => !isDecimalString(r.percent) || (r.percent.split('.')[1]?.length ?? 0) <= 4, {
    message: 'percent may have at most 4 decimal places',
    path: ['percent'],
  });

const pricingSchema = z.discriminatedUnion('type', [
  percentOfCurrentRuleSchema,
  z.object({ type: z.literal('fixed'), prices: z.record(territorySchema, decimalSchema) }).strict(),
  z.object({ type: z.literal('free') }).strict(),
  z.object({ type: z.literal('play.relativeDiscount'), fraction: decimalSchema }).strict(),
  z.object({ type: z.literal('play.absoluteDiscount'), amounts: z.record(territorySchema, decimalSchema) }).strict(),
]);

const eligibilitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('apple.intro') }).strict(),
  z.object({ type: z.literal('apple.developerDetermined') }).strict(),
  z
    .object({
      type: z.literal('apple.offerCode'),
      customerEligibilities: z.array(z.enum(APPLE_CUSTOMER_ELIGIBILITIES)).min(1),
      offerEligibility: z.enum(APPLE_OFFER_CODE_ELIGIBILITIES),
    })
    .strict(),
  z
    .object({
      type: z.literal('apple.winBack'),
      paidSubscriptionDurationInMonths: monthsSchema,
      timeSinceLastSubscribedInMonths: z.object({ minimum: monthsSchema, maximum: monthsSchema }).strict(),
      waitBetweenOffersInMonths: monthsSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal('play.targeting'), rule: z.record(z.string(), z.unknown()) }).strict(),
]);

export const offerSpecSchema = z
  .object({
    id: z.string().min(1),
    productRef: productRefSchema,
    kind: z.enum(OFFER_KINDS),
    mode: z.enum(OFFER_MODES),
    duration: z.enum(OFFER_DURATIONS),
    periods: z.number().int().min(1).optional(),
    pricing: pricingSchema,
    eligibility: eligibilitySchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    schedule: z.object({ start: dateSchema.optional(), end: dateSchema.optional() }).strict().optional(),
    territories: z.union([z.literal('all'), z.array(territorySchema).min(1)]),
    syncWithBase: z.boolean(),
  })
  .strict();

export class InvalidOfferSpecError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid offer spec:\n- ${problems.join('\n- ')}`);
    this.name = 'InvalidOfferSpecError';
  }
}

/** Rules a well-formed spec must also meet (kind, mode, pricing and eligibility must fit together) */
function crossCheck(spec: OfferSpec): string[] {
  const problems: string[] = [];
  const apple = spec.kind.startsWith('apple.');
  const ref = spec.productRef;
  if (apple && !(ref.platform === 'apple' && ref.type === 'subscription')) problems.push(`${spec.kind} needs an Apple subscription productRef`);
  if (!apple && !(ref.platform === 'google' && ref.type === 'subscription')) problems.push('play.offer needs a Google Play base plan productRef');

  const free = spec.pricing.type === 'free';
  if (spec.mode === 'FREE_TRIAL' && !free) problems.push('a FREE_TRIAL offer must use pricing { type: "free" }');
  if (spec.mode !== 'FREE_TRIAL' && free) problems.push(`pricing "free" needs mode FREE_TRIAL (mode is ${spec.mode})`);
  if (apple && spec.pricing.type.startsWith('play.')) problems.push(`${spec.pricing.type} pricing is Play-only`);
  if (spec.mode !== 'PAY_AS_YOU_GO' && spec.periods !== undefined && spec.periods !== 1) {
    problems.push(`periods must be 1 for ${spec.mode} (only pay-as-you-go offers repeat)`);
  }

  if (spec.eligibility && !ELIGIBILITY_FOR_KIND[spec.kind].includes(spec.eligibility.type)) {
    problems.push(`eligibility ${spec.eligibility.type} does not fit a ${spec.kind} offer`);
  }
  if (spec.eligibility?.type === 'apple.winBack') {
    const { minimum, maximum } = spec.eligibility.timeSinceLastSubscribedInMonths;
    if (minimum > maximum) problems.push('win-back timeSinceLastSubscribedInMonths: minimum is above maximum');
  }
  if (spec.tags?.length && apple) problems.push('tags are Play-only (offerTags)');
  if (spec.schedule?.start && spec.schedule.end && spec.schedule.start > spec.schedule.end) problems.push('schedule.start is after schedule.end');
  if (spec.pricing.type === 'fixed' && spec.territories !== 'all') {
    const missing = spec.territories.filter((t) => !(t in (spec.pricing as { prices: Record<string, Decimal> }).prices));
    if (missing.length) problems.push(`fixed pricing has no price for ${missing.join(', ')}`);
  }
  return problems;
}

/** Validate an offer spec (e.g. from a JSON file). Throws InvalidOfferSpecError listing every problem. */
export function parseOfferSpec(input: unknown): OfferSpec {
  const parsed = offerSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidOfferSpecError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const spec = parsed.data as OfferSpec;
  const problems = crossCheck(spec);
  if (problems.length) throw new InvalidOfferSpecError(problems);
  return spec;
}

/** Validate a percent-of-current rule on its own (UI and route input) */
export function parsePercentOfCurrentRule(input: unknown): PercentOfCurrentRule {
  const parsed = percentOfCurrentRuleSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidOfferSpecError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return parsed.data as PercentOfCurrentRule;
}

// ---------------------------------------------------------------------------
// Read model: an offer as a store reports it

/** One territory's offer price. Free-trial territories carry free: true and amount "0". */
export interface OfferTerritoryPrice {
  currency: string;
  amount: Decimal;
  /** Apple subscription price point ID */
  pricePointId?: string;
  proceeds?: Decimal;
  free?: true;
}

export interface StoreOffer {
  kind: OfferKind;
  /**
   * Store identity of the offer. Apple: the promotional offer, offer code or
   * win-back offer resource ID. Apple introductory offers are one resource
   * per territory, so they are grouped by their terms and the group gets a
   * synthetic ID (each territory's resource ID is in storeRefs).
   */
  storeId: string;
  /** The developer's key: promo offerCode, win-back offerId, offer code name */
  key: string;
  name?: string;
  /** null when the store returned a mode or duration the core doesn't know (see problems) */
  mode: OfferMode | null;
  duration: OfferDuration | null;
  periods?: number;
  eligibility?: OfferEligibility;
  /** YYYY-MM-DD */
  schedule?: { start?: string; end?: string };
  /** Store-specific state worth showing (active, priority, code counts, ...) */
  status?: Record<string, string | number | boolean | null>;
  /** Keyed by alpha-2 territory. Only prices read without guessing are here. */
  prices: Record<string, OfferTerritoryPrice>;
  /** Territory -> why its price couldn't be read (missing price point, currency, duplicate entry) */
  territoryProblems?: Record<string, string>;
  /** Things that couldn't be placed in any territory (a price without a territory) or read at all */
  problems?: string[];
  /** Per-territory store resource IDs where the store has one per territory (Apple intro offers) */
  storeRefs?: Record<string, string>;
}
