// Google Play subscription offers in the core: the plan-file form of an
// offer (PlayOfferState), the ops that create, change, activate, deactivate
// and delete one, and the pure rules the executor uses to apply them
// idempotently. Framework-free, like the rest of the core.
//
// A Play offer belongs to one base plan and is found by its offerId, which is
// unique within the base plan and immutable. It has one or two phases, each
// priced per region with exactly one of: an absolute price, a relative
// discount (a fraction of the base price that follows it), an absolute
// discount, or free. Its targeting (eligibility) is a new-customer
// acquisition rule, an upgrade rule, or nothing (developer-determined: the
// app decides whom to show it to). Tags are returned to the app through the
// billing library (e.g. for RevenueCat).
//
// Field names and shapes follow the Android Publisher v3 discovery document
// (monetization.subscriptions.basePlans.offers). Anything a store returns
// that this model can't hold is reported as a problem by the reader and the
// offer is never written to.

import { z } from 'zod';
import { compareDecimal, isDecimalString, multiplyDecimal, normalizeDecimal, type Decimal } from './decimal';
import { productKey, type ProductRef } from './model';
import { canonicalJson, currencySchema, decimalSchema, fnv1a64, productRefSchema, territorySchema } from './refs';
import type { StoreOffer } from './offers';

// ---------------------------------------------------------------------------
// Limits and formats (from the discovery document unless noted)

/** SubscriptionOffer.phases: "at least one and at most two entries" */
export const MAX_PLAY_OFFER_PHASES = 2;
/** SubscriptionOffer.offerTags: "up to 20 custom tags" */
export const MAX_PLAY_OFFER_TAGS = 20;
/** OfferTag.tag: RFC-1034, lower-case letters, digits and hyphens, at most 20 characters */
export const PLAY_OFFER_TAG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;
/**
 * offerId format. The discovery document says only "unique within the base
 * plan"; this pattern (lower-case letters, digits and hyphens, starting with
 * a letter or digit, at most 63 characters) is Play Console's rule and the
 * same as the base plan ID rule. Not confirmed against the API.
 */
export const PLAY_OFFER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const PLAY_OFFER_STATES = ['DRAFT', 'ACTIVE', 'INACTIVE'] as const;
export type PlayOfferStatus = (typeof PLAY_OFFER_STATES)[number];

// ---------------------------------------------------------------------------
// Durations (ISO 8601, single unit: P3D, P1W, P1M, P1Y)

const DURATION = /^P(\d+)([DWMY])$/;

export function isPlayDuration(value: unknown): value is string {
  return typeof value === 'string' && DURATION.test(value) && Number(DURATION.exec(value)![1]) > 0;
}

/** A duration in days (D, W) or months (M, Y); undefined when it isn't a single-unit ISO duration */
export function playDurationParts(duration: string): { unit: 'day' | 'month'; count: number } | undefined {
  const match = DURATION.exec(duration);
  if (!match) return undefined;
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

/** P1W and P7D, P1Y and P12M are the same duration */
export function samePlayDuration(a: string, b: string): boolean {
  const x = playDurationParts(a);
  const y = playDurationParts(b);
  if (!x || !y) return a === b;
  return x.unit === y.unit && x.count === y.count;
}

/** a / b as an exact fraction, or undefined when they are counted in different units (weeks vs months) */
export function playDurationRatio(a: string, b: string): { numerator: number; denominator: number } | undefined {
  const x = playDurationParts(a);
  const y = playDurationParts(b);
  if (!x || !y || x.unit !== y.unit) return undefined;
  const gcd = (p: number, q: number): number => (q === 0 ? p : gcd(q, p % q));
  const g = gcd(x.count, y.count);
  return { numerator: x.count / g, denominator: y.count / g };
}

// ---------------------------------------------------------------------------
// The model

/** One region's price in one phase: exactly one of Play's four options */
export type PlayPhaseRegionPrice =
  /** RegionalSubscriptionOfferPhaseConfig.price: what the customer pays per recurrence */
  | { type: 'price'; currency: string; amount: Decimal }
  /** absoluteDiscount: subtracted from the base price prorated over the phase */
  | { type: 'absoluteDiscount'; currency: string; amount: Decimal }
  /** relativeDiscount: fraction (0..1, exclusive) taken off the prorated base price; "0.5" = 50% off */
  | { type: 'relativeDiscount'; fraction: Decimal }
  | { type: 'free' };

/** OtherRegionsSubscriptionOfferPhaseConfig: pricing for locations Play may launch in later */
export type PlayOtherRegionsPhasePrice =
  | { type: 'price'; usd: Decimal; eur: Decimal }
  | { type: 'absoluteDiscount'; usd: Decimal; eur: Decimal }
  | { type: 'relativeDiscount'; fraction: Decimal }
  | { type: 'free' };

export interface PlayOfferPhase {
  /** One recurrence, ISO 8601 (as the store reports it) */
  duration: string;
  /** Number of recurrences; a priced phase charges every recurrence */
  recurrenceCount: number;
  /** alpha-2 keyed; one entry per region of the offer */
  regions: Record<string, PlayPhaseRegionPrice>;
  otherRegions?: PlayOtherRegionsPhasePrice;
}

/** TargetingRuleScope: exactly one of the three */
export type PlayScope = 'anySubscriptionInApp' | 'thisSubscription' | { specificSubscriptionInApp: string };

export type PlayTargeting =
  /** No targeting: the app decides whom to show the offer to */
  | { type: 'developerDetermined' }
  /** AcquisitionTargetingRule: "user never had {scope} before" (scope any or this subscription) */
  | { type: 'acquisition'; scope: PlayScope }
  /** UpgradeTargetingRule: "user currently has {scope} [with billing period]" (scope this or a specific subscription) */
  | { type: 'upgrade'; scope: PlayScope; billingPeriodDuration?: string; oncePerUser?: boolean };

/** A Play offer as a plan sees it */
export interface PlayOfferState {
  kind: 'play.offer';
  /** offerId */
  key: string;
  state: PlayOfferStatus;
  phases: PlayOfferPhase[];
  targeting: PlayTargeting;
  /** offerTags, sorted and unique */
  tags: string[];
  /** RegionalSubscriptionOfferConfig per alpha-2 region */
  regions: Record<string, { newSubscriberAvailability: boolean }>;
  /** OtherRegionsSubscriptionOfferConfig; undefined = not set (Play's default is not available) */
  otherRegionsNewSubscriberAvailability?: boolean;
}

/** What a Play StoreOffer carries besides the generic fields */
export interface PlayStoreOfferDetails {
  productId: string;
  basePlanId: string;
  /** The offer as read. Check StoreOffer.problems / territoryProblems before trusting it. */
  offer: PlayOfferState;
}

// ---------------------------------------------------------------------------
// Schemas

const fractionSchema = decimalSchema.refine((v) => compareDecimal(v, '0') > 0 && compareDecimal(v, '1') < 0, {
  message: 'relativeDiscount must be a fraction above 0 and below 1 ("0.5" = 50% off)',
});
const durationSchema = z.string().refine(isPlayDuration, { message: 'must be an ISO 8601 duration with one unit, e.g. "P1Y", "P1M", "P7D"' });

export const playPhaseRegionPriceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('price'), currency: currencySchema, amount: decimalSchema }).strict(),
  z.object({ type: z.literal('absoluteDiscount'), currency: currencySchema, amount: decimalSchema }).strict(),
  z.object({ type: z.literal('relativeDiscount'), fraction: fractionSchema }).strict(),
  z.object({ type: z.literal('free') }).strict(),
]);

const otherRegionsPhasePriceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('price'), usd: decimalSchema, eur: decimalSchema }).strict(),
  z.object({ type: z.literal('absoluteDiscount'), usd: decimalSchema, eur: decimalSchema }).strict(),
  z.object({ type: z.literal('relativeDiscount'), fraction: fractionSchema }).strict(),
  z.object({ type: z.literal('free') }).strict(),
]);

export const playScopeSchema = z.union([
  z.literal('anySubscriptionInApp'),
  z.literal('thisSubscription'),
  z.object({ specificSubscriptionInApp: z.string().min(1) }).strict(),
]);

export const playTargetingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('developerDetermined') }).strict(),
  z.object({ type: z.literal('acquisition'), scope: playScopeSchema }).strict(),
  z
    .object({
      type: z.literal('upgrade'),
      scope: playScopeSchema,
      billingPeriodDuration: durationSchema.optional(),
      oncePerUser: z.boolean().optional(),
    })
    .strict(),
]);

export const playOfferTagSchema = z.string().regex(PLAY_OFFER_TAG_PATTERN, 'an offer tag has lower-case letters, digits and hyphens only, at most 20 characters');

export const playOfferStateSchema = z
  .object({
    kind: z.literal('play.offer'),
    key: z.string().min(1).max(200),
    state: z.enum(PLAY_OFFER_STATES),
    phases: z
      .array(
        z
          .object({
            duration: durationSchema,
            recurrenceCount: z.number().int().min(1),
            regions: z.record(territorySchema, playPhaseRegionPriceSchema),
            otherRegions: otherRegionsPhasePriceSchema.optional(),
          })
          .strict()
      )
      .min(1)
      .max(MAX_PLAY_OFFER_PHASES),
    targeting: playTargetingSchema,
    tags: z.array(playOfferTagSchema).max(MAX_PLAY_OFFER_TAGS),
    regions: z.record(territorySchema, z.object({ newSubscriberAvailability: z.boolean() }).strict()),
    otherRegionsNewSubscriberAvailability: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Problems a valid offer state can still have (the schema can't express them)

/** Rules every Play offer state meets: phases cover exactly the offer's regions, targeting scopes fit the rule */
export function playOfferStateProblems(state: PlayOfferState): string[] {
  const problems: string[] = [];
  const regions = Object.keys(state.regions).sort();
  if (regions.length === 0) problems.push('a Play offer needs at least one region');
  if (state.phases.length === 0 || state.phases.length > MAX_PLAY_OFFER_PHASES) problems.push(`a Play offer has 1 or ${MAX_PLAY_OFFER_PHASES} phases`);
  state.phases.forEach((phase, i) => {
    const own = Object.keys(phase.regions).sort();
    if (canonicalJson(own) !== canonicalJson(regions)) {
      problems.push(`phase ${i + 1} must price exactly the offer's regions (${listOf(regions)}); it prices ${listOf(own) || 'none'}`);
    }
    if (!isPlayDuration(phase.duration)) problems.push(`phase ${i + 1}: duration ${phase.duration} is not a single-unit ISO 8601 duration`);
  });
  if (new Set(state.tags).size !== state.tags.length) problems.push('offer tags must be unique');
  if (state.tags.some((t, i) => i > 0 && state.tags[i - 1] > t)) problems.push('offer tags must be sorted');
  const t = state.targeting;
  if (t.type === 'acquisition' && typeof t.scope === 'object') problems.push('an acquisition rule takes the scope anySubscriptionInApp or thisSubscription');
  if (t.type === 'upgrade' && t.scope === 'anySubscriptionInApp') problems.push('an upgrade rule takes the scope thisSubscription or a specific subscription');
  return problems;
}

function listOf(items: string[], max = 8): string {
  return items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');
}

// ---------------------------------------------------------------------------
// Comparing

export function samePhaseRegionPrice(a: PlayPhaseRegionPrice | undefined, b: PlayPhaseRegionPrice | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'free':
      return true;
    case 'relativeDiscount':
      return compareDecimal(a.fraction, (b as typeof a).fraction) === 0;
    default:
      return a.currency === (b as typeof a).currency && compareDecimal(a.amount, (b as typeof a).amount) === 0;
  }
}

function sameOtherRegions(a: PlayOtherRegionsPhasePrice | undefined, b: PlayOtherRegionsPhasePrice | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.type !== b.type) return false;
  if (a.type === 'free') return true;
  if (a.type === 'relativeDiscount') return compareDecimal(a.fraction, (b as typeof a).fraction) === 0;
  const y = b as typeof a;
  return compareDecimal(a.usd, y.usd) === 0 && compareDecimal(a.eur, y.eur) === 0;
}

function scopeKey(scope: PlayScope): string {
  return typeof scope === 'string' ? scope : `specific:${scope.specificSubscriptionInApp}`;
}

export function sameTargeting(a: PlayTargeting, b: PlayTargeting): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'developerDetermined') return true;
  if (scopeKey(a.scope) !== scopeKey((b as typeof a).scope)) return false;
  if (a.type === 'upgrade') {
    const y = b as typeof a;
    const period = (p?: string) => p ?? '';
    if (Boolean(a.oncePerUser) !== Boolean(y.oncePerUser)) return false;
    if (!(a.billingPeriodDuration && y.billingPeriodDuration ? samePlayDuration(a.billingPeriodDuration, y.billingPeriodDuration) : period(a.billingPeriodDuration) === period(y.billingPeriodDuration))) return false;
  }
  return true;
}

/** Regions whose phase prices differ in any phase (either side missing counts) */
export function changedPlayRegions(a: PlayOfferState, b: PlayOfferState): string[] {
  const regions = new Set([...Object.keys(a.regions), ...Object.keys(b.regions)]);
  for (const phase of [...a.phases, ...b.phases]) for (const r of Object.keys(phase.regions)) regions.add(r);
  const out: string[] = [];
  for (const region of [...regions].sort()) {
    const phases = Math.max(a.phases.length, b.phases.length);
    let differs = Boolean(a.regions[region]) !== Boolean(b.regions[region]) || a.regions[region]?.newSubscriberAvailability !== b.regions[region]?.newSubscriberAvailability;
    for (let i = 0; i < phases && !differs; i++) differs = !samePhaseRegionPrice(a.phases[i]?.regions[region], b.phases[i]?.regions[region]);
    if (differs) out.push(region);
  }
  return out;
}

/** Same phase terms (count, durations, recurrences): what an updateOfferPrices op may not change */
export function samePlayPhaseTerms(a: PlayOfferState, b: PlayOfferState): boolean {
  return (
    a.phases.length === b.phases.length &&
    a.phases.every((p, i) => samePlayDuration(p.duration, b.phases[i].duration) && p.recurrenceCount === b.phases[i].recurrenceCount)
  );
}

/** Everything an offer is (phases, prices, targeting, tags, regions), state aside */
export function samePlayOfferContent(a: PlayOfferState, b: PlayOfferState): boolean {
  if (!samePlayPhaseTerms(a, b)) return false;
  if (!a.phases.every((p, i) => sameOtherRegions(p.otherRegions, b.phases[i].otherRegions))) return false;
  if (changedPlayRegions(a, b).length > 0) return false;
  if (!sameTargeting(a.targeting, b.targeting)) return false;
  if (canonicalJson([...a.tags].sort()) !== canonicalJson([...b.tags].sort())) return false;
  return (a.otherRegionsNewSubscriberAvailability ?? false) === (b.otherRegionsNewSubscriberAvailability ?? false);
}

export function playOfferStateMatches(observed: PlayOfferState, expected: PlayOfferState): boolean {
  return observed.state === expected.state && samePlayOfferContent(observed, expected);
}

/** Top-level SubscriptionOffer fields that differ between two states (an update's updateMask) */
export function changedPlayOfferFields(a: PlayOfferState, b: PlayOfferState): Array<'phases' | 'targeting' | 'offerTags' | 'regionalConfigs' | 'otherRegionsConfig'> {
  const fields: Array<'phases' | 'targeting' | 'offerTags' | 'regionalConfigs' | 'otherRegionsConfig'> = [];
  const regionsDiffer =
    canonicalJson(Object.keys(a.regions).sort()) !== canonicalJson(Object.keys(b.regions).sort()) ||
    Object.keys(a.regions).some((r) => a.regions[r].newSubscriberAvailability !== b.regions[r]?.newSubscriberAvailability);
  const phasesDiffer =
    !samePlayPhaseTerms(a, b) || !a.phases.every((p, i) => sameOtherRegions(p.otherRegions, b.phases[i].otherRegions)) || changedPlayRegions(a, b).length > 0;
  // Each phase lists exactly the offer's regions, so a region change rewrites the phases too
  if (phasesDiffer || regionsDiffer) fields.push('phases');
  if (!sameTargeting(a.targeting, b.targeting)) fields.push('targeting');
  if (canonicalJson([...a.tags].sort()) !== canonicalJson([...b.tags].sort())) fields.push('offerTags');
  if (regionsDiffer) fields.push('regionalConfigs');
  if ((a.otherRegionsNewSubscriberAvailability ?? false) !== (b.otherRegionsNewSubscriberAvailability ?? false)) fields.push('otherRegionsConfig');
  return fields;
}

// ---------------------------------------------------------------------------
// Describing

export function describePlayScope(scope: PlayScope): string {
  if (scope === 'anySubscriptionInApp') return 'any subscription in the app';
  if (scope === 'thisSubscription') return 'this subscription';
  return `subscription ${scope.specificSubscriptionInApp}`;
}

/** "Developer-determined", "New customers: never had any subscription in the app", ... */
export function describePlayTargeting(targeting: PlayTargeting): string {
  switch (targeting.type) {
    case 'developerDetermined':
      return 'Developer-determined (no Play eligibility rule; the app decides who sees it)';
    case 'acquisition':
      return `New customer acquisition: never had ${describePlayScope(targeting.scope)}`;
    case 'upgrade':
      return `Upgrade: currently has ${describePlayScope(targeting.scope)}${targeting.billingPeriodDuration ? ` billed every ${targeting.billingPeriodDuration}` : ''}${targeting.oncePerUser ? ', once per user' : ''}`;
  }
}

export function describePlayRegionPrice(price: PlayPhaseRegionPrice | undefined): string {
  if (!price) return '-';
  switch (price.type) {
    case 'free':
      return 'free';
    case 'relativeDiscount':
      return `${trimPercent(price.fraction)}% off`;
    case 'absoluteDiscount':
      return `${price.amount} ${price.currency} off`;
    default:
      return `${price.amount} ${price.currency}`;
  }
}

/** "0.5" -> "50" (percent off), exact */
export function trimPercent(fraction: Decimal): string {
  return normalizeDecimal(multiplyDecimal(fraction, '100'));
}

/** "P1Y x1, 50% off" for one phase, summarised over its regions */
export function describePlayPhase(phase: PlayOfferPhase): string {
  const kinds = new Set(Object.values(phase.regions).map((p) => (p.type === 'relativeDiscount' ? `${trimPercent(p.fraction)}% off` : p.type)));
  const pricing = kinds.size === 1 ? [...kinds][0] : [...kinds].sort().join(' / ');
  const label = pricing === 'price' ? 'fixed price per region' : pricing === 'absoluteDiscount' ? 'amount off per region' : pricing;
  return `${phase.duration} x${phase.recurrenceCount}: ${label}`;
}

// ---------------------------------------------------------------------------
// Ops

/**
 * createOffer        - create the offer (DRAFT), then activate it when `after.state` is ACTIVE
 * updateOffer        - patch phases, targeting, tags or regions
 * updateOfferPrices  - patch phase prices only (terms, targeting and tags unchanged)
 * activateOffer      - DRAFT or INACTIVE -> ACTIVE
 * deactivateOffer    - ACTIVE -> INACTIVE
 * deleteOffer        - delete a DRAFT offer (Play deletes nothing else; irreversible)
 */
export const PLAY_OFFER_OP_KINDS = ['createOffer', 'updateOffer', 'updateOfferPrices', 'activateOffer', 'deactivateOffer', 'deleteOffer'] as const;
export type PlayOfferOpKind = (typeof PLAY_OFFER_OP_KINDS)[number];

export interface PlayOfferOp {
  id: string;
  kind: PlayOfferOpKind;
  platform: 'google';
  /** product: the base plan the offer extends */
  target: { product: ProductRef; offer: { kind: 'play.offer'; key: string } };
  before: PlayOfferState | null;
  after: PlayOfferState | null;
  /**
   * regionsVersion.version sent with create and patch (Play requires it).
   * Planned once and reviewed with the plan.
   */
  regionsVersion?: string;
  idempotencyKey: string;
  note?: string;
  /** Base-price ops of the same base plan this op's prices were derived from (sync plans) */
  dependsOn?: string[];
}

export const playOfferOpSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(PLAY_OFFER_OP_KINDS),
    platform: z.literal('google'),
    target: z
      .object({
        product: productRefSchema,
        offer: z.object({ kind: z.literal('play.offer'), key: z.string().min(1).max(200) }).strict(),
      })
      .strict(),
    before: playOfferStateSchema.nullable(),
    after: playOfferStateSchema.nullable(),
    regionsVersion: z.string().min(1).max(40).optional(),
    idempotencyKey: z.string().min(1),
    note: z.string().optional(),
    dependsOn: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export function computePlayOfferIdempotencyKey(op: Pick<PlayOfferOp, 'kind' | 'target' | 'before' | 'after'>): string {
  const subject = op.kind === 'deleteOffer' ? op.before : op.after;
  return [op.kind, `${productKey(op.target.product)}|play.offer|${op.target.offer.key}`, fnv1a64(canonicalJson(subject ?? null))].join('|');
}

export function describePlayOfferOp(op: PlayOfferOp): string {
  const state = op.after ?? op.before;
  return `${op.kind} Play offer "${op.target.offer.key}" on ${productKey(op.target.product)} (${Object.keys(state?.regions ?? {}).length} regions${op.after && op.before?.state !== op.after.state ? `, ${op.after.state}` : ''})`;
}

function checkPlayState(where: string, state: PlayOfferState, op: PlayOfferOp, problems: string[]): void {
  if (state.key !== op.target.offer.key) problems.push(`${where}: offer key "${state.key}" doesn't match the target ("${op.target.offer.key}")`);
  for (const p of playOfferStateProblems(state)) problems.push(`${where}: ${p}`);
  const regions = Object.keys(state.regions);
  for (const phase of state.phases) {
    for (const region of regions) {
      const price = phase.regions[region];
      if (price && (price.type === 'price' || price.type === 'absoluteDiscount') && compareDecimal(price.amount, '0') <= 0) {
        problems.push(`${where}: ${region} ${price.type} must be above 0`);
      }
    }
  }
}

/** Problems with one Play offer op; empty means valid */
export function checkPlayOfferOpRules(op: PlayOfferOp, appPlatform: 'apple' | 'google'): string[] {
  const where = `op ${op.id}`;
  const problems: string[] = [];
  const product = op.target.product;
  if (product.platform !== 'google' || product.type !== 'subscription') problems.push(`${where}: a Play offer belongs to a Google Play base plan (subscription productId + basePlanId)`);
  if (appPlatform !== 'google') problems.push(`${where}: Play offer op in a change set for an ${appPlatform} app`);
  if (!PLAY_OFFER_ID_PATTERN.test(op.target.offer.key)) problems.push(`${where}: offer ID "${op.target.offer.key}" must be lower-case letters, digits and hyphens (at most 63)`);
  if (op.before) checkPlayState(`${where} before`, op.before, op, problems);
  if (op.after) checkPlayState(`${where} after`, op.after, op, problems);
  const writes = op.kind === 'createOffer' || op.kind === 'updateOffer' || op.kind === 'updateOfferPrices';
  if (writes && !op.regionsVersion) problems.push(`${where}: ${op.kind} needs regionsVersion (Play requires regionsVersion.version on create and patch)`);

  switch (op.kind) {
    case 'createOffer':
      if (op.before !== null || op.after === null) problems.push(`${where}: createOffer goes from no offer (before: null) to an offer`);
      else if (op.after.state === 'INACTIVE') problems.push(`${where}: a new Play offer is DRAFT, or ACTIVE once activated; it can't be created INACTIVE`);
      break;
    case 'updateOffer':
    case 'updateOfferPrices':
      if (!op.before || !op.after) {
        problems.push(`${where}: ${op.kind} needs before and after`);
        break;
      }
      if (op.before.state !== op.after.state) problems.push(`${where}: ${op.kind} doesn't change the offer's state (use activateOffer or deactivateOffer)`);
      if (samePlayOfferContent(op.before, op.after)) problems.push(`${where}: no changes`);
      if (op.kind === 'updateOfferPrices') {
        if (!samePlayPhaseTerms(op.before, op.after) || !sameTargeting(op.before.targeting, op.after.targeting) || canonicalJson(op.before.tags) !== canonicalJson(op.after.tags)) {
          problems.push(`${where}: updateOfferPrices changes phase prices only; use updateOffer for terms, targeting or tags`);
        }
        for (const r of Object.keys(op.before.regions)) if (!op.after.regions[r]) problems.push(`${where}: ${r} would lose its price; updateOfferPrices only changes or adds regions`);
      }
      break;
    case 'activateOffer':
    case 'deactivateOffer': {
      if (!op.before || !op.after) {
        problems.push(`${where}: ${op.kind} needs before and after`);
        break;
      }
      if (!samePlayOfferContent(op.before, op.after)) problems.push(`${where}: ${op.kind} changes only the offer's state`);
      if (op.kind === 'activateOffer' && (op.after.state !== 'ACTIVE' || op.before.state === 'ACTIVE')) problems.push(`${where}: activateOffer goes from DRAFT or INACTIVE to ACTIVE`);
      if (op.kind === 'deactivateOffer' && (op.after.state !== 'INACTIVE' || op.before.state !== 'ACTIVE')) problems.push(`${where}: deactivateOffer goes from ACTIVE to INACTIVE`);
      break;
    }
    case 'deleteOffer':
      if (!op.before || op.after !== null) problems.push(`${where}: deleteOffer goes from an offer (before) to none (after: null)`);
      else if (op.before.state !== 'DRAFT') problems.push(`${where}: Google Play deletes only draft offers; deactivate an ${op.before.state.toLowerCase()} offer instead`);
      break;
  }
  const expected = computePlayOfferIdempotencyKey(op);
  if (op.idempotencyKey !== expected) problems.push(`${where}: idempotencyKey doesn't match the op (expected "${expected}")`);
  return problems;
}

// ---------------------------------------------------------------------------
// Classification

export type PlayOfferClassification =
  | { kind: 'atTarget'; observed: PlayOfferState | null }
  /** pending: ['activate'] when a create already took effect as a DRAFT and only the activation is left */
  | { kind: 'ready'; observed: PlayOfferState | null; offer?: StoreOffer; pending?: string[] }
  | { kind: 'drifted'; observed: PlayOfferState | null; message: string };

const NOTHING_SENT = 'Nothing was sent. Re-plan from the current offers.';

/** The Play offers of `product` with this offerId (normally one) */
function findPlayOffer(op: PlayOfferOp, offers: StoreOffer[]): StoreOffer[] {
  const product = op.target.product;
  return offers.filter(
    (o) =>
      o.kind === 'play.offer' &&
      o.key === op.target.offer.key &&
      (!o.play || product.platform !== 'google' || product.type !== 'subscription' || (o.play.productId === product.productId && o.play.basePlanId === product.basePlanId))
  );
}

/** Problems that make a read offer unusable for writing */
export function storeOfferProblems(offer: StoreOffer): string[] {
  return [...(offer.problems ?? []), ...Object.entries(offer.territoryProblems ?? {}).map(([t, p]) => `${t}: ${p}`)];
}

/** Compare a Play offer op with the base plan's offers as read now */
export function classifyPlayOfferOp(op: PlayOfferOp, offers: StoreOffer[]): PlayOfferClassification {
  const label = `Play offer "${op.target.offer.key}"`;
  const matches = findPlayOffer(op, offers);
  if (matches.length > 1) return { kind: 'drifted', observed: null, message: `${matches.length} offers have the ID "${op.target.offer.key}". ${NOTHING_SENT}` };
  const offer = matches[0];
  const observed = offer?.play?.offer ?? null;
  if (offer) {
    const unreadable = storeOfferProblems(offer);
    if (unreadable.length > 0 || !observed) {
      return { kind: 'drifted', observed, message: `The ${label} can't be read unambiguously (${unreadable.slice(0, 3).join('; ') || 'no offer details'}). ${NOTHING_SENT}` };
    }
  }

  switch (op.kind) {
    case 'createOffer': {
      const after = op.after!;
      if (!observed) return { kind: 'ready', observed: null };
      if (!samePlayOfferContent(observed, after)) return { kind: 'drifted', observed, message: `A ${label} already exists with other phases, eligibility, tags or regions. ${NOTHING_SENT}` };
      if (observed.state === after.state) return { kind: 'atTarget', observed };
      // A create that took effect, but whose activation didn't (yet)
      if (observed.state === 'DRAFT' && after.state === 'ACTIVE') return { kind: 'ready', observed, offer, pending: ['activate'] };
      return { kind: 'drifted', observed, message: `The ${label} exists but is ${observed.state}; the plan creates it ${after.state}. ${NOTHING_SENT}` };
    }
    case 'deleteOffer':
      if (!observed) return { kind: 'atTarget', observed: null };
      if (playOfferStateMatches(observed, op.before!)) return { kind: 'ready', observed, offer };
      return { kind: 'drifted', observed, message: `The ${label} changed since the plan was made (it is ${observed.state}). ${NOTHING_SENT}` };
    case 'updateOffer':
    case 'updateOfferPrices':
    case 'activateOffer':
    case 'deactivateOffer': {
      if (!observed) return { kind: 'drifted', observed: null, message: `The ${label} no longer exists. ${NOTHING_SENT}` };
      if (playOfferStateMatches(observed, op.after!)) return { kind: 'atTarget', observed };
      if (playOfferStateMatches(observed, op.before!)) return { kind: 'ready', observed, offer };
      return { kind: 'drifted', observed, message: `The ${label} changed since the plan was made. ${NOTHING_SENT}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Undo

export interface PlayOfferInverse {
  op?: Omit<PlayOfferOp, 'id'>;
  caveat?: string;
  notReversible?: string;
}

function makePlayInverse(op: PlayOfferOp, kind: PlayOfferOpKind, before: PlayOfferState | null, after: PlayOfferState | null): Omit<PlayOfferOp, 'id'> {
  const inverse: Omit<PlayOfferOp, 'id' | 'idempotencyKey'> = {
    kind,
    platform: 'google',
    target: op.target,
    before,
    after,
    ...(op.regionsVersion && (kind === 'createOffer' || kind === 'updateOffer' || kind === 'updateOfferPrices') ? { regionsVersion: op.regionsVersion } : {}),
    note: `undo of ${op.id}`,
  };
  return { ...inverse, idempotencyKey: computePlayOfferIdempotencyKey(inverse) };
}

/** The op that restores what a Play offer op changed, and what it can't restore */
export function invertPlayOfferOp(op: PlayOfferOp, history: { activated?: boolean } = {}): PlayOfferInverse {
  switch (op.kind) {
    case 'createOffer': {
      const after = op.after!;
      if (after.state === 'DRAFT' || history.activated === false) {
        // Created as a draft, or created but never activated: the draft can be deleted
        if (after.state !== 'DRAFT') return { op: makePlayInverse(op, 'deleteOffer', { ...after, state: 'DRAFT' }, null), caveat: 'The run created the offer but did not activate it; undo deletes the draft (irreversible, needs force).' };
        return { op: makePlayInverse(op, 'deleteOffer', after, null), caveat: 'Deleting the draft offer is irreversible and needs force.' };
      }
      return {
        op: makePlayInverse(op, 'deactivateOffer', after, { ...after, state: 'INACTIVE' }),
        caveat: "Google Play deletes only draft offers, so undo deactivates the offer instead: new customers can't take it, subscribers who already did keep it, and its offer ID stays taken.",
      };
    }
    case 'updateOffer':
    case 'updateOfferPrices': {
      const added = Object.keys(op.after!.regions).filter((r) => !op.before!.regions[r]);
      const kind = op.kind;
      return {
        op: makePlayInverse(op, kind === 'updateOfferPrices' && added.length > 0 ? 'updateOffer' : kind, op.after, op.before),
        ...(added.length ? { caveat: `Undo removes the regions the update added (${added.join(', ')}).` } : {}),
      };
    }
    case 'activateOffer':
      if (op.before!.state === 'DRAFT') {
        return {
          op: makePlayInverse(op, 'deactivateOffer', op.after, { ...op.after!, state: 'INACTIVE' }),
          caveat: "An activated offer can't return to draft; undo deactivates it (INACTIVE), and it can no longer be deleted.",
        };
      }
      return { op: makePlayInverse(op, 'deactivateOffer', op.after, op.before) };
    case 'deactivateOffer':
      return { op: makePlayInverse(op, 'activateOffer', op.after, op.before) };
    case 'deleteOffer':
      if (!op.regionsVersion) return { notReversible: 'The delete op carries no regionsVersion, so the offer would have to be re-created by hand.' };
      return {
        op: makePlayInverse(op, 'createOffer', null, op.before),
        caveat: 'Undo re-creates the draft offer under the same offer ID. Whether Play accepts a deleted offer ID again is not confirmed.',
      };
  }
}

// ---------------------------------------------------------------------------
// Reading helpers shared by the adapter and the planners

/** A decimal from a JSON number Play returns (relativeDiscount); undefined when it isn't a plain decimal */
export function decimalFromJsonNumber(value: unknown): Decimal | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const text = String(value);
  return isDecimalString(text) ? normalizeDecimal(text) : undefined;
}
