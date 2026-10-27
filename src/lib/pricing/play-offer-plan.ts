// Google Play offer plans: an OfferSpec (kind play.offer) plus what Play holds
// now -> a ChangeSet of Play offer ops and a per-region preview (base price,
// offer price, discount), with each offer's eligibility, phases and tags.
// Pure: the Play adapter reads the base plan, its offers and Play's own
// prices for percent-of-current targets, and passes them in.
//
// Pricing types on Play:
//   play.relativeDiscount - Play's native "X% off": the offer follows the base
//                           price by itself, so it never needs a sync
//   play.absoluteDiscount - a fixed amount off the base price, per region
//   fixed                 - a fixed offer price per region
//   percentOfCurrent      - X% of each region's own base price, made a valid
//                           Play price with Play's price conversion
//                           (convertRegionPrices); written as a fixed price
//   free                  - free trial

import {
  CHANGESET_KIND,
  CHANGESET_SCHEMA_VERSION,
  changeSetHash,
  checkChangeSetRules,
  ChangeSetValidationError,
  type ChangeSet,
  type PlanSkip,
} from './changeset';
import {
  compareDecimal,
  divideDecimal,
  isDecimalString,
  multiplyDecimal,
  normalizeDecimal,
  roundDecimal,
  subtractDecimal,
  type Decimal,
} from './decimal';
import { productKey, type AppRef, type ProductPriceState, type ProductRef } from './model';
import { DEFAULT_OFFER_DEVIATION_THRESHOLD, MAX_PERCENT_SCALE } from './offer-derivation';
import type { OfferPlan, OfferPlanEntry, OfferRefusalCode } from './offer-plan';
import type { OfferPricingRule, OfferSpec, PercentOfCurrentRule, StoreOffer } from './offers';
import {
  changedPlayRegions,
  computePlayOfferIdempotencyKey,
  describePlayPhase,
  describePlayTargeting,
  playDurationRatio,
  trimPercent,
  samePlayOfferContent,
  samePlayPhaseTerms,
  sameTargeting,
  storeOfferProblems,
  type PlayOfferOp,
  type PlayOfferOpKind,
  type PlayOfferState,
  type PlayPhaseRegionPrice,
  type PlayTargeting,
} from './play-offers';
import { currencyScale } from './rounding';
import { deviationRatio } from './snap';

// ---------------------------------------------------------------------------
// Derivation: one phase's price in every region

export type PlayFlagCode =
  | 'NO_CURRENT_PRICE'
  | 'CURRENCY_MISMATCH'
  | 'NO_PLAY_PRICE'
  | 'NOT_BELOW_CURRENT'
  | 'DISCOUNT_TOO_LARGE'
  | 'NO_AMOUNT'
  | 'SPAN_NOT_COMPARABLE'
  | 'INVALID_AMOUNT'
  | 'DEVIATION_ABOVE_THRESHOLD';

export interface PlayFlag {
  code: PlayFlagCode;
  severity: 'error' | 'warning';
  message: string;
}

/** One preview row: a region's base price, the offer's price and the discount */
export interface PlayPreviewRow {
  region: string;
  currency: string;
  /** The region's base plan price (per billing period) */
  basePrice: Decimal | null;
  /** The base price over one recurrence of the phase (base x phase duration / billing period); null when weeks meet months */
  proratedBase: Decimal | null;
  /** What the plan writes for this region */
  config: PlayPhaseRegionPrice | null;
  /** What a customer pays per recurrence. Play works discounts out itself, so for them this is an estimate. */
  offerPrice: Decimal | null;
  estimated: boolean;
  /** proratedBase - offerPrice */
  discount: Decimal | null;
  /** discount / proratedBase, in percent, 2 decimals */
  discountPercent: Decimal | null;
  /** percentOfCurrent: the unsnapped target and how far Play's price is from it */
  exactTarget?: Decimal;
  deviation?: Decimal;
  deviationRatio?: Decimal;
  /** Whether the base plan is open to new subscribers here (the offer follows it) */
  newSubscriberAvailability: boolean;
  flags: PlayFlag[];
  ok: boolean;
}

/** Pricing a Play phase can follow: the spec's pricing (minus free) or a rules-file rule */
export type PlayPhasePricing =
  | (Omit<PercentOfCurrentRule, 'basis'> & { basis?: PercentOfCurrentRule['basis'] })
  | Exclude<OfferPricingRule, PercentOfCurrentRule>;

export interface PlayDerivationInput {
  pricing: PlayPhasePricing;
  phase: { duration: string; recurrenceCount: number };
  /** The base plan's billing period (ISO 8601) */
  billingPeriod: string;
  base: ProductPriceState;
  /** 'all' = every region of the base plan (fixed / absolute: every region the rule lists) */
  territories: 'all' | string[];
  /** percentOfCurrent: Play's price for each region's exact target (convertRegionPrices), and regions it couldn't price */
  snapped?: { resolved: Record<string, { currency: string; amount: Decimal }>; unresolved: Record<string, string> };
  deviationThreshold?: Decimal;
}

const TARGET_SCALE = 6;

/** At most the currency's fraction digits (2, or 0 for JPY, KRW, ...) */
function fitsCurrency(amount: Decimal, scale: number): boolean {
  return isDecimalString(amount) && (normalizeDecimal(amount).split('.')[1]?.length ?? 0) <= scale;
}

function flag(code: PlayFlagCode, severity: PlayFlag['severity'], message: string): PlayFlag {
  return { code, severity, message };
}

/** Regions a derivation covers */
export function playDerivationRegions(input: Pick<PlayDerivationInput, 'pricing' | 'base' | 'territories'>): string[] {
  if (input.territories !== 'all') return [...new Set(input.territories)].sort();
  if (input.pricing.type === 'fixed') return Object.keys(input.pricing.prices).sort();
  if (input.pricing.type === 'play.absoluteDiscount') return Object.keys(input.pricing.amounts).sort();
  return Object.keys(input.base.territories).sort();
}

/** The basis Play phases default to: a phase price covers one recurrence, so it's prorated over the phase */
export function playRuleBasis(pricing: PlayPhasePricing): PercentOfCurrentRule['basis'] {
  return pricing.type === 'percentOfCurrent' ? pricing.basis ?? 'totalOverDuration' : 'totalOverDuration';
}

/**
 * percentOfCurrent: each region's exact target (base x percent x phase
 * duration / billing period by default), in the region's own currency, for
 * the adapter to turn into a Play price. Regions without a base price are
 * left out (the derivation flags them).
 */
export function playPercentTargets(input: Pick<PlayDerivationInput, 'pricing' | 'phase' | 'billingPeriod' | 'base' | 'territories'>): Record<string, { currency: string; amount: Decimal }> {
  const pricing = input.pricing;
  if (pricing.type !== 'percentOfCurrent') return {};
  const factor = percentFactor(pricing, input.phase.duration, input.billingPeriod);
  if (!factor) return {};
  const out: Record<string, { currency: string; amount: Decimal }> = {};
  for (const region of playDerivationRegions(input)) {
    const current = input.base.territories[region]?.current;
    if (!current || input.base.territories[region]?.problems?.current) continue;
    out[region] = { currency: current.currency, amount: roundDecimal(exactTarget(current.amount, factor), currencyScale(current.currency) + 2) };
  }
  return out;
}

interface Factor {
  percent: Decimal;
  numerator: number;
  denominator: number;
}

function percentFactor(pricing: Extract<PlayPhasePricing, { type: 'percentOfCurrent' }>, duration: string, billingPeriod: string): Factor | undefined {
  if (!isDecimalString(pricing.percent)) return undefined;
  const percent = normalizeDecimal(pricing.percent);
  if (compareDecimal(percent, '0') <= 0 || compareDecimal(percent, '100') >= 0 || (percent.split('.')[1]?.length ?? 0) > MAX_PERCENT_SCALE) return undefined;
  if (playRuleBasis(pricing) === 'perPeriod') return { percent, numerator: 1, denominator: 1 };
  const ratio = playDurationRatio(duration, billingPeriod);
  return ratio ? { percent, ...ratio } : undefined;
}

function exactTarget(current: Decimal, f: Factor): Decimal {
  return divideDecimal(multiplyDecimal(multiplyDecimal(current, f.percent), String(f.numerator)), String(100 * f.denominator), TARGET_SCALE);
}

/** Why a percentOfCurrent rule can't price this phase at all; undefined when it can */
export function playPricingProblem(pricing: PlayPhasePricing, phase: { duration: string }, billingPeriod: string): string | undefined {
  if (pricing.type === 'percentOfCurrent') {
    if (!isDecimalString(pricing.percent) || compareDecimal(pricing.percent, '0') <= 0 || compareDecimal(pricing.percent, '100') >= 0) {
      return `percent must be above 0 and below 100 (got ${JSON.stringify(pricing.percent)})`;
    }
    if (!percentFactor(pricing, phase.duration, billingPeriod)) {
      return `A ${phase.duration} phase on a ${billingPeriod} base plan has no exact duration ratio (weeks and months don't convert); use basis perPeriod`;
    }
  }
  if (pricing.type === 'play.relativeDiscount' && (!isDecimalString(pricing.fraction) || compareDecimal(pricing.fraction, '0') <= 0 || compareDecimal(pricing.fraction, '1') >= 0)) {
    return 'play.relativeDiscount fraction must be above 0 and below 1 ("0.5" = 50% off)';
  }
  return undefined;
}

/**
 * Each region's price for one phase under `pricing`. Rows that can't be
 * priced carry error flags and no config; nothing is converted between
 * currencies.
 */
export function derivePlayPhasePrices(input: PlayDerivationInput): PlayPreviewRow[] {
  const { pricing, base } = input;
  const threshold = normalizeDecimal(input.deviationThreshold ?? DEFAULT_OFFER_DEVIATION_THRESHOLD);
  const ratio = playDurationRatio(input.phase.duration, input.billingPeriod);
  const factor = pricing.type === 'percentOfCurrent' ? percentFactor(pricing, input.phase.duration, input.billingPeriod) : undefined;

  return playDerivationRegions(input).map((region): PlayPreviewRow => {
    const state = base.territories[region];
    const row: PlayPreviewRow = {
      region,
      currency: state?.currency ?? '',
      basePrice: null,
      proratedBase: null,
      config: null,
      offerPrice: null,
      estimated: false,
      discount: null,
      discountPercent: null,
      newSubscriberAvailability: state?.availability !== 'NO_NEW_SUBSCRIBERS',
      flags: [],
      ok: false,
    };
    if (!state?.current || state.problems?.current) {
      row.flags.push(flag('NO_CURRENT_PRICE', 'error', state?.problems?.current ? `${region} base price can't be read: ${state.problems.current}` : `${region} has no base price, so the base plan isn't sold there`));
      return row;
    }
    const current = normalizeDecimal(state.current.amount);
    const currency = state.current.currency;
    const scale = currencyScale(currency);
    row.currency = currency;
    row.basePrice = current;
    if (ratio) row.proratedBase = divideDecimal(multiplyDecimal(current, String(ratio.numerator)), String(ratio.denominator), TARGET_SCALE);
    else row.flags.push(flag('SPAN_NOT_COMPARABLE', 'warning', `A ${input.phase.duration} phase can't be compared with the ${input.billingPeriod} base price over the same time; the estimate is left out`));

    switch (pricing.type) {
      case 'free':
        row.config = { type: 'free' };
        row.offerPrice = '0';
        break;
      case 'play.relativeDiscount': {
        const fraction = normalizeDecimal(pricing.fraction);
        row.config = { type: 'relativeDiscount', fraction };
        if (row.proratedBase !== null) {
          // Play: "rounded to the nearest billable unit"
          row.offerPrice = roundDecimal(multiplyDecimal(row.proratedBase, subtractDecimal('1', fraction)), scale);
          row.estimated = true;
        }
        break;
      }
      case 'play.absoluteDiscount': {
        const amount = pricing.amounts[region];
        if (amount === undefined) {
          row.flags.push(flag('NO_AMOUNT', 'error', `The rule gives no amount off for ${region}`));
          return row;
        }
        if (!fitsCurrency(amount, scale)) {
          row.flags.push(flag('INVALID_AMOUNT', 'error', `${amount} ${currency} has more decimals than ${currency} allows (${scale})`));
          return row;
        }
        row.config = { type: 'absoluteDiscount', currency, amount: normalizeDecimal(amount) };
        if (row.proratedBase !== null) {
          row.offerPrice = roundDecimal(subtractDecimal(row.proratedBase, amount), scale);
          row.estimated = true;
          if (compareDecimal(row.offerPrice, '0') <= 0) {
            row.flags.push(flag('DISCOUNT_TOO_LARGE', 'error', `${amount} ${currency} off is not below the base price over the phase (${roundDecimal(row.proratedBase, scale)} ${currency})`));
          }
        }
        break;
      }
      case 'fixed': {
        const amount = pricing.prices[region];
        if (amount === undefined) {
          row.flags.push(flag('NO_AMOUNT', 'error', `The rule gives no price for ${region}`));
          return row;
        }
        if (!fitsCurrency(amount, scale)) {
          row.flags.push(flag('INVALID_AMOUNT', 'error', `${amount} ${currency} has more decimals than ${currency} allows (${scale})`));
          return row;
        }
        row.config = { type: 'price', currency, amount: normalizeDecimal(amount) };
        row.offerPrice = normalizeDecimal(amount);
        break;
      }
      case 'percentOfCurrent': {
        if (!factor) {
          row.flags.push(flag('SPAN_NOT_COMPARABLE', 'error', `The rule can't price a ${input.phase.duration} phase on a ${input.billingPeriod} base plan`));
          return row;
        }
        row.exactTarget = exactTarget(current, factor);
        const snapped = input.snapped?.resolved[region];
        if (!snapped) {
          row.flags.push(flag('NO_PLAY_PRICE', 'error', input.snapped?.unresolved[region] ?? `Play gave no price for ${row.exactTarget} ${currency}`));
          return row;
        }
        if (snapped.currency !== currency) {
          row.flags.push(flag('CURRENCY_MISMATCH', 'error', `Play priced ${region} in ${snapped.currency}, the base price is in ${currency}`));
          return row;
        }
        const amount = normalizeDecimal(snapped.amount);
        row.config = { type: 'price', currency, amount };
        row.offerPrice = amount;
        row.deviation = subtractDecimal(amount, row.exactTarget);
        row.deviationRatio = deviationRatio(row.exactTarget, amount);
        if (compareDecimal(row.deviationRatio, threshold) > 0) {
          // An error on Play: the region is left out rather than priced far from its rule (raise deviationThreshold to accept it)
          row.flags.push(flag('DEVIATION_ABOVE_THRESHOLD', 'error', `Play's price ${amount} is ${row.deviationRatio} away from the target ${row.exactTarget} (threshold ${threshold}); left out`));
        }
        break;
      }
    }

    if (row.offerPrice !== null && row.proratedBase !== null) {
      row.discount = roundDecimal(subtractDecimal(row.proratedBase, row.offerPrice), scale);
      row.discountPercent = compareDecimal(row.proratedBase, '0') > 0 ? divideDecimal(multiplyDecimal(row.discount, '100'), row.proratedBase, 2) : null;
      if ((pricing.type === 'fixed' || pricing.type === 'percentOfCurrent') && compareDecimal(row.offerPrice, row.proratedBase) >= 0) {
        row.flags.push(flag('NOT_BELOW_CURRENT', 'error', `${row.offerPrice} ${currency} is not below the base price over the phase (${roundDecimal(row.proratedBase, scale)} ${currency})`));
      }
    }
    row.ok = row.config !== null && !row.flags.some((f) => f.severity === 'error');
    return row;
  });
}

// ---------------------------------------------------------------------------
// Planning from specs

export interface PlayOfferPreview {
  offerId: string;
  /** What the offer will be once applied */
  state: PlayOfferState['state'];
  eligibility: string;
  targeting: PlayTargeting;
  phases: string[];
  tags: string[];
  regionsVersion?: string;
  /** The offer as it is now (absent for a create): state, eligibility and tags before the plan */
  before?: { state: PlayOfferState['state']; eligibility: string; targeting: PlayTargeting; tags: string[] };
  /** Tags the plan adds and removes */
  tagChanges: { added: string[]; removed: string[] };
  /** Set when the plan changes the eligibility */
  eligibilityChange?: { from: string; to: string };
  /** Per region: base price, offer price, discount */
  rows: PlayPreviewRow[];
  /** Regions whose offer price the plan changes, with before and after */
  changes: Array<{ region: string; phase: number; before: PlayPhaseRegionPrice | null; after: PlayPhaseRegionPrice | null }>;
}

export interface PlayOfferPlanInput {
  spec: OfferSpec;
  /** The base plan's billing period (ISO 8601) */
  billingPeriod: string;
  base: ProductPriceState;
  /** The base plan's offers as read */
  existing: StoreOffer[];
  /** percentOfCurrent: Play's prices for the exact targets */
  snapped?: PlayDerivationInput['snapped'];
  /** regionsVersion.version for create and patch (spec.play.regionsVersion wins) */
  regionsVersion?: string;
  deviationThreshold?: Decimal;
}

export interface PlanPlayOffersInput {
  app: AppRef;
  inputs: PlayOfferPlanInput[];
  id?: string;
  createdAt?: string;
  description?: string;
}

/** The spec's single phase: pay up front = one recurrence, pay as you go = `periods` recurrences */
export function playSpecPhase(spec: OfferSpec): { duration: string; recurrenceCount: number } {
  return { duration: spec.duration, recurrenceCount: spec.mode === 'PAY_UP_FRONT' ? 1 : spec.periods ?? 1 };
}

function targetingOf(spec: OfferSpec): PlayTargeting | undefined {
  return spec.eligibility?.type === 'play.targeting' ? spec.eligibility.rule : undefined;
}

function skipReason(row: PlayPreviewRow): PlanSkip['reason'] {
  const codes = row.flags.filter((f) => f.severity === 'error').map((f) => f.code);
  if (codes.includes('NO_CURRENT_PRICE')) return 'NOT_CONFIGURED';
  if (codes.includes('CURRENCY_MISMATCH')) return 'CURRENCY_MISMATCH';
  if (codes.includes('NO_PLAY_PRICE')) return 'UNRESOLVED_PRICE_POINT';
  if (codes.includes('NO_AMOUNT')) return 'NO_TARGET';
  if (codes.includes('DEVIATION_ABOVE_THRESHOLD')) return 'DEVIATION_ABOVE_THRESHOLD';
  return 'INVALID_TARGET';
}

function makePlayOp(
  kind: PlayOfferOpKind,
  product: ProductRef,
  before: PlayOfferState | null,
  after: PlayOfferState | null,
  regionsVersion: string | undefined,
  note?: string
): Omit<PlayOfferOp, 'id'> {
  const offer = (after ?? before)!;
  const op: Omit<PlayOfferOp, 'id' | 'idempotencyKey'> = {
    kind,
    platform: 'google',
    target: { product, offer: { kind: 'play.offer', key: offer.key } },
    before,
    after,
    ...(regionsVersion ? { regionsVersion } : {}),
    ...(note ? { note } : {}),
  };
  return { ...op, idempotencyKey: computePlayOfferIdempotencyKey(op) };
}

function previewOf(state: PlayOfferState, rows: PlayPreviewRow[], regionsVersion: string | undefined, before?: PlayOfferState): PlayOfferPreview {
  const eligibility = describePlayTargeting(state.targeting);
  const was = before ? describePlayTargeting(before.targeting) : undefined;
  return {
    offerId: state.key,
    state: state.state,
    eligibility,
    targeting: state.targeting,
    phases: state.phases.map(describePlayPhase),
    tags: state.tags,
    ...(regionsVersion ? { regionsVersion } : {}),
    ...(before ? { before: { state: before.state, eligibility: was!, targeting: before.targeting, tags: before.tags } } : {}),
    tagChanges: {
      added: state.tags.filter((t) => !before?.tags.includes(t)),
      removed: before ? before.tags.filter((t) => !state.tags.includes(t)) : [],
    },
    ...(before && !sameTargeting(before.targeting, state.targeting) ? { eligibilityChange: { from: was!, to: eligibility } } : {}),
    rows,
    changes: [],
  };
}

function priceChanges(before: PlayOfferState | null, after: PlayOfferState): PlayOfferPreview['changes'] {
  const regions = before ? changedPlayRegions(before, after) : Object.keys(after.regions).sort();
  const out: PlayOfferPreview['changes'] = [];
  for (const region of regions) {
    after.phases.forEach((phase, i) => {
      out.push({ region, phase: i + 1, before: before?.phases[i]?.regions[region] ?? null, after: phase.regions[region] ?? null });
    });
  }
  return out;
}

/** Plan one Play offer: create it, change it, activate it, leave it, or refuse with the reason */
function planPlayOne(input: PlayOfferPlanInput): { entry: OfferPlanEntry; op?: Omit<PlayOfferOp, 'id'>; skipped: PlanSkip[]; warnings: string[] } {
  const { spec } = input;
  const product = spec.productRef;
  const entry: OfferPlanEntry = { product, kind: 'play.offer', specId: spec.id, key: spec.id, action: 'refused', changes: [], refusals: [], warnings: [] };
  const skipped: PlanSkip[] = [];
  const refuse = (code: OfferRefusalCode, message: string) => {
    entry.refusals.push({ code, message });
    return { entry, skipped, warnings: entry.warnings };
  };
  if (spec.kind !== 'play.offer' || product.platform !== 'google' || product.type !== 'subscription') {
    return refuse('UNSUPPORTED_PRICING', 'A Play offer belongs to a Google Play base plan (subscription productId + basePlanId)');
  }
  const targeting = targetingOf(spec);
  if (!targeting) return refuse('MISSING_SETTINGS', 'A Play offer needs eligibility { type: "play.targeting", rule } (developerDetermined, acquisition or upgrade)');
  const regionsVersion = spec.play?.regionsVersion ?? input.regionsVersion;
  if (!regionsVersion) return refuse('MISSING_SETTINGS', "Play needs a regionsVersion to create or change an offer and none could be read; set play.regionsVersion in the spec (the version your base plan's regions use, e.g. \"2025/03\")");

  const phase = playSpecPhase(spec);
  const pricing = spec.pricing as PlayPhasePricing;
  const problem = playPricingProblem(pricing, phase, input.billingPeriod);
  if (problem) return refuse('UNSUPPORTED_PRICING', problem);
  if (spec.mode === 'FREE_TRIAL' && pricing.type !== 'free') return refuse('UNSUPPORTED_PRICING', 'A free trial is priced { type: "free" }');

  const rows = derivePlayPhasePrices({
    pricing,
    phase,
    billingPeriod: input.billingPeriod,
    base: input.base,
    territories: spec.territories,
    ...(input.snapped ? { snapped: input.snapped } : {}),
    ...(spec.play?.deviationThreshold ?? input.deviationThreshold ? { deviationThreshold: spec.play?.deviationThreshold ?? input.deviationThreshold } : {}),
  });
  for (const row of rows) {
    for (const f of row.flags) if (f.severity === 'warning') entry.warnings.push(`${row.region}: ${f.message}`);
    if (!row.ok) skipped.push({ product, territory: row.region, offerKey: spec.id, reason: skipReason(row), detail: row.flags.filter((f) => f.severity === 'error').map((f) => f.message).join('; ') });
  }
  const ok = rows.filter((r) => r.ok);
  const target: PlayOfferState = {
    kind: 'play.offer',
    key: spec.id,
    state: spec.play?.state ?? 'ACTIVE',
    phases: [{ ...phase, regions: Object.fromEntries(ok.map((r) => [r.region, r.config!])) }],
    targeting,
    tags: [...new Set(spec.tags ?? [])].sort(),
    regions: Object.fromEntries(ok.map((r) => [r.region, { newSubscriberAvailability: r.newSubscriberAvailability }])),
  };
  entry.play = previewOf(target, rows, regionsVersion);

  const closed = ok.filter((r) => !r.newSubscriberAvailability).map((r) => r.region);
  if (closed.length) entry.warnings.push(`${closed.join(', ')}: the base plan is closed to new subscribers there, so the offer is too (it follows the base plan)`);
  if (pricing.type === 'percentOfCurrent') {
    entry.warnings.push("Play has no price ladder: each target is made a valid price with Play's own price conversion (convertRegionPrices), so the rule's snap mode doesn't apply.");
  }
  if (pricing.type === 'play.relativeDiscount' && compareDecimal(normalizeDecimal(pricing.fraction), '0.5') !== 0) {
    entry.warnings.push(
      `relativeDiscount ${normalizeDecimal(pricing.fraction)} is sent as the share taken off (${trimPercent(pricing.fraction)}% off), as the Android Publisher reference describes it ("a value of 0.8 represents an 80% discount"). Not yet confirmed on a test app: check the offer price in Play Console after applying.`
    );
  }
  if (pricing.type === 'play.absoluteDiscount' || pricing.type === 'play.relativeDiscount') {
    entry.warnings.push('Play works out discounted prices itself; the offer prices shown are estimates (rounded to the currency unit).');
  }
  entry.warnings.push("The offer isn't made available in locations Play launches later (no otherRegionsConfig); add those in Play Console if you want them.");

  if (Object.keys(target.regions).length === 0) return refuse('NO_PRICES', 'No region has a usable offer price; see the skipped regions');

  const matches = input.existing.filter((o) => o.kind === 'play.offer' && o.key === spec.id);
  if (matches.length > 1) return refuse('AMBIGUOUS_OFFER', `${matches.length} offers on this base plan have the ID "${spec.id}"`);
  if (matches.length === 0) {
    entry.action = 'create';
    entry.play.changes = priceChanges(null, target);
    return {
      entry,
      op: makePlayOp('createOffer', product, null, target, regionsVersion, target.state === 'ACTIVE' ? 'created as a draft, then activated' : 'created as a draft'),
      skipped,
      warnings: entry.warnings,
    };
  }

  const existing = matches[0];
  const current = existing.play?.offer;
  const unreadable = storeOfferProblems(existing);
  if (!current || unreadable.length > 0) {
    return refuse('OFFER_UNREADABLE', `The existing Play offer "${spec.id}" can't be read unambiguously (${unreadable.slice(0, 3).join('; ') || 'no offer details'})`);
  }
  if (!samePlayPhaseTerms(current, target)) {
    return refuse(
      'TERMS_IMMUTABLE',
      `The Play offer "${spec.id}" already exists with other phases (${current.phases.map(describePlayPhase).join('; ')}). PricingKit doesn't change an existing offer's phase durations or recurrences; create the offer under a new ID.`
    );
  }
  // Same phase terms: regions the spec doesn't price keep their price; targeting and tags follow the spec
  const merged: PlayOfferState = {
    ...current,
    phases: current.phases.map((p, i) => ({ ...p, regions: { ...p.regions, ...target.phases[i].regions } })),
    targeting,
    tags: target.tags,
    // Existing regions keep their availability; regions the spec adds follow the base plan's
    regions: { ...target.regions, ...current.regions },
  };
  entry.play = previewOf(merged, rows, regionsVersion, current);
  const { added, removed } = entry.play.tagChanges;
  if (removed.length > 0 && !spec.play?.allowTagRemoval) {
    return refuse(
      'TAG_REMOVAL',
      `The spec leaves out tag${removed.length > 1 ? 's' : ''} ${removed.join(', ')} that the Play offer "${spec.id}" has. Tags tell the app how to treat the offer (e.g. whether a paywall may show it), so PricingKit doesn't drop them silently: add them to the spec's tags, or set play.allowTagRemoval: true to remove them.`
    );
  }
  for (const tag of removed) entry.warnings.push(`removes tag ${tag}`);
  for (const tag of added) entry.warnings.push(`adds tag ${tag}`);
  if (entry.play.eligibilityChange) entry.warnings.push(`eligibility ${entry.play.eligibilityChange.from} → ${entry.play.eligibilityChange.to}`);
  if (samePlayOfferContent(current, merged)) {
    if (target.state === 'ACTIVE' && current.state !== 'ACTIVE') {
      entry.action = 'activate';
      entry.play.state = 'ACTIVE';
      entry.warnings.push(`The offer already matches the spec; the plan activates it (it is ${current.state}).`);
      return { entry, op: makePlayOp('activateOffer', product, current, { ...current, state: 'ACTIVE' }, undefined), skipped, warnings: entry.warnings };
    }
    if (target.state === 'DRAFT' && current.state !== 'DRAFT') entry.warnings.push(`The spec asks for a draft, but the offer is ${current.state}; a Play offer can't return to draft.`);
    entry.action = 'none';
    for (const r of ok) skipped.push({ product, territory: r.region, offerKey: spec.id, reason: 'ALREADY_AT_TARGET' });
    return { entry, skipped, warnings: entry.warnings };
  }
  const pricesOnly = sameTargeting(current.targeting, targeting) && added.length === 0 && removed.length === 0;
  if (!pricesOnly) {
    entry.warnings.push("Changing an existing offer's eligibility or tags: whether Play accepts this for an active offer is not confirmed; Play's refusal is shown if it doesn't.");
  }
  if (target.state === 'ACTIVE' && current.state !== 'ACTIVE') entry.warnings.push(`The offer is ${current.state}; this plan changes it but doesn't activate it. Apply, then plan again to activate it.`);
  entry.action = pricesOnly ? 'updatePrices' : 'update';
  entry.play.changes = priceChanges(current, merged);
  return { entry, op: makePlayOp(pricesOnly ? 'updateOfferPrices' : 'updateOffer', product, current, merged, regionsVersion), skipped, warnings: entry.warnings };
}

/**
 * Plan every Play offer in `inputs` into one ChangeSet. Refused offers get
 * no op; their entries say why. The result's `hash` is what an apply must
 * pass as `confirm`.
 */
export function planPlayOfferChanges(input: PlanPlayOffersInput): OfferPlan {
  const entries: OfferPlanEntry[] = [];
  const ops: Array<Omit<PlayOfferOp, 'id'>> = [];
  const skipped: PlanSkip[] = [];
  const warnings: Array<{ index: number; message: string }> = [];
  const keys = new Set<string>();
  for (const item of input.inputs) {
    const result = planPlayOne(item);
    const targetKey = `${productKey(item.spec.productRef)}|play.offer|${item.spec.id}`;
    if (keys.has(targetKey)) {
      result.entry.refusals.push({ code: 'AMBIGUOUS_OFFER', message: `Another offer in this plan already targets "${item.spec.id}" on this base plan` });
      result.entry.action = 'refused';
      delete result.op;
    }
    keys.add(targetKey);
    if (result.op) {
      result.entry.opId = `op-${String(ops.length + 1).padStart(4, '0')}`;
      for (const w of result.warnings) warnings.push({ index: ops.length, message: w });
      ops.push(result.op);
    }
    entries.push(result.entry);
    skipped.push(...result.skipped);
  }
  return finishPlan(input, ops, entries, skipped, warnings, 'offers');
}

function finishPlan(
  input: { app: AppRef; id?: string; createdAt?: string; description?: string },
  ops: Array<Omit<PlayOfferOp, 'id'>>,
  entries: OfferPlanEntry[],
  skipped: PlanSkip[],
  warnings: Array<{ index: number; message: string }>,
  prefix: string
): OfferPlan {
  const numbered = ops.map((op, i) => ({ id: `op-${String(i + 1).padStart(4, '0')}`, ...op }) as PlayOfferOp);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const changeSet: ChangeSet = {
    schemaVersion: CHANGESET_SCHEMA_VERSION,
    kind: CHANGESET_KIND,
    id: input.id ?? `${prefix}-${createdAt.replace(/[^0-9]/g, '').slice(0, 14)}-${changeSetHash({ app: input.app, ops: numbered }).slice(0, 8)}`,
    createdAt,
    ...(input.description ? { description: input.description } : {}),
    app: input.app,
    ops: numbered,
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(warnings.length > 0 ? { warnings: warnings.map((w) => ({ opId: numbered[w.index].id, message: w.message })) } : {}),
  };
  const problems = checkChangeSetRules(changeSet);
  if (problems.length > 0) throw new ChangeSetValidationError(problems);
  return { changeSet, hash: changeSetHash(changeSet), entries };
}

// ---------------------------------------------------------------------------
// Activating, deactivating and deleting an existing offer

export interface PlayOfferLifecycleInput {
  app: AppRef;
  product: ProductRef;
  /** The base plan's offers, as read now */
  existing: StoreOffer[];
  key: string;
  action: 'activate' | 'deactivate' | 'delete';
  /** Kept on a delete op so its undo can re-create the offer */
  regionsVersion?: string;
  createdAt?: string;
  id?: string;
}

export class PlayOfferLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayOfferLifecycleError';
  }
}

/** A one-op plan that activates, deactivates or deletes an existing Play offer */
export function planPlayOfferLifecycle(input: PlayOfferLifecycleInput): OfferPlan {
  const matches = input.existing.filter((o) => o.kind === 'play.offer' && (o.key === input.key || o.storeId === input.key));
  if (matches.length !== 1) throw new PlayOfferLifecycleError(matches.length ? `${matches.length} Play offers match "${input.key}"` : `No Play offer "${input.key}"`);
  const offer = matches[0];
  const current = offer.play?.offer;
  const unreadable = storeOfferProblems(offer);
  if (!current || unreadable.length) throw new PlayOfferLifecycleError(`The Play offer "${input.key}" can't be read unambiguously (${unreadable.slice(0, 3).join('; ')})`);
  let op: Omit<PlayOfferOp, 'id'>;
  const warnings: string[] = [];
  switch (input.action) {
    case 'activate':
      if (current.state === 'ACTIVE') throw new PlayOfferLifecycleError(`The Play offer "${current.key}" is already active`);
      op = makePlayOp('activateOffer', input.product, current, { ...current, state: 'ACTIVE' }, undefined);
      if (current.state === 'DRAFT') warnings.push("An activated offer can't return to draft or be deleted; undo deactivates it.");
      break;
    case 'deactivate':
      if (current.state !== 'ACTIVE') throw new PlayOfferLifecycleError(`Only an active offer can be deactivated; "${current.key}" is ${current.state}`);
      op = makePlayOp('deactivateOffer', input.product, current, { ...current, state: 'INACTIVE' }, undefined);
      warnings.push('Subscribers who took the offer keep it; new customers can no longer get it.');
      break;
    case 'delete':
      if (current.state !== 'DRAFT') throw new PlayOfferLifecycleError(`Google Play deletes only draft offers; "${current.key}" is ${current.state} (deactivate it instead)`);
      op = makePlayOp('deleteOffer', input.product, current, null, input.regionsVersion, 'Deleting is irreversible; applying needs force.deleteOffers');
      warnings.push('Deleting a Play offer is irreversible; applying needs force (--force-delete).');
      break;
  }
  const entry: OfferPlanEntry = {
    product: input.product,
    kind: 'play.offer',
    specId: current.key,
    key: current.key,
    action: 'none',
    opId: 'op-0001',
    changes: [],
    refusals: [],
    warnings,
    play: previewOf(op.after ?? current, [], input.regionsVersion, current),
  };
  return finishPlan(
    { app: input.app, id: input.id ?? `offer-${input.action}-${(input.createdAt ?? new Date().toISOString()).replace(/[^0-9]/g, '').slice(0, 14)}`, ...(input.createdAt ? { createdAt: input.createdAt } : {}) },
    [op],
    [entry],
    [],
    warnings.map((message) => ({ index: 0, message })),
    'offer'
  );
}
