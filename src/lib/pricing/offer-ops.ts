// Offer ops: the plan-file form of creating, re-pricing, ending and deleting
// subscription offers, and the pure rules the executor uses to apply them
// idempotently.
//
// Like base-price ops, every offer op names the offer state it expects to
// find (`before`) and the state it leaves (`after`). Before writing, the
// executor reads the product's offers and compares:
//   - already at `after`  -> skipped (or confirmed, if an earlier attempt was sent)
//   - at `before`         -> applied
//   - anything else       -> STATE_CHANGED, nothing sent
// Offers are found by their stable key (promotional offerCode, offer code
// name, win-back offerId), so a create that errored but took effect is
// recognised on resume and never sent twice.
//
// Apple introductory offers are one store resource per territory, so their
// ops are judged territory by territory: a create stopped halfway resumes
// with only the territories still missing.

import { z } from 'zod';
import { compareDecimal } from './decimal';
import { productKey, type Platform, type ProductRef } from './model';
import {
  APPLE_OFFER_KINDS,
  APPLE_WIN_BACK_PRIORITIES,
  APPLE_WIN_BACK_PROMOTION_INTENTS,
  OFFER_DURATIONS,
  OFFER_MODES,
  eligibilitySchema,
  type AppleOfferKind,
  type AppleWinBackPriority,
  type AppleWinBackPromotionIntent,
  type OfferDuration,
  type OfferEligibility,
  type OfferKind,
  type OfferMode,
  type OfferTerritoryPrice,
  type StoreOffer,
} from './offers';
import {
  checkPlayOfferOpRules,
  classifyPlayOfferOp,
  describePlayOfferOp,
  invertPlayOfferOp,
  PLAY_OFFER_OP_KINDS,
  playOfferOpSchema,
  playOfferStateSchema,
  type PlayOfferOp,
  type PlayOfferState,
} from './play-offers';
import { canonicalJson, currencySchema, decimalSchema, fnv1a64, productRefSchema, territorySchema } from './refs';

/**
 * createOffer        - create the offer with `after`'s terms and prices
 * updateOfferPrices  - replace a promotional offer's prices (terms unchanged)
 * deactivateOffer    - stop new redemptions: offer code active=false; intro and
 *                      win-back offers get an end date
 * activateOffer      - undo a deactivation (offer code active=true; restore the end date)
 * deleteOffer        - delete the offer (needs force: redemptions can't be checked)
 */
export const APPLE_OFFER_OP_KINDS = ['createOffer', 'updateOfferPrices', 'deactivateOffer', 'activateOffer', 'deleteOffer'] as const;
export type AppleOfferOpKind = (typeof APPLE_OFFER_OP_KINDS)[number];
/** Every offer op kind: Apple's, plus updateOffer (Google Play: patch phases, targeting, tags) */
export const OFFER_OP_KINDS = [...APPLE_OFFER_OP_KINDS, 'updateOffer'] as const;
export type OfferOpKind = (typeof OFFER_OP_KINDS)[number];

/**
 * Promotional offers a subscription may have, per Apple's App Store Connect
 * help ("up to 10 active promotional offers per subscription"). Not in the
 * OpenAPI spec; the planner refuses an 11th before Apple does.
 */
export const MAX_APPLE_PROMOTIONAL_OFFERS = 10;

/** An offer as a plan sees it: its terms and its price in every territory */
export interface OfferState {
  kind: AppleOfferKind;
  /** Stable key (promo offerCode, offer code name, win-back offerId; intro: see introOfferKey) */
  key: string;
  /** Reference name (promo name, win-back referenceName, offer code name) */
  name?: string;
  mode: OfferMode;
  duration: OfferDuration;
  /** Apple numberOfPeriods / periodCount */
  periods: number;
  eligibility?: OfferEligibility;
  /** YYYY-MM-DD */
  schedule?: { start?: string; end?: string };
  /** Offer codes: whether new redemptions are allowed */
  active?: boolean;
  /** Win-back */
  priority?: AppleWinBackPriority;
  promotionIntent?: AppleWinBackPromotionIntent;
  /** Offer codes */
  autoRenewEnabled?: boolean;
  /** alpha-2 keyed. Paid modes name a price point; a free trial is free: true */
  prices: Record<string, OfferTerritoryPrice>;
  /**
   * Intro offers only: the store resource of each territory. When set, ops
   * act on exactly these resources (undo deletes only what its run created)
   * instead of finding them by terms.
   */
  storeRefs?: Record<string, string>;
}

export interface OfferOp {
  /** Unique within the ChangeSet, e.g. "op-0001" */
  id: string;
  kind: AppleOfferOpKind;
  platform: Platform;
  target: { product: ProductRef; offer: { kind: AppleOfferKind; key: string } };
  /** The offer this op expects to find; null = no such offer */
  before: OfferState | null;
  /** The offer this op leaves; null for deleteOffer */
  after: OfferState | null;
  idempotencyKey: string;
  note?: string;
  /**
   * Base-price ops (IDs in the same ChangeSet) this op's prices were derived
   * from (sync plans: offers re-derived against the plan's target base
   * prices). The executor applies base-price ops first and fails this op
   * with BASE_NOT_APPLIED, sending nothing, if any of them failed.
   */
  dependsOn?: string[];
}

/** An App Store offer op (the name predates Google Play offers) */
export type AppleOfferOp = OfferOp;
/** An offer op of either store: App Store (OfferOp) or Google Play (PlayOfferOp, play-offers.ts) */
export type AnyOfferOp = OfferOp | PlayOfferOp;
/** The offer state of either store */
export type AnyOfferState = OfferState | PlayOfferState;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date, YYYY-MM-DD');

export const offerTerritoryPriceSchema = z
  .object({
    currency: currencySchema,
    amount: decimalSchema,
    pricePointId: z.string().min(1).optional(),
    proceeds: decimalSchema.optional(),
    free: z.literal(true).optional(),
  })
  .strict();

export const offerStateSchema = z
  .object({
    kind: z.enum(APPLE_OFFER_KINDS),
    key: z.string().min(1).max(200),
    name: z.string().min(1).max(200).optional(),
    mode: z.enum(OFFER_MODES),
    duration: z.enum(OFFER_DURATIONS),
    periods: z.number().int().min(1),
    eligibility: eligibilitySchema.optional(),
    schedule: z.object({ start: dateSchema.optional(), end: dateSchema.optional() }).strict().optional(),
    active: z.boolean().optional(),
    priority: z.enum(APPLE_WIN_BACK_PRIORITIES).optional(),
    promotionIntent: z.enum(APPLE_WIN_BACK_PROMOTION_INTENTS).optional(),
    autoRenewEnabled: z.boolean().optional(),
    prices: z.record(territorySchema, offerTerritoryPriceSchema),
    storeRefs: z.record(territorySchema, z.string().min(1)).optional(),
  })
  .strict();

export const appleOfferOpSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(APPLE_OFFER_OP_KINDS),
    platform: z.enum(['apple', 'google']),
    target: z
      .object({
        product: productRefSchema,
        offer: z.object({ kind: z.enum(APPLE_OFFER_KINDS), key: z.string().min(1).max(200) }).strict(),
      })
      .strict(),
    before: offerStateSchema.nullable(),
    after: offerStateSchema.nullable(),
    idempotencyKey: z.string().min(1),
    note: z.string().optional(),
    dependsOn: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

/** An offer op of either store, told apart by `platform` */
export const offerOpSchema = z.unknown().transform((value, ctx) => {
  const platform = value && typeof value === 'object' ? (value as { platform?: unknown }).platform : undefined;
  const schema = platform === 'google' ? playOfferOpSchema : appleOfferOpSchema;
  const result = schema.safeParse(value);
  if (result.success) return result.data as AnyOfferOp;
  for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path as Array<string | number> });
  return z.NEVER;
});

/** An offer state of either store (run logs) */
export const anyOfferStateSchema = z.union([offerStateSchema, playOfferStateSchema]);

export function isPlayOfferOp(op: AnyOfferOp): op is PlayOfferOp {
  return op.platform === 'google';
}

export function isAppleOfferOp(op: AnyOfferOp): op is OfferOp {
  return op.platform !== 'google';
}

export function isOfferOpKind(kind: string): kind is OfferOpKind {
  return (OFFER_OP_KINDS as readonly string[]).includes(kind) || (PLAY_OFFER_OP_KINDS as readonly string[]).includes(kind);
}

export function isOfferOp(op: { kind: string }): op is AnyOfferOp {
  return isOfferOpKind(op.kind);
}

/** Stable identity of an offer across a change set: product + offer kind + key */
export function offerTargetKey(op: Pick<AnyOfferOp, 'target'>): string {
  return `${productKey(op.target.product)}|${op.target.offer.kind}|${op.target.offer.key}`;
}

/**
 * Deterministic key for "this change": op kind, product, offer and a hash of
 * the end state (the deleted state for deleteOffer).
 */
export function computeOfferIdempotencyKey(op: Pick<OfferOp, 'kind' | 'target' | 'before' | 'after'> | Pick<PlayOfferOp, 'kind' | 'target' | 'before' | 'after'>): string {
  const subject = op.kind === 'deleteOffer' ? op.before : op.after;
  return [op.kind, offerTargetKey(op), fnv1a64(canonicalJson(subject ?? null))].join('|');
}

/**
 * Key of an Apple introductory offer: Apple keeps one resource per territory
 * with no name or code, so the offer is identified by its terms and start date.
 */
export function introOfferKey(terms: { mode: OfferMode; duration: OfferDuration; periods?: number; start?: string }): string {
  return ['intro', terms.mode, terms.duration, terms.periods ?? 1, terms.start ?? ''].join(':');
}

const KIND_LABEL: Record<AppleOfferKind, string> = {
  'apple.intro': 'introductory offer',
  'apple.promo': 'promotional offer',
  'apple.offerCode': 'offer code',
  'apple.winBack': 'win-back offer',
};

export function offerKindLabel(kind: OfferKind): string {
  return kind === 'play.offer' ? 'Play offer' : KIND_LABEL[kind];
}

export function describeOfferOp(op: AnyOfferOp): string {
  if (isPlayOfferOp(op)) return describePlayOfferOp(op);
  const what = `${KIND_LABEL[op.target.offer.kind]} "${op.target.offer.key}" on ${productKey(op.target.product)}`;
  const territories = Object.keys((op.after ?? op.before)?.prices ?? {}).length;
  return `${op.kind} ${what} (${territories} territories)`;
}

// ---------------------------------------------------------------------------
// Comparing offer states

/** Same store price: price point when both name one, else free flag, currency and amount */
export function sameOfferPrice(a: OfferTerritoryPrice | undefined, b: OfferTerritoryPrice | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (Boolean(a.free) !== Boolean(b.free)) return false;
  if (a.free && b.free) return a.currency === b.currency;
  if (a.pricePointId && b.pricePointId) return a.pricePointId === b.pricePointId;
  return a.currency === b.currency && compareDecimal(a.amount, b.amount) === 0;
}

export function sameTerms(a: Pick<OfferState, 'mode' | 'duration' | 'periods'>, b: Pick<OfferState, 'mode' | 'duration' | 'periods'>): boolean {
  return a.mode === b.mode && a.duration === b.duration && a.periods === b.periods;
}

/** Territories whose price differs between two price maps (either side missing counts) */
export function changedTerritories(a: Record<string, OfferTerritoryPrice>, b: Record<string, OfferTerritoryPrice>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((t) => !sameOfferPrice(a[t], b[t])).sort();
}

const endOf = (s: OfferState | null | undefined) => s?.schedule?.end ?? null;

/**
 * Does `observed` hold everything `expected` describes? Compares terms,
 * prices in every territory, the active flag (offer codes) and the end date
 * (intro and win-back). Names and eligibility are not compared: no op changes them.
 */
export function offerStateMatches(observed: OfferState, expected: OfferState): boolean {
  if (!sameTerms(observed, expected)) return false;
  if (changedTerritories(observed.prices, expected.prices).length > 0) return false;
  if (expected.active !== undefined && (observed.active ?? true) !== expected.active) return false;
  if ((expected.kind === 'apple.winBack' || expected.kind === 'apple.intro') && endOf(observed) !== endOf(expected)) return false;
  if (expected.kind === 'apple.winBack' && expected.schedule?.start && observed.schedule?.start !== expected.schedule.start) return false;
  return true;
}

/** The plan form of an offer read from the store; null when its mode or duration is unknown */
export function storeOfferToState(offer: StoreOffer): OfferState | null {
  if (!offer.mode || !offer.duration) return null;
  const status = offer.status ?? {};
  return {
    kind: offer.kind as AppleOfferKind,
    key: offer.key,
    ...(offer.name ? { name: offer.name } : {}),
    mode: offer.mode,
    duration: offer.duration,
    periods: offer.periods ?? 1,
    ...(offer.eligibility ? { eligibility: offer.eligibility } : {}),
    ...(offer.schedule ? { schedule: { ...offer.schedule } } : {}),
    ...(typeof status.active === 'boolean' ? { active: status.active } : {}),
    ...(status.priority === 'HIGH' || status.priority === 'NORMAL' ? { priority: status.priority } : {}),
    ...(status.promotionIntent === 'NOT_PROMOTED' || status.promotionIntent === 'USE_AUTO_GENERATED_ASSETS'
      ? { promotionIntent: status.promotionIntent }
      : {}),
    ...(typeof status.autoRenewEnabled === 'boolean' ? { autoRenewEnabled: status.autoRenewEnabled } : {}),
    prices: { ...offer.prices },
  };
}

// ---------------------------------------------------------------------------
// Introductory offer windows

/** [start, end) in YYYY-MM-DD; a missing start is "now", a missing end is open-ended */
export interface OfferWindow {
  start?: string;
  end?: string;
}

/**
 * Do two offer windows overlap? Dates are days; `end` is treated as the first
 * day the offer no longer runs (exclusive). A missing start means `today`.
 * Apple allows one introductory offer per territory at a time.
 */
export function windowsOverlap(a: OfferWindow, b: OfferWindow, today: string): boolean {
  const aStart = a.start ?? today;
  const bStart = b.start ?? today;
  const aEnd = a.end ?? '9999-12-31';
  const bEnd = b.end ?? '9999-12-31';
  return aStart < bEnd && bStart < aEnd;
}

/** One territory's introductory offer resource, as read */
export interface IntroTerritoryEntry {
  key: string;
  storeId?: string;
  price?: OfferTerritoryPrice;
  start?: string;
  end?: string;
  problem?: string;
}

/** Every introductory offer resource by territory (a territory can hold several windows) */
export function introEntriesByTerritory(offers: StoreOffer[]): Map<string, IntroTerritoryEntry[]> {
  const out = new Map<string, IntroTerritoryEntry[]>();
  for (const offer of offers) {
    if (offer.kind !== 'apple.intro') continue;
    const key = offer.mode && offer.duration ? introOfferKey({ mode: offer.mode, duration: offer.duration, periods: offer.periods, start: offer.schedule?.start }) : offer.key;
    const territories = new Set([...Object.keys(offer.prices), ...Object.keys(offer.territoryProblems ?? {})]);
    for (const t of territories) {
      const entry: IntroTerritoryEntry = {
        key,
        ...(offer.storeRefs?.[t] ? { storeId: offer.storeRefs[t] } : {}),
        ...(offer.prices[t] ? { price: offer.prices[t] } : {}),
        ...(offer.schedule?.start ? { start: offer.schedule.start } : {}),
        ...(offer.schedule?.end ? { end: offer.schedule.end } : {}),
        ...(offer.territoryProblems?.[t] ? { problem: offer.territoryProblems[t] } : {}),
      };
      out.set(t, [...(out.get(t) ?? []), entry]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification: compare an op with what the store holds now

export type OfferClassification =
  /** `found`: intro creates, the resource already in place in each done territory */
  | { kind: 'atTarget'; observed: AnyOfferState | null; found?: Record<string, string> }
  /** `pending`: intro territories still to write (all of them for other kinds); Play: ['activate'] when only the activation is left */
  | { kind: 'ready'; observed: AnyOfferState | null; pending?: string[]; offer?: StoreOffer; storeRefs?: Record<string, string>; found?: Record<string, string> }
  | { kind: 'drifted'; observed: AnyOfferState | null; message: string };

function locateKeyed(op: OfferOp, offers: StoreOffer[]): { offer?: StoreOffer; state: OfferState | null; problem?: string } {
  const { kind, key } = op.target.offer;
  const matches = offers.filter((o) => o.kind === kind && o.key === key);
  if (matches.length > 1) return { state: null, problem: `${matches.length} ${KIND_LABEL[kind]}s share the key "${key}"` };
  const offer = matches[0];
  if (!offer) return { state: null };
  const unreadable = [...(offer.problems ?? []), ...Object.entries(offer.territoryProblems ?? {}).map(([t, p]) => `${t}: ${p}`)];
  const state = storeOfferToState(offer);
  if (unreadable.length > 0 || !state) {
    return { offer, state, problem: `the ${KIND_LABEL[kind]} "${key}" can't be read unambiguously (${unreadable.slice(0, 3).join('; ') || 'unknown mode or duration'})` };
  }
  return { offer, state };
}

const NOTHING_SENT = 'Nothing was sent. Re-plan from the current offers.';

function classifyKeyed(op: OfferOp, offers: StoreOffer[]): OfferClassification {
  const { offer, state, problem } = locateKeyed(op, offers);
  if (problem) return { kind: 'drifted', observed: state, message: `${problem}. ${NOTHING_SENT}` };
  const label = `${KIND_LABEL[op.target.offer.kind]} "${op.target.offer.key}"`;

  if (op.after === null) {
    // deleteOffer
    if (!state) return { kind: 'atTarget', observed: null };
    if (op.before && offerStateMatches(state, op.before)) return { kind: 'ready', observed: state, offer };
    return { kind: 'drifted', observed: state, message: `The ${label} changed since the plan was made. ${NOTHING_SENT}` };
  }
  if (state && offerStateMatches(state, op.after)) return { kind: 'atTarget', observed: state };
  if (op.before === null) {
    if (!state) return { kind: 'ready', observed: null };
    return {
      kind: 'drifted',
      observed: state,
      message: `A ${label} already exists with other terms or prices. ${NOTHING_SENT}`,
    };
  }
  if (!state) return { kind: 'drifted', observed: null, message: `The ${label} no longer exists. ${NOTHING_SENT}` };
  if (offerStateMatches(state, op.before)) return { kind: 'ready', observed: state, offer };
  return { kind: 'drifted', observed: state, message: `The ${label} changed since the plan was made. ${NOTHING_SENT}` };
}

/** What a run already knows about an op: intro resources it created in earlier attempts */
export interface OfferOpHistory {
  createdIds?: Record<string, string>;
  /** Play creates: false when the run created the draft but its activation failed */
  activated?: boolean;
}

function classifyIntro(op: OfferOp, offers: StoreOffer[], today: string, history: OfferOpHistory = {}): OfferClassification {
  const byTerritory = introEntriesByTerritory(offers);
  const key = op.target.offer.key;
  const scope = op.kind === 'createOffer' ? op.after! : op.before!;
  const window = { start: scope.schedule?.start, end: op.after?.schedule?.end ?? op.before?.schedule?.end };
  const pending: string[] = [];
  const drift: string[] = [];
  const storeRefs: Record<string, string> = {};
  const found: Record<string, string> = {};
  const observedPrices: Record<string, OfferTerritoryPrice> = {};

  for (const territory of Object.keys(scope.prices).sort()) {
    const entries = byTerritory.get(territory) ?? [];
    // A known resource ID (from the plan, or created earlier in this run) identifies the offer exactly;
    // otherwise it is found by its terms and start date
    const knownId = scope.storeRefs?.[territory] ?? (op.kind === 'createOffer' ? history.createdIds?.[territory] : undefined);
    const mine = knownId ? entries.filter((e) => e.storeId === knownId) : entries.filter((e) => e.key === key);
    const others = entries.filter((e) => !mine.includes(e));
    const overlapping = others.find((e) => windowsOverlap({ start: e.start, end: e.end }, window, today));
    if (mine.length > 1) {
      drift.push(`${territory}: ${mine.length} introductory offers with these terms`);
      continue;
    }
    const entry = mine[0];
    if (entry?.problem) {
      drift.push(`${territory}: ${entry.problem}`);
      continue;
    }
    if (entry?.price) observedPrices[territory] = entry.price;
    if (entry?.storeId) storeRefs[territory] = entry.storeId;
    const end = entry?.end ?? null;

    switch (op.kind) {
      case 'createOffer': {
        const wanted = op.after!.prices[territory];
        if (!entry) {
          if (overlapping) drift.push(`${territory}: overlaps another introductory offer (${overlapping.key}${overlapping.end ? ` until ${overlapping.end}` : ''})`);
          else pending.push(territory);
        } else if (sameOfferPrice(entry.price, wanted) && end === endOf(op.after)) {
          // done
          if (entry.storeId) found[territory] = entry.storeId;
        } else {
          drift.push(`${territory}: an introductory offer with these terms already exists at another price or end date`);
        }
        break;
      }
      case 'deleteOffer':
        if (!entry) {
          // Gone is done only when nothing else could be this offer: without a resource ID, an
          // overlapping offer may be it with a start date App Store Connect filled in on read
          if (!knownId && overlapping) {
            drift.push(`${territory}: no introductory offer with these terms, but ${overlapping.key} overlaps; it may be this one with a start date App Store Connect filled in`);
          }
          break;
        }
        if (sameOfferPrice(entry.price, op.before!.prices[territory])) pending.push(territory);
        else drift.push(`${territory}: price changed since the plan was made`);
        break;
      default: {
        // deactivateOffer / activateOffer: move the end date from before's to after's
        if (!entry) drift.push(`${territory}: the introductory offer no longer exists${overlapping ? ` (${overlapping.key} overlaps)` : ''}`);
        else if (!sameOfferPrice(entry.price, op.before!.prices[territory])) drift.push(`${territory}: price changed since the plan was made`);
        else if (end === endOf(op.after)) {
          // done
        } else if (end === endOf(op.before)) pending.push(territory);
        else drift.push(`${territory}: end date is ${end ?? 'none'}, the plan expected ${endOf(op.before) ?? 'none'}`);
      }
    }
  }

  const observed: OfferState | null =
    Object.keys(observedPrices).length > 0 ? { ...scope, prices: observedPrices } : null;
  if (drift.length > 0) {
    const more = drift.length > 5 ? ` (and ${drift.length - 5} more)` : '';
    return { kind: 'drifted', observed, message: `${drift.slice(0, 5).join('; ')}${more}. ${NOTHING_SENT}` };
  }
  const foundPart = Object.keys(found).length > 0 ? { found } : {};
  if (pending.length === 0) return { kind: 'atTarget', observed, ...foundPart };
  return { kind: 'ready', observed, pending, storeRefs, ...foundPart };
}

/** Compare an offer op with the product's offers as read now. `today` is YYYY-MM-DD. */
export function classifyOfferOp(op: AnyOfferOp, offers: StoreOffer[], today: string, history: OfferOpHistory = {}): OfferClassification {
  if (isPlayOfferOp(op)) return classifyPlayOfferOp(op, offers);
  return op.target.offer.kind === 'apple.intro' ? classifyIntro(op, offers, today, history) : classifyKeyed(op, offers);
}

// ---------------------------------------------------------------------------
// Rules a valid offer op meets (on top of the schema)

const PRICE_IMMUTABLE: Partial<Record<AppleOfferKind, string>> = {
  'apple.intro': "Apple can't change an introductory offer's price; end or delete it and create a new one",
  'apple.offerCode': "Apple can't change an offer code's prices (its update takes only `active`); create a new offer code and deactivate this one",
  'apple.winBack': "Apple's win-back offer update has no prices; create a new win-back offer (new offer ID) and end or delete this one",
};

function checkState(where: string, state: OfferState, op: OfferOp, problems: string[]): void {
  if (state.kind !== op.target.offer.kind) problems.push(`${where}: offer kind ${state.kind} doesn't match the target (${op.target.offer.kind})`);
  if (state.key !== op.target.offer.key) problems.push(`${where}: offer key "${state.key}" doesn't match the target ("${op.target.offer.key}")`);
  if (state.mode !== 'PAY_AS_YOU_GO' && state.periods !== 1) problems.push(`${where}: periods must be 1 for ${state.mode}`);
  const territories = Object.keys(state.prices);
  if (territories.length === 0 && state.kind !== 'apple.intro') problems.push(`${where}: an offer needs at least one territory price`);
  for (const t of territories) {
    const p = state.prices[t];
    if (state.mode === 'FREE_TRIAL') {
      if (!p.free) problems.push(`${where}: ${t} must be free in a free trial`);
    } else if (p.free || !p.pricePointId) {
      problems.push(`${where}: ${t} must name an Apple price point (pricePointId)`);
    }
  }
  if (state.storeRefs) {
    if (state.kind !== 'apple.intro') problems.push(`${where}: storeRefs are for introductory offers only`);
    for (const t of Object.keys(state.storeRefs)) if (!state.prices[t]) problems.push(`${where}: storeRefs names ${t}, which has no price`);
  }
  if (state.kind === 'apple.intro' && state.key !== introOfferKey({ ...state, start: state.schedule?.start })) {
    problems.push(`${where}: an introductory offer's key must be "${introOfferKey({ ...state, start: state.schedule?.start })}"`);
  }
}

/** Problems with one offer op; empty means valid */
export function checkOfferOpRules(op: AnyOfferOp, appPlatform: Platform): string[] {
  if (isPlayOfferOp(op)) return checkPlayOfferOpRules(op, appPlatform);
  const where = `op ${op.id}`;
  const problems: string[] = [];
  const { product } = op.target;
  const kind = op.target.offer.kind;
  if (op.platform !== 'apple' || product.platform !== 'apple' || product.type !== 'subscription') {
    problems.push(`${where}: offer ops are Apple subscription ops in this version`);
  }
  if (appPlatform !== 'apple') problems.push(`${where}: Apple offer op in a change set for a ${appPlatform} app`);
  if (op.before) checkState(`${where} before`, op.before, op, problems);
  if (op.after) checkState(`${where} after`, op.after, op, problems);
  const label = KIND_LABEL[kind];

  switch (op.kind) {
    case 'createOffer':
      if (op.before !== null || op.after === null) problems.push(`${where}: createOffer goes from no offer (before: null) to an offer`);
      if (op.after && kind === 'apple.offerCode' && op.after.eligibility?.type !== 'apple.offerCode') {
        problems.push(`${where}: an offer code needs customer and offer eligibility`);
      }
      if (op.after && kind === 'apple.winBack') {
        if (op.after.eligibility?.type !== 'apple.winBack') problems.push(`${where}: a win-back offer needs its eligibility (paid duration, time since last subscribed)`);
        if (!op.after.schedule?.start) problems.push(`${where}: a win-back offer needs a start date`);
        if (!op.after.priority) problems.push(`${where}: a win-back offer needs a priority (HIGH or NORMAL)`);
      }
      if (op.after && kind === 'apple.intro' && Object.keys(op.after.prices).length === 0) problems.push(`${where}: an introductory offer needs at least one territory`);
      break;
    case 'updateOfferPrices':
      if (!op.before || !op.after) {
        problems.push(`${where}: updateOfferPrices needs before and after`);
        break;
      }
      if (kind !== 'apple.promo') problems.push(`${where}: ${PRICE_IMMUTABLE[kind] ?? `${label} prices can't be replaced`}`);
      if (!sameTerms(op.before, op.after)) {
        problems.push(`${where}: Apple doesn't allow changing a ${label}'s duration, mode or number of periods; create a new offer instead`);
      }
      for (const t of Object.keys(op.before.prices)) {
        if (!op.after.prices[t]) problems.push(`${where}: ${t} would lose its price; updateOfferPrices only changes or adds territories`);
      }
      if (changedTerritories(op.before.prices, op.after.prices).length === 0) problems.push(`${where}: no price changes`);
      break;
    case 'deactivateOffer':
    case 'activateOffer': {
      if (!op.before || !op.after) {
        problems.push(`${where}: ${op.kind} needs before and after`);
        break;
      }
      if (kind === 'apple.promo') {
        problems.push(`${where}: Apple promotional offers have no active switch or end date; stop presenting it in the app, or delete it`);
        break;
      }
      if (changedTerritories(op.before.prices, op.after.prices).length > 0 || !sameTerms(op.before, op.after)) {
        problems.push(`${where}: ${op.kind} changes only the active flag or end date`);
      }
      if (kind === 'apple.offerCode') {
        const want = op.kind === 'activateOffer';
        if (op.after.active !== want) problems.push(`${where}: ${op.kind} sets active to ${want}`);
      } else if (endOf(op.before) === endOf(op.after)) {
        problems.push(`${where}: ${op.kind} must change the end date`);
      } else if (op.kind === 'deactivateOffer' && !op.after.schedule?.end) {
        problems.push(`${where}: deactivating a ${label} sets an end date`);
      }
      break;
    }
    case 'deleteOffer':
      if (!op.before || op.after !== null) problems.push(`${where}: deleteOffer goes from an offer (before) to none (after: null)`);
      if (kind === 'apple.offerCode') problems.push(`${where}: App Store Connect's API can't delete an offer code; deactivate it instead`);
      break;
  }
  const expected = computeOfferIdempotencyKey(op);
  if (op.idempotencyKey !== expected) problems.push(`${where}: idempotencyKey doesn't match the op (expected "${expected}")`);
  return problems;
}

// ---------------------------------------------------------------------------
// Undo

export type OfferInverse = {
  op?: Omit<OfferOp, 'id'> | Omit<PlayOfferOp, 'id'>;
  /** What the inverse can't restore (e.g. codes already redeemed) */
  caveat?: string;
  /** Nothing can be done at all */
  notReversible?: string;
};

function makeInverse(op: OfferOp, kind: AppleOfferOpKind, before: OfferState | null, after: OfferState | null): Omit<OfferOp, 'id'> {
  const inverse: Omit<OfferOp, 'id' | 'idempotencyKey'> = { kind, platform: op.platform, target: op.target, before, after, note: `undo of ${op.id}` };
  return { ...inverse, idempotencyKey: computeOfferIdempotencyKey(inverse) };
}

/**
 * The op that restores what `op` changed, and what it can't restore.
 * `history.createdIds` (from the run log) limits undoing an intro create to
 * the resources the run created; without it no intro territory is deleted.
 */
export function invertOfferOp(op: AnyOfferOp, history: OfferOpHistory = {}): OfferInverse {
  if (isPlayOfferOp(op)) return invertPlayOfferOp(op, history);
  const kind = op.target.offer.kind;
  switch (op.kind) {
    case 'createOffer':
      if (kind === 'apple.intro') {
        const ids = history.createdIds ?? {};
        const created = Object.keys(op.after!.prices).filter((t) => ids[t]);
        const unknown = Object.keys(op.after!.prices).filter((t) => !ids[t]);
        const caveat = unknown.length
          ? `No created resource was recorded for ${unknown.join(', ')}; undo leaves those territories alone. If an introductory offer was created there, delete it in App Store Connect.`
          : undefined;
        if (created.length === 0) return { notReversible: caveat ?? 'Nothing was created' };
        const before: OfferState = {
          ...op.after!,
          prices: Object.fromEntries(created.map((t) => [t, op.after!.prices[t]])),
          storeRefs: Object.fromEntries(created.map((t) => [t, ids[t]])),
        };
        return {
          op: makeInverse(op, 'deleteOffer', before, null),
          caveat: [`Deleting the introductory offer needs force: App Store Connect's API doesn't report redemptions.`, caveat].filter(Boolean).join(' '),
        };
      }
      if (kind === 'apple.offerCode') {
        return {
          op: makeInverse(op, 'deactivateOffer', op.after, { ...op.after!, active: false }),
          caveat: "Apple's API can't delete an offer code, so undo deactivates it. Codes customers already redeemed keep their offer.",
        };
      }
      return {
        op: makeInverse(op, 'deleteOffer', op.after, null),
        caveat: `Deleting the ${KIND_LABEL[kind]} needs force: App Store Connect's API doesn't report redemptions. Customers who already redeemed it keep their offer.`,
      };
    case 'updateOfferPrices': {
      // Territories the update added can't be removed again by a price replace that only adds or changes
      const added = Object.keys(op.after!.prices).filter((t) => !op.before!.prices[t]);
      const restore = { ...op.before!, prices: { ...op.after!.prices, ...op.before!.prices } };
      if (changedTerritories(op.after!.prices, restore.prices).length === 0) {
        return { notReversible: `The update only added territories (${added.join(', ')}); a price replace can't remove them again.` };
      }
      return {
        op: makeInverse(op, 'updateOfferPrices', op.after, restore),
        ...(added.length ? { caveat: `Territories the update added (${added.join(', ')}) keep their new price.` } : {}),
      };
    }
    case 'deactivateOffer':
      return { op: makeInverse(op, 'activateOffer', op.after, op.before) };
    case 'activateOffer':
      return { op: makeInverse(op, 'deactivateOffer', op.after, op.before) };
    case 'deleteOffer':
      if (kind === 'apple.intro') return { op: makeInverse(op, 'createOffer', null, op.before) };
      return {
        op: makeInverse(op, 'createOffer', null, op.before),
        caveat: `Undo re-creates the ${KIND_LABEL[kind]} as a new offer with the same key. Apple may refuse to reuse the key of a deleted offer (unconfirmed), and redemption history isn't restored.`,
      };
  }
}
