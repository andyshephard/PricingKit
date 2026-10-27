// Offer plans: an OfferSpec plus what the store holds now -> a ChangeSet of
// offer ops and a per-territory preview. Pure: callers (the Apple adapter,
// tests, a CLI) pass in the base prices, price-point ladders and existing
// offers they read.
//
// The planner never guesses: a territory whose price can't be derived is
// left out and listed in `skipped`, and anything Apple would refuse (an 11th
// promotional offer, changing an existing offer's terms, re-pricing an offer
// code) is refused here, with the reason, before any plan is written.

import { z } from 'zod';
import {
  CHANGESET_KIND,
  CHANGESET_SCHEMA_VERSION,
  changeSetHash,
  checkChangeSetRules,
  ChangeSetValidationError,
  type ChangeSet,
  type PlanSkip,
} from './changeset';
import { compareDecimal, isDecimalString, normalizeDecimal, type Decimal } from './decimal';
import { productKey, type AppRef, type ProductPriceState, type ProductRef } from './model';
import { deriveOfferPrices, type OfferDerivation, type OfferPreviewRow, type PriceLadder } from './offer-derivation';
import {
  changedTerritories,
  computeOfferIdempotencyKey,
  introEntriesByTerritory,
  introOfferKey,
  MAX_APPLE_PROMOTIONAL_OFFERS,
  offerKindLabel,
  sameOfferPrice,
  sameTerms,
  storeOfferToState,
  windowsOverlap,
  type OfferOp,
  type OfferOpKind,
  type OfferState,
} from './offer-ops';
import {
  offerSpecSchema,
  parseOfferSpec,
  type AppleOfferKind,
  type BillingPeriod,
  type OfferSpec,
  type OfferTerritoryPrice,
  type StoreOffer,
} from './offers';
import { appRefSchema } from './refs';

// ---------------------------------------------------------------------------
// The spec file: several offers (e.g. one per product) planned together

export const OFFER_PLAN_SPEC_KIND = 'pricingkit.offerPlanSpec' as const;
export const OFFER_PLAN_SPEC_SCHEMA_VERSION = 1 as const;

export interface OfferPlanSpec {
  kind: typeof OFFER_PLAN_SPEC_KIND;
  schemaVersion: typeof OFFER_PLAN_SPEC_SCHEMA_VERSION;
  app: AppRef;
  description?: string;
  offers: OfferSpec[];
}

const offerPlanSpecSchema = z
  .object({
    kind: z.literal(OFFER_PLAN_SPEC_KIND),
    schemaVersion: z.literal(OFFER_PLAN_SPEC_SCHEMA_VERSION),
    app: appRefSchema,
    description: z.string().optional(),
    offers: z.array(offerSpecSchema).min(1),
  })
  .strict();

export class InvalidOfferPlanSpecError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid offer plan spec:\n- ${problems.join('\n- ')}`);
    this.name = 'InvalidOfferPlanSpecError';
  }
}

/**
 * Validate an offer plan spec (JSON text or object). Besides each offer's
 * own rules: Apple offers only, and no two offers of one kind may share a key,
 * because Apple needs promotional offer codes and offer code names to be
 * unique across a subscription group (give each product its own code).
 */
export function parseOfferPlanSpec(input: string | unknown): OfferPlanSpec {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw new InvalidOfferPlanSpecError([`not valid JSON: ${(error as Error).message}`]);
    }
  }
  const parsed = offerPlanSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidOfferPlanSpecError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const problems: string[] = [];
  const spec = parsed.data as OfferPlanSpec;
  spec.offers.forEach((offer, i) => {
    try {
      parseOfferSpec(offer);
    } catch (error) {
      problems.push(...((error as { problems?: string[] }).problems ?? [String(error)]).map((p) => `offers.${i}: ${p}`));
    }
    if (!offer.kind.startsWith('apple.')) problems.push(`offers.${i}: only Apple offers can be planned in this version`);
  });
  if ('packageName' in spec.app) problems.push('app: offer plans are for Apple apps (bundleId) in this version');
  const seen = new Map<string, number>();
  spec.offers.forEach((offer, i) => {
    if (offer.kind === 'apple.intro') return;
    const key = `${offer.kind}|${offer.id}`;
    if (seen.has(key)) {
      problems.push(`offers.${i}: "${offer.id}" is also used by offers.${seen.get(key)}; Apple needs ${offerKindLabel(offer.kind as AppleOfferKind)} keys to be unique across a subscription group, so give each product its own`);
    } else seen.set(key, i);
  });
  if (problems.length) throw new InvalidOfferPlanSpecError(problems);
  return spec;
}

// ---------------------------------------------------------------------------
// Planning

/** Everything the planner needs to know about one offer's product */
export interface OfferPlanInput {
  spec: OfferSpec;
  billingPeriod: BillingPeriod;
  /** Current base prices of the product */
  base: ProductPriceState;
  /** Valid price points per alpha-2 territory */
  ladders: Record<string, PriceLadder>;
  /** The product's offers of this kind (all of them, for the promotional-offer cap) */
  existing: StoreOffer[];
  deviationThreshold?: Decimal;
}

export type OfferRefusalCode =
  | 'PROMO_OFFER_CAP'
  | 'TERMS_IMMUTABLE'
  | 'PRICES_IMMUTABLE'
  | 'AMBIGUOUS_OFFER'
  | 'OFFER_UNREADABLE'
  | 'MISSING_SETTINGS'
  | 'UNSUPPORTED_PRICING'
  | 'NO_PRICES';

export interface OfferPlanEntry {
  product: ProductRef;
  kind: AppleOfferKind;
  /** The spec's id */
  specId: string;
  /** The key the op targets (the spec's id; intro offers: their terms key) */
  key: string;
  name?: string;
  /** What the plan does with this offer */
  action: 'create' | 'updatePrices' | 'none' | 'refused';
  /** The op's id in the ChangeSet, when there is one */
  opId?: string;
  /** Per-territory derivation (percent-of-current rules): current price, exact target, snapped price, flags */
  derivation?: OfferDerivation;
  /** Territories whose offer price the plan sets or changes */
  changes: Array<{ territory: string; before: OfferTerritoryPrice | null; after: OfferTerritoryPrice }>;
  refusals: Array<{ code: OfferRefusalCode; message: string }>;
  warnings: string[];
}

export interface OfferPlan {
  changeSet: ChangeSet;
  /** changeSetHash(changeSet): what an apply must confirm */
  hash: string;
  entries: OfferPlanEntry[];
}

export interface PlanOffersInput {
  app: AppRef;
  inputs: OfferPlanInput[];
  id?: string;
  createdAt?: string;
  description?: string;
  /** YYYY-MM-DD, for intro offer windows without a start date (default: today, UTC) */
  today?: string;
}

interface Derived {
  prices: Record<string, OfferTerritoryPrice>;
  skipped: PlanSkip[];
  derivation?: OfferDerivation;
  refusal?: { code: OfferRefusalCode; message: string };
}

function skipReason(row: OfferPreviewRow): PlanSkip['reason'] {
  const codes = row.flags.filter((f) => f.severity === 'error').map((f) => f.code);
  if (codes.includes('NO_CURRENT_PRICE')) return 'NOT_CONFIGURED';
  if (codes.includes('CURRENT_PRICE_UNREADABLE')) return 'AMBIGUOUS_STATE';
  if (codes.includes('CURRENCY_MISMATCH')) return 'CURRENCY_MISMATCH';
  if (codes.includes('NO_PRICE_POINT') || codes.includes('NO_PRICE_LADDER')) return 'UNRESOLVED_PRICE_POINT';
  return 'INVALID_TARGET';
}

function scopeTerritories(spec: OfferSpec, base: ProductPriceState): string[] {
  return spec.territories === 'all' ? Object.keys(base.territories).sort() : [...new Set(spec.territories)].sort();
}

/** Each territory's offer price under the spec's pricing rule */
function derivePrices(input: OfferPlanInput): Derived {
  const { spec, base, ladders } = input;
  const product = spec.productRef;
  const skipped: PlanSkip[] = [];
  const prices: Record<string, OfferTerritoryPrice> = {};
  const skip = (territory: string, reason: PlanSkip['reason'], detail: string) => skipped.push({ product, territory, offerKey: spec.id, reason, detail });

  switch (spec.pricing.type) {
    case 'percentOfCurrent': {
      const derivation = deriveOfferPrices({
        rule: spec.pricing,
        offer: { mode: spec.mode, duration: spec.duration },
        billingPeriod: input.billingPeriod,
        base,
        ladders,
        territories: spec.territories,
        deviationThreshold: input.deviationThreshold,
      });
      for (const row of derivation.rows) {
        if (!row.ok || row.snappedPrice === null) {
          skip(row.territory, skipReason(row), row.flags.filter((f) => f.severity === 'error').map((f) => f.message).join('; '));
        } else if (!row.pricePointId) {
          skip(row.territory, 'UNRESOLVED_PRICE_POINT', `${row.snappedPrice} ${row.currency} has no price point ID`);
        } else {
          prices[row.territory] = {
            currency: row.currency,
            amount: row.snappedPrice,
            pricePointId: row.pricePointId,
            ...(row.proceeds ? { proceeds: row.proceeds } : {}),
          };
        }
      }
      return { prices, skipped, derivation };
    }
    case 'free':
      for (const territory of scopeTerritories(spec, base)) {
        const currency = base.territories[territory]?.current?.currency ?? base.territories[territory]?.currency;
        if (!currency) skip(territory, 'NOT_CONFIGURED', `${territory} has no base price, so the subscription isn't sold there`);
        else prices[territory] = { currency, amount: '0', free: true };
      }
      return { prices, skipped };
    case 'fixed': {
      const fixed = spec.pricing.prices;
      for (const territory of spec.territories === 'all' ? Object.keys(fixed).sort() : scopeTerritories(spec, base)) {
        const amount = fixed[territory];
        const state = base.territories[territory];
        const ladder = ladders[territory];
        const currency = state?.current?.currency ?? ladder?.currency;
        if (!state?.current || !currency) {
          skip(territory, 'NOT_CONFIGURED', `${territory} has no base price`);
          continue;
        }
        const point = ladder?.points.find((p) => isDecimalString(p.customerPrice) && compareDecimal(normalizeDecimal(p.customerPrice), amount) === 0);
        if (!point?.id) {
          skip(territory, 'UNRESOLVED_PRICE_POINT', `${amount} ${currency} is not one of ${territory}'s price points`);
          continue;
        }
        if (compareDecimal(amount, state.current.amount) >= 0) {
          skip(territory, 'INVALID_TARGET', `${amount} ${currency} is not below the current price ${state.current.amount}`);
          continue;
        }
        prices[territory] = { currency, amount: normalizeDecimal(amount), pricePointId: point.id, ...(point.proceeds && isDecimalString(point.proceeds) ? { proceeds: normalizeDecimal(point.proceeds) } : {}) };
      }
      return { prices, skipped };
    }
    default:
      return { prices, skipped, refusal: { code: 'UNSUPPORTED_PRICING', message: `${spec.pricing.type} pricing is Play-only` } };
  }
}

/** The offer state a spec describes, with the given prices */
function targetState(spec: OfferSpec, prices: Record<string, OfferTerritoryPrice>): OfferState {
  const kind = spec.kind as AppleOfferKind;
  const periods = spec.periods ?? 1;
  const key = kind === 'apple.intro' ? introOfferKey({ mode: spec.mode, duration: spec.duration, periods, start: spec.schedule?.start }) : spec.id;
  return {
    kind,
    key,
    ...(kind !== 'apple.intro' ? { name: spec.name ?? spec.id } : {}),
    mode: spec.mode,
    duration: spec.duration,
    periods,
    ...(spec.eligibility ? { eligibility: spec.eligibility } : {}),
    ...(spec.schedule && (spec.schedule.start || spec.schedule.end) ? { schedule: { ...spec.schedule } } : {}),
    ...(kind === 'apple.offerCode' ? { active: true } : {}),
    ...(kind === 'apple.offerCode' && spec.apple?.autoRenewEnabled !== undefined ? { autoRenewEnabled: spec.apple.autoRenewEnabled } : {}),
    ...(kind === 'apple.winBack' ? { priority: spec.apple?.priority ?? 'NORMAL' } : {}),
    ...(kind === 'apple.winBack' && spec.apple?.promotionIntent ? { promotionIntent: spec.apple.promotionIntent } : {}),
    prices,
  };
}

function makeOp(kind: OfferOpKind, product: ProductRef, before: OfferState | null, after: OfferState | null, note?: string): Omit<OfferOp, 'id'> {
  const offer = (after ?? before)!;
  const op: Omit<OfferOp, 'id' | 'idempotencyKey'> = {
    kind,
    platform: 'apple',
    target: { product, offer: { kind: offer.kind, key: offer.key } },
    before,
    after,
    ...(note ? { note } : {}),
  };
  return { ...op, idempotencyKey: computeOfferIdempotencyKey(op) };
}

const LABEL = (kind: AppleOfferKind) => offerKindLabel(kind);

function settingsProblems(spec: OfferSpec): string[] {
  const problems: string[] = [];
  if (spec.kind === 'apple.offerCode' && spec.eligibility?.type !== 'apple.offerCode') {
    problems.push('an offer code needs eligibility { type: "apple.offerCode", customerEligibilities, offerEligibility }');
  }
  if (spec.kind === 'apple.winBack') {
    if (spec.eligibility?.type !== 'apple.winBack') problems.push('a win-back offer needs its eligibility (paid subscription duration, time since last subscribed)');
    if (!spec.schedule?.start) problems.push('a win-back offer needs schedule.start (Apple requires a start date)');
  }
  return problems;
}

/** Plan one offer: create it, re-price it, leave it, or refuse with the reason */
function planOne(input: OfferPlanInput, today: string): { entry: OfferPlanEntry; op?: Omit<OfferOp, 'id'>; skipped: PlanSkip[] } {
  const { spec } = input;
  const product = spec.productRef;
  const kind = spec.kind as AppleOfferKind;
  const entry: OfferPlanEntry = {
    product,
    kind,
    specId: spec.id,
    key: spec.id,
    ...(kind !== 'apple.intro' ? { name: spec.name ?? spec.id } : {}),
    action: 'refused',
    changes: [],
    refusals: [],
    warnings: [],
  };
  const refuse = (code: OfferRefusalCode, message: string) => {
    entry.refusals.push({ code, message });
    return { entry, skipped: [] };
  };

  if (!kind.startsWith('apple.') || product.platform !== 'apple' || product.type !== 'subscription') {
    return refuse('UNSUPPORTED_PRICING', 'Only Apple subscription offers can be planned in this version');
  }
  for (const problem of settingsProblems(spec)) entry.refusals.push({ code: 'MISSING_SETTINGS', message: problem });
  if (entry.refusals.length) return { entry, skipped: [] };
  if (spec.mode === 'PAY_AS_YOU_GO') {
    entry.warnings.push(
      'Pay as you go: Apple charges the offer price every period for `periods` periods. Whether `duration` is the length of one period or of the whole offer is not confirmed against App Store Connect; check the offer in App Store Connect after applying.'
    );
  }
  if (spec.mode === 'FREE_TRIAL') {
    entry.warnings.push('Free trial prices are sent with a territory and no price point. App Store Connect reports free-trial prices that way (confirmed on reads); that it accepts them that way on create is not yet confirmed.');
  }

  const derived = derivePrices(input);
  if (derived.derivation) entry.derivation = derived.derivation;
  if (derived.refusal) return refuse(derived.refusal.code, derived.refusal.message);
  const target = targetState(spec, derived.prices);
  entry.key = target.key;

  if (kind === 'apple.intro') return planIntro(input, entry, target, derived.skipped, today);

  const matches = input.existing.filter((o) => o.kind === kind && o.key === spec.id);
  if (matches.length > 1) return { ...refuse('AMBIGUOUS_OFFER', `${matches.length} ${LABEL(kind)}s share the key "${spec.id}"`), skipped: derived.skipped };

  if (matches.length === 0) {
    if (Object.keys(target.prices).length === 0) {
      return { ...refuse('NO_PRICES', `No territory has a usable offer price; see the skipped territories`), skipped: derived.skipped };
    }
    if (kind === 'apple.promo') {
      const promos = input.existing.filter((o) => o.kind === 'apple.promo').length;
      if (promos >= MAX_APPLE_PROMOTIONAL_OFFERS) {
        return {
          ...refuse(
            'PROMO_OFFER_CAP',
            `The subscription already has ${promos} promotional offers; Apple allows ${MAX_APPLE_PROMOTIONAL_OFFERS}. Delete one before creating "${spec.id}".`
          ),
          skipped: derived.skipped,
        };
      }
      entry.warnings.push('Apple needs promotional offer codes to be unique across the subscription group; PricingKit checks only this subscription and the other offers in this plan.');
    }
    entry.action = 'create';
    entry.changes = Object.keys(target.prices).sort().map((t) => ({ territory: t, before: null, after: target.prices[t] }));
    return { entry, op: makeOp('createOffer', product, null, target), skipped: derived.skipped };
  }

  const existing = matches[0];
  const current = storeOfferToState(existing);
  const unreadable = [...(existing.problems ?? []), ...Object.entries(existing.territoryProblems ?? {}).map(([t, p]) => `${t}: ${p}`)];
  if (!current || unreadable.length) {
    return {
      ...refuse('OFFER_UNREADABLE', `The existing ${LABEL(kind)} "${spec.id}" can't be read unambiguously (${unreadable.slice(0, 3).join('; ') || 'unknown mode or duration'})`),
      skipped: derived.skipped,
    };
  }
  if (!sameTerms(current, target)) {
    const now = `${current.mode} ${current.duration}${current.periods > 1 ? ` x ${current.periods}` : ''}`;
    const want = `${target.mode} ${target.duration}${target.periods > 1 ? ` x ${target.periods}` : ''}`;
    return {
      ...refuse(
        'TERMS_IMMUTABLE',
        `The ${LABEL(kind)} "${spec.id}" already exists as ${now} (the spec asks for ${want}). Apple doesn't allow changing an existing offer's duration, mode or number of periods. Create the offer under a new key, or delete this one first (deleting needs force).`
      ),
      skipped: derived.skipped,
    };
  }

  // Same terms: only prices may differ. Territories the rule can't price keep their current price.
  const after: OfferState = { ...current, prices: { ...current.prices, ...target.prices } };
  const changed = changedTerritories(current.prices, after.prices);
  if (changed.length === 0) {
    entry.action = 'none';
    return { entry, skipped: [...derived.skipped, ...Object.keys(target.prices).map((t) => ({ product, territory: t, offerKey: spec.id, reason: 'ALREADY_AT_TARGET' as const }))] };
  }
  if (kind !== 'apple.promo') {
    const how =
      kind === 'apple.offerCode'
        ? "Apple can't change an offer code's prices; create a new offer code and deactivate this one"
        : "Apple's win-back offer update has no prices; create a new win-back offer (new offer ID) and end or delete this one";
    return { ...refuse('PRICES_IMMUTABLE', `${changed.length} territories differ from the rule. ${how}.`), skipped: derived.skipped };
  }
  entry.action = 'updatePrices';
  entry.changes = changed.map((t) => ({ territory: t, before: current.prices[t] ?? null, after: after.prices[t] }));
  return { entry, op: makeOp('updateOfferPrices', product, current, after), skipped: derived.skipped };
}

function planIntro(input: OfferPlanInput, entry: OfferPlanEntry, target: OfferState, skipped: PlanSkip[], today: string) {
  const product = input.spec.productRef;
  const byTerritory = introEntriesByTerritory(input.existing);
  const window = { start: target.schedule?.start, end: target.schedule?.end };
  const toCreate: Record<string, OfferTerritoryPrice> = {};
  for (const territory of Object.keys(target.prices).sort()) {
    const entries = byTerritory.get(territory) ?? [];
    const same = entries.find((e) => e.key === target.key);
    if (same) {
      if (sameOfferPrice(same.price, target.prices[territory]) && (same.end ?? null) === (target.schedule?.end ?? null)) {
        skipped.push({ product, territory, offerKey: target.key, reason: 'ALREADY_AT_TARGET' });
      } else {
        skipped.push({
          product,
          territory,
          offerKey: target.key,
          reason: 'OFFER_CONFLICT',
          detail: `An introductory offer with these terms already exists at ${same.price ? `${same.price.amount} ${same.price.currency}` : 'an unreadable price'}${same.end ? ` until ${same.end}` : ''}; Apple can't change its price. End or delete it first.`,
        });
      }
      continue;
    }
    const clash = entries.find((e) => windowsOverlap({ start: e.start, end: e.end }, window, today));
    if (clash) {
      skipped.push({
        product,
        territory,
        offerKey: target.key,
        reason: 'OFFER_CONFLICT',
        detail: `Overlaps the introductory offer ${clash.key}${clash.start ? ` from ${clash.start}` : ''}${clash.end ? ` until ${clash.end}` : ''}; Apple allows one introductory offer per territory at a time.`,
      });
      continue;
    }
    toCreate[territory] = target.prices[territory];
  }
  if (Object.keys(toCreate).length === 0) {
    entry.action = Object.keys(target.prices).length > 0 && skipped.every((s) => s.reason === 'ALREADY_AT_TARGET') ? 'none' : 'refused';
    if (entry.action === 'refused') entry.refusals.push({ code: 'NO_PRICES', message: 'No territory can get this introductory offer; see the skipped territories' });
    return { entry, skipped };
  }
  const after: OfferState = { ...target, prices: toCreate };
  entry.action = 'create';
  entry.changes = Object.keys(toCreate).map((t) => ({ territory: t, before: null, after: toCreate[t] }));
  return { entry, op: makeOp('createOffer', product, null, after), skipped };
}

/**
 * Plan every offer in `inputs` into one ChangeSet. Offers the planner
 * refuses get no op; their entries say why. The result's `hash` is what an
 * apply must pass as `confirm`.
 */
export function planOfferChanges(input: PlanOffersInput): OfferPlan {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const entries: OfferPlanEntry[] = [];
  const ops: Array<Omit<OfferOp, 'id'>> = [];
  const skipped: PlanSkip[] = [];
  const warnings: Array<{ index: number; message: string }> = [];
  const keys = new Set<string>();

  for (const item of input.inputs) {
    const result = planOne(item, today);
    const targetKey = `${productKey(item.spec.productRef)}|${item.spec.kind}|${result.entry.key}`;
    if (keys.has(targetKey)) {
      result.entry.refusals.push({ code: 'AMBIGUOUS_OFFER', message: `Another offer in this plan already targets "${result.entry.key}" on this product` });
      result.entry.action = 'refused';
      delete result.op;
    }
    keys.add(targetKey);
    if (result.op) {
      result.entry.opId = `op-${String(ops.length + 1).padStart(4, '0')}`;
      for (const w of result.entry.warnings) warnings.push({ index: ops.length, message: w });
      ops.push(result.op);
    }
    entries.push(result.entry);
    skipped.push(...result.skipped);
  }

  const numbered = ops.map((op, i) => ({ id: `op-${String(i + 1).padStart(4, '0')}`, ...op }) as OfferOp);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const draft = { app: input.app, ops: numbered };
  const changeSet: ChangeSet = {
    schemaVersion: CHANGESET_SCHEMA_VERSION,
    kind: CHANGESET_KIND,
    id: input.id ?? `offers-${createdAt.replace(/[^0-9]/g, '').slice(0, 14)}-${changeSetHash(draft).slice(0, 8)}`,
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
// Ending, re-activating and deleting an existing offer

export interface OfferLifecycleInput {
  app: AppRef;
  product: ProductRef;
  /** The product's offers, as read now */
  existing: StoreOffer[];
  kind: AppleOfferKind;
  /** Offer key (promo offerCode, offer code name, win-back offerId) or, for intro offers, introOfferKey(...) */
  key: string;
  action: 'deactivate' | 'activate' | 'delete';
  /** Intro and win-back offers: the end date to set (deactivate), YYYY-MM-DD */
  endDate?: string;
  createdAt?: string;
  id?: string;
}

/**
 * A one-op plan that ends (deactivates), re-activates or deletes an
 * existing offer. Throws OfferLifecycleError when Apple has no way to do it
 * (e.g. delete an offer code, end a promotional offer).
 */
export function planOfferLifecycle(input: OfferLifecycleInput): OfferPlan {
  const { kind, key, action } = input;
  const label = LABEL(kind);
  let current: OfferState | null;
  if (kind === 'apple.intro') {
    const byTerritory = introEntriesByTerritory(input.existing);
    const prices: Record<string, OfferTerritoryPrice> = {};
    const ends = new Set<string>();
    let sample: StoreOffer | undefined;
    for (const [territory, entries] of byTerritory) {
      const mine = entries.find((e) => e.key === key);
      if (!mine) continue;
      if (mine.problem || !mine.price) throw new OfferLifecycleError(`${territory}: ${mine.problem ?? 'unreadable price'}`);
      prices[territory] = mine.price;
      ends.add(mine.end ?? '');
      sample ??= input.existing.find((o) => o.kind === 'apple.intro' && Object.keys(o.prices).includes(territory) && o.storeRefs?.[territory]);
    }
    if (!sample || Object.keys(prices).length === 0) throw new OfferLifecycleError(`No introductory offer "${key}"`);
    if (ends.size > 1) throw new OfferLifecycleError(`The introductory offer "${key}" has different end dates per territory; plan territories separately`);
    current = storeOfferToState({ ...sample, prices });
    if (current) current.key = key;
  } else {
    const matches = input.existing.filter((o) => o.kind === kind && (o.key === key || o.storeId === key));
    if (matches.length !== 1) throw new OfferLifecycleError(matches.length ? `${matches.length} ${label}s match "${key}"` : `No ${label} "${key}"`);
    current = storeOfferToState(matches[0]);
  }
  if (!current) throw new OfferLifecycleError(`The ${label} "${key}" has an unknown mode or duration`);

  let op: Omit<OfferOp, 'id'>;
  if (action === 'delete') {
    if (kind === 'apple.offerCode') throw new OfferLifecycleError("App Store Connect's API can't delete an offer code; deactivate it instead");
    op = makeOp('deleteOffer', input.product, current, null, 'Redemptions can\'t be checked through the API; applying needs force.deleteOffers');
  } else if (kind === 'apple.promo') {
    throw new OfferLifecycleError('Apple promotional offers have no active switch or end date; stop presenting the offer in your app, or delete it');
  } else if (kind === 'apple.offerCode') {
    const active = action === 'activate';
    if ((current.active ?? true) === active) throw new OfferLifecycleError(`The offer code "${key}" is already ${active ? 'active' : 'inactive'}`);
    op = makeOp(active ? 'activateOffer' : 'deactivateOffer', input.product, current, { ...current, active });
  } else {
    const end = input.endDate;
    if (action === 'deactivate' && !end) throw new OfferLifecycleError(`Deactivating a ${label} sets its end date; pass endDate`);
    const schedule = { ...(current.schedule ?? {}) };
    if (end) schedule.end = end;
    else delete schedule.end;
    if ((current.schedule?.end ?? null) === (schedule.end ?? null)) throw new OfferLifecycleError(`The ${label} already ends ${schedule.end ?? 'never'}`);
    const after: OfferState = { ...current, schedule };
    if (!after.schedule?.start && !after.schedule?.end) delete after.schedule;
    op = makeOp(action === 'activate' ? 'activateOffer' : 'deactivateOffer', input.product, current, after);
  }
  const numbered = [{ id: 'op-0001', ...op } as OfferOp];
  const createdAt = input.createdAt ?? new Date().toISOString();
  const changeSet: ChangeSet = {
    schemaVersion: CHANGESET_SCHEMA_VERSION,
    kind: CHANGESET_KIND,
    id: input.id ?? `offer-${action}-${createdAt.replace(/[^0-9]/g, '').slice(0, 14)}`,
    createdAt,
    app: input.app,
    ops: numbered,
  };
  const problems = checkChangeSetRules(changeSet);
  if (problems.length > 0) throw new ChangeSetValidationError(problems);
  const entry: OfferPlanEntry = {
    product: input.product,
    kind,
    specId: key,
    key,
    ...(current.name ? { name: current.name } : {}),
    action: 'none',
    opId: 'op-0001',
    changes: [],
    refusals: [],
    warnings: action === 'delete' ? ["App Store Connect's API doesn't report redemptions, so PricingKit can't check whether anyone redeemed this offer."] : [],
  };
  return { changeSet, hash: changeSetHash(changeSet), entries: [entry] };
}

export class OfferLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfferLifecycleError';
  }
}
