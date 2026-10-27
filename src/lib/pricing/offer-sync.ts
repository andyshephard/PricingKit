// The sync engine: keep offers priced "X% of each territory's own price" in
// step with base prices. Pure: callers (the Apple adapter, tests, the CLI)
// pass in what they read.
//
// Stores don't record an offer's pricing rule, so rules live in a file the
// repo checks in (`pricingkit.offerRules`). From it:
//   - planOfferSync re-derives every offer with `syncWithBase: true` against
//     the base prices a plan will set (or today's, on demand) and adds
//     `updateOfferPrices` ops to the same plan, after the base-price ops they
//     depend on (`dependsOn`). Offers the store can't re-price (offer codes,
//     win-back and introductory offers) are listed as manual actions with the
//     reason; the planner never deletes or re-creates an offer.
//   - checkRulesDrift checks every offer in the file against its rule and
//     returns one combined report.
//
// Scheduled base prices (Apple, a future startDate): an offer price change
// takes effect as soon as it is applied, so re-deriving an offer against a
// base price that starts later would price it against a base that doesn't
// apply yet. By default ('hold') those territories keep their offer price,
// with a BASE_SCHEDULED manual action naming them ("sync again on or after
// the date"), while the offer's other territories are re-priced now;
// 'deriveNow' re-derives them all, with a warning.

import { z } from 'zod';
import {
  basePriceOps,
  CHANGESET_KIND,
  CHANGESET_SCHEMA_VERSION,
  changeSetHash,
  checkChangeSetRules,
  ChangeSetValidationError,
  type BasePriceOp,
  type ChangeOp,
  type ChangeSet,
  type ManualAction,
  type ManualActionCode,
  type PlanSkip,
} from './changeset';
import { compareDecimal, isDecimalString, normalizeDecimal, type Decimal } from './decimal';
import { productKey, type AppRef, type ProductPriceState, type ProductRef } from './model';
import {
  checkOfferDrift,
  defaultOfferBasis,
  deriveOfferPrices,
  OfferRuleError,
  type OfferDerivation,
  type OfferDriftReport,
  type OfferPreviewRow,
  type PriceLadder,
} from './offer-derivation';
import { changedTerritories, computeOfferIdempotencyKey, isOfferOp, offerKindLabel, storeOfferToState, type OfferOp, type OfferState } from './offer-ops';
import {
  OFFER_KINDS,
  parsePercentOfCurrentRule,
  type AppleOfferKind,
  type BillingPeriod,
  type OfferKind,
  type OfferTerritoryPrice,
  type PercentOfCurrentRule,
  type StoreOffer,
} from './offers';
import { appRefSchema, productRefSchema } from './refs';
import type { SnapMode } from './snap';
import type { PlayOfferPreview, PlayPreviewRow } from './play-offer-plan';
import type { PlayOfferDriftReport } from './play-offer-sync';

// ---------------------------------------------------------------------------
// The rules file

export const OFFER_RULES_KIND = 'pricingkit.offerRules' as const;
export const OFFER_RULES_SCHEMA_VERSION = 1 as const;

/** percentOfCurrent without a basis takes the offer's default (pay up front: totalOverDuration; else perPeriod) */
export interface OfferRulePricing {
  type: 'percentOfCurrent';
  percent: Decimal;
  basis?: PercentOfCurrentRule['basis'];
  snap: SnapMode;
}

/**
 * Google Play rules: percentOfCurrent (written as fixed prices, re-derived
 * when base prices change), fixed prices, or Play's native discounts. A
 * relative discount follows the base price by itself; an absolute discount
 * keeps the same amount off it.
 */
export type PlayRulePricing =
  | OfferRulePricing
  | { type: 'fixed'; prices: Record<string, Decimal> }
  | { type: 'play.relativeDiscount'; fraction: Decimal }
  | { type: 'play.absoluteDiscount'; amounts: Record<string, Decimal> };

/** One existing offer and the rule its prices follow */
export interface OfferRule {
  /** The offer's product (Apple: the subscription, by numeric ID; Play: the base plan) */
  product: ProductRef;
  kind: OfferKind;
  /** The offer's key as `pricingkit offers` lists it (promo offer code, offer code name, win-back offer ID, intro key, Play offer ID) or its store ID */
  key: string;
  /** App Store offers: percentOfCurrent only. Play offers: any PlayRulePricing. */
  pricing: OfferRulePricing | PlayRulePricing;
  /** Play offers with two phases: which phase (1 or 2) the rule prices. Default: the offer's only priced phase. */
  phase?: number;
  /** Territories the rule covers (default: all of the offer's) */
  territories?: 'all' | string[];
  /** Re-derive the offer when base prices change. false: drift checks it, sync leaves it alone. */
  syncWithBase: boolean;
  /** Flag a snapped price further than this fraction from its target (default "0.05") */
  deviationThreshold?: Decimal;
  description?: string;
}

export interface OfferRules {
  kind: typeof OFFER_RULES_KIND;
  schemaVersion: typeof OFFER_RULES_SCHEMA_VERSION;
  app: AppRef;
  description?: string;
  offers: OfferRule[];
}

const decimalSchema = z
  .string()
  .refine((v) => isDecimalString(v), { message: 'must be a plain decimal string such as "50"' })
  .transform((v) => normalizeDecimal(v));
const territorySchema = z.string().regex(/^[A-Z]{2}$/, 'territory must be ISO 3166-1 alpha-2, e.g. "GB"');

const offerRuleSchema = z
  .object({
    product: productRefSchema,
    kind: z.enum(OFFER_KINDS),
    key: z.string().min(1).max(200),
    pricing: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('percentOfCurrent'),
          percent: decimalSchema,
          basis: z.enum(['perPeriod', 'totalOverDuration']).optional(),
          snap: z.enum(['nearest', 'floor', 'ceil']),
        })
        .strict(),
      z.object({ type: z.literal('fixed'), prices: z.record(territorySchema, decimalSchema) }).strict(),
      z.object({ type: z.literal('play.relativeDiscount'), fraction: decimalSchema }).strict(),
      z.object({ type: z.literal('play.absoluteDiscount'), amounts: z.record(territorySchema, decimalSchema) }).strict(),
    ]),
    phase: z.number().int().min(1).max(2).optional(),
    territories: z.union([z.literal('all'), z.array(territorySchema).min(1)]).optional(),
    syncWithBase: z.boolean(),
    deviationThreshold: decimalSchema.optional(),
    description: z.string().optional(),
  })
  .strict();

const offerRulesSchema = z
  .object({
    kind: z.literal(OFFER_RULES_KIND),
    schemaVersion: z.literal(OFFER_RULES_SCHEMA_VERSION),
    app: appRefSchema,
    description: z.string().optional(),
    offers: z.array(offerRuleSchema).min(1),
  })
  .strict();

export class InvalidOfferRulesError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid offer rules file:\n- ${problems.join('\n- ')}`);
    this.name = 'InvalidOfferRulesError';
  }
}

/**
 * Validate an offer rules file (JSON text or object). Besides the schema:
 * offers of the app's store only (Apple subscription offers for a bundleId,
 * play.offer on base plans for a packageName), each offer listed once, and a
 * valid rule (App Store: percent-of-current only).
 */
export function parseOfferRules(input: string | unknown): OfferRules {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      // JSON.parse messages quote the input; never pass them on
      throw new InvalidOfferRulesError(['not valid JSON']);
    }
  }
  const parsed = offerRulesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidOfferRulesError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const rules = parsed.data as OfferRules;
  const problems: string[] = [];
  const play = 'packageName' in rules.app;
  const seen = new Map<string, number>();
  rules.offers.forEach((rule, i) => {
    const where = `offers.${i}`;
    if (play) {
      if (rule.kind !== 'play.offer') problems.push(`${where}: a Google Play app (packageName) has play.offer rules only`);
      if (rule.product.platform !== 'google' || rule.product.type !== 'subscription') problems.push(`${where}: a Play offer's product is its base plan: { "platform": "google", "type": "subscription", "productId", "basePlanId" }`);
    } else {
      if (rule.kind === 'play.offer' || rule.product.platform !== 'apple') problems.push(`${where}: an App Store app (bundleId) has Apple offer rules only`);
      else if (rule.product.type !== 'subscription') problems.push(`${where}: offers belong to subscriptions; product.type must be "subscription"`);
      if (rule.pricing.type !== 'percentOfCurrent') problems.push(`${where}.pricing: App Store offer rules are percentOfCurrent (${rule.pricing.type} is Play-only)`);
      if (rule.phase !== undefined) problems.push(`${where}.phase: phases are Play-only`);
    }
    const pricing = rule.pricing;
    if (pricing.type === 'percentOfCurrent') {
      try {
        parsePercentOfCurrentRule({ ...pricing, basis: pricing.basis ?? 'perPeriod' });
      } catch (error) {
        problems.push(...((error as { problems?: string[] }).problems ?? [(error as Error).message]).map((p) => `${where}.pricing: ${p}`));
      }
    } else if (pricing.type === 'play.relativeDiscount') {
      if (compareDecimal(pricing.fraction, '0') <= 0 || compareDecimal(pricing.fraction, '1') >= 0) problems.push(`${where}.pricing.fraction: the share taken off, above 0 and below 1 ("0.5" = 50% off)`);
    } else {
      const amounts = pricing.type === 'fixed' ? pricing.prices : pricing.amounts;
      if (Object.keys(amounts).length === 0) problems.push(`${where}.pricing: list at least one region`);
      for (const [region, amount] of Object.entries(amounts)) if (compareDecimal(amount, '0') <= 0) problems.push(`${where}.pricing: ${region} must be above 0`);
    }
    if (rule.deviationThreshold !== undefined && (compareDecimal(rule.deviationThreshold, '0') < 0 || compareDecimal(rule.deviationThreshold, '1') > 0)) {
      problems.push(`${where}.deviationThreshold: must be a fraction from 0 to 1, e.g. "0.05"`);
    }
    if (Array.isArray(rule.territories) && new Set(rule.territories).size !== rule.territories.length) {
      problems.push(`${where}.territories: lists a territory twice`);
    }
    const id = `${productKey(rule.product)}|${rule.kind}|${rule.key}`;
    if (seen.has(id)) problems.push(`${where}: the same offer is also offers.${seen.get(id)}; list each offer once`);
    else seen.set(id, i);
  });
  if (problems.length) throw new InvalidOfferRulesError(problems);
  return rules;
}

/** The products a rules file names, each once, in order */
export function ruleProducts(rules: Pick<OfferRules, 'offers'>): ProductRef[] {
  const out = new Map<string, ProductRef>();
  for (const rule of rules.offers) if (!out.has(productKey(rule.product))) out.set(productKey(rule.product), rule.product);
  return [...out.values()];
}

/** The offer a rule names: by key (or store ID) and kind. Several matches are ambiguous. */
export function findRuleOffer(rule: Pick<OfferRule, 'kind' | 'key'>, offers: StoreOffer[]): StoreOffer[] {
  return offers.filter((o) => o.kind === rule.kind && (o.key === rule.key || o.storeId === rule.key));
}

/** The complete rule for an offer: a missing basis follows the offer's mode */
export function resolveOfferRule(pricing: OfferRulePricing | PlayRulePricing, offer: Pick<StoreOffer, 'mode'>): PercentOfCurrentRule {
  if (pricing.type !== 'percentOfCurrent') throw new OfferRuleError(`${pricing.type} rules are Play-only`);
  return { type: 'percentOfCurrent', percent: pricing.percent, basis: pricing.basis ?? defaultOfferBasis(offer.mode), snap: pricing.snap };
}

// ---------------------------------------------------------------------------
// Base prices a plan will set

/**
 * How a sync treats base prices a plan schedules for a later date (Apple):
 * hold      - default. Those territories keep their offer price and get a
 *             BASE_SCHEDULED manual action (sync again on or after the
 *             date); the offer's other territories are re-priced now, the op
 *             depending only on the immediate (setPrice) base ops.
 * deriveNow - re-derive against the scheduled price now. The offer's new
 *             prices apply as soon as the plan is applied, before the base
 *             price changes (a warning says so).
 */
export type ScheduledBasePolicy = 'hold' | 'deriveNow';

/**
 * The product's base prices once `ops` are applied: each setPrice op's
 * `after` becomes the territory's current price, and so does each
 * schedulePrice op's under 'deriveNow'. Other products' ops are ignored.
 */
export function projectBasePrices(state: ProductPriceState, ops: BasePriceOp[], policy: ScheduledBasePolicy = 'hold'): ProductPriceState {
  const out = structuredClone(state);
  const key = productKey(state.product);
  for (const op of ops) {
    if (productKey(op.target.product) !== key || !op.after) continue;
    if (op.kind !== 'setPrice' && !(op.kind === 'schedulePrice' && policy === 'deriveNow')) continue;
    const { territory } = op.target;
    const price = { ...op.after };
    delete price.startDate;
    const current = (out.territories[territory] ??= { territory, currency: price.currency, current: null });
    current.current = price;
    current.currency = price.currency;
    if (current.problems?.current) {
      delete current.problems.current;
      if (!current.problems.scheduled) delete current.problems;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sync planning

/** What the planner needs to know about one product */
export interface OfferSyncProduct {
  product: ProductRef;
  billingPeriod: BillingPeriod;
  /** Current base prices, as read */
  base: ProductPriceState;
  /** Valid price points per alpha-2 territory */
  ladders: Record<string, PriceLadder>;
  /** The product's offers (at least every kind the rules name) */
  offers: StoreOffer[];
  /**
   * Territories whose price points were read, when only some were (adapters
   * read them only for offers a rule can price). A drift check reports a
   * territory outside it where the offer has no price as missing, not as
   * unresolved for lack of price points.
   */
  ladderTerritories?: string[];
}

export interface PlanOfferSyncInput {
  app: AppRef;
  rules: OfferRule[];
  products: OfferSyncProduct[];
  /** A base-price plan to ship with: offers are re-derived against its target prices and its ops go first */
  base?: ChangeSet;
  /** Default 'hold' */
  scheduledBase?: ScheduledBasePolicy;
  id?: string;
  createdAt?: string;
  description?: string;
}

export interface OfferSyncEntry {
  product: ProductRef;
  kind: OfferKind;
  key: string;
  name?: string;
  /**
   * updatePrices - the plan re-prices the offer (opId)
   * none         - its prices already match the rule
   * manual       - see `manual`
   * notSynced    - syncWithBase is false: drift checks it, sync leaves it alone
   * followsBase  - Play relative discount: the offer follows the base price by itself
   */
  action: 'updatePrices' | 'none' | 'manual' | 'notSynced' | 'followsBase';
  opId?: string;
  /** The base prices the offer was derived against: the plan's targets, or today's prices */
  pricedAgainst: 'planTargets' | 'currentPrices';
  rule?: PercentOfCurrentRule;
  /** Play offers: the rule, the phase it prices and the per-region preview */
  play?: { rule: PlayRulePricing; phase: number; rows: PlayPreviewRow[]; changes: PlayOfferPreview['changes'] };
  derivation?: OfferDerivation;
  /** Territories whose offer price the plan changes */
  changes: Array<{ territory: string; before: OfferTerritoryPrice | null; after: OfferTerritoryPrice }>;
  /** Base-price ops the offer op waits for */
  dependsOn?: string[];
  manual?: ManualAction;
  warnings: string[];
}

export interface OfferSyncPlan {
  /** Base-price ops (if any) first, then the offer ops */
  changeSet: ChangeSet;
  /** changeSetHash(changeSet): what an apply must confirm */
  hash: string;
  entries: OfferSyncEntry[];
  manualActions: ManualAction[];
}

const HOW_TO_REPRICE: Partial<Record<AppleOfferKind, string>> = {
  'apple.offerCode': "Apple can't change an offer code's prices: create a new offer code at the new prices and deactivate this one",
  'apple.winBack': "Apple's win-back offer update has no prices: create a new win-back offer (new offer ID) at the new prices and end or delete this one",
  'apple.intro': "Apple can't change an introductory offer's price: end it and create a new one at the new prices",
};

function skipReason(row: OfferPreviewRow): PlanSkip['reason'] {
  const codes = row.flags.filter((f) => f.severity === 'error').map((f) => f.code);
  if (codes.includes('NO_CURRENT_PRICE')) return 'NOT_CONFIGURED';
  if (codes.includes('CURRENT_PRICE_UNREADABLE')) return 'AMBIGUOUS_STATE';
  if (codes.includes('CURRENCY_MISMATCH')) return 'CURRENCY_MISMATCH';
  if (codes.includes('NO_PRICE_POINT') || codes.includes('NO_PRICE_LADDER')) return 'UNRESOLVED_PRICE_POINT';
  return 'INVALID_TARGET';
}

const earliest = (dates: string[]) => [...dates].sort()[0];
const listOf = (items: string[], max = 8) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

/**
 * Re-derive every `syncWithBase` offer in `rules` and plan the price updates
 * the store allows. With `base`, offers are derived against the base prices
 * that plan sets, and the result is one plan: the base ops (unchanged, same
 * IDs) followed by the offer ops, each naming the base ops of its product it
 * depends on. Sync only re-prices territories the offer already has, and a
 * territory the rule can't price keeps its current offer price (listed in
 * `skipped`).
 */
export function planOfferSync(input: PlanOfferSyncInput): OfferSyncPlan {
  const policy = input.scheduledBase ?? 'hold';
  const base = input.base;
  if (base) {
    if (canonicalApp(base.app) !== canonicalApp(input.app)) throw new ChangeSetValidationError(['the base-price plan is for another app than the rules']);
    if (base.ops.some(isOfferOp)) throw new ChangeSetValidationError(['the base-price plan already has offer ops; plan the sync from a base-price plan only']);
  }
  const baseOps = base ? basePriceOps(base) : [];
  const products = new Map(input.products.map((p) => [productKey(p.product), p]));
  const usedIds = new Set(base?.ops.map((op) => op.id) ?? []);
  let next = (base?.ops.length ?? 0) + 1;
  const newId = () => {
    let id: string;
    do id = `op-${String(next++).padStart(4, '0')}`;
    while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  const entries: OfferSyncEntry[] = [];
  const manualActions: ManualAction[] = [];
  const offerOps: OfferOp[] = [];
  const skipped: PlanSkip[] = [];
  const warnings: Array<{ opId: string; message: string }> = [];

  for (const rule of input.rules) {
    const pk = productKey(rule.product);
    const entry: OfferSyncEntry = { product: rule.product, kind: rule.kind, key: rule.key, action: 'none', pricedAgainst: 'currentPrices', changes: [], warnings: [] };
    entries.push(entry);
    const label = rule.kind === 'play.offer' ? 'Play offer' : offerKindLabel(rule.kind);
    const manual = (code: ManualActionCode, message: string, territories?: string[]) => {
      const action: ManualAction = { product: rule.product, offer: { kind: rule.kind, key: rule.key }, code, message, ...(territories?.length ? { territories } : {}) };
      entry.action = 'manual';
      entry.manual = action;
      manualActions.push(action);
    };

    if (!rule.syncWithBase) {
      entry.action = 'notSynced';
      continue;
    }
    const data = products.get(pk);
    if (!data) throw new Error(`planOfferSync: no state was passed for ${pk}`);
    const matches = findRuleOffer(rule, data.offers);
    if (matches.length === 0) {
      manual('OFFER_NOT_FOUND', `${pk} has no ${label} "${rule.key}". Sync never creates offers: create it with an offer plan spec, or fix the key in the rules file.`);
      continue;
    }
    if (matches.length > 1) {
      manual('OFFER_UNREADABLE', `${matches.length} ${label}s on ${pk} match "${rule.key}"; name the offer by its store ID in the rules file.`);
      continue;
    }
    const offer = matches[0];
    if (offer.name) entry.name = offer.name;
    const state = storeOfferToState(offer);
    const unreadable = [...(offer.problems ?? []), ...Object.entries(offer.territoryProblems ?? {}).map(([t, p]) => `${t}: ${p}`)];
    if (!state || unreadable.length > 0) {
      manual('OFFER_UNREADABLE', `The ${label} "${rule.key}" can't be read unambiguously (${listOf(unreadable, 3) || 'unknown mode or duration'}); nothing is re-derived from a guess.`);
      continue;
    }
    if (state.mode === 'FREE_TRIAL') {
      manual('RULE_NOT_APPLICABLE', `The ${label} "${rule.key}" is a free trial; it has no price to keep in step. Remove it from the rules file.`);
      continue;
    }
    const resolved = resolveOfferRule(rule.pricing, state);
    entry.rule = resolved;

    // Sync keeps the offer's own territories in step; it doesn't add territories (drift lists them as missing)
    const offerTerritories = Object.keys(state.prices).sort();
    const wanted = rule.territories === undefined || rule.territories === 'all' ? offerTerritories : [...rule.territories].sort();
    const scope = wanted.filter((t) => state.prices[t]);
    const notInOffer = wanted.filter((t) => !state.prices[t]);
    if (notInOffer.length > 0 && rule.territories !== undefined && rule.territories !== 'all') {
      entry.warnings.push(`${listOf(notInOffer)} ${notInOffer.length === 1 ? 'has' : 'have'} no offer price; sync doesn't add territories (create them with an offer plan).`);
    }

    const productOps = baseOps.filter((op) => productKey(op.target.product) === pk && scope.includes(op.target.territory));
    const scheduledOps = productOps.filter((op) => op.kind === 'schedulePrice' && op.after?.startDate);
    // Under 'hold', territories whose base price the plan schedules for later keep their offer
    // price; the rest (immediate base changes, or none) are re-derived now
    let deriveScope = scope;
    if (scheduledOps.length > 0 && policy === 'hold') {
      const held = [...new Set(scheduledOps.map((op) => op.target.territory))].sort();
      const dates = [...new Set(scheduledOps.map((op) => op.after!.startDate!))].sort();
      deriveScope = scope.filter((t) => !held.includes(t));
      manual(
        'BASE_SCHEDULED',
        `The plan schedules new base prices for ${held.length} of this offer's territories (${listOf(held)}) from ${listOf(dates, 3)}. Offer prices change as soon as they are applied, so those territories keep their current offer price${deriveScope.length > 0 ? ' (the others are re-priced in this plan)' : ''}. Sync again on or after ${earliest(dates)} (the drift check flags the offer then), or plan with scheduled base prices derived now (CLI: --scheduled-base now) to change them immediately.`,
        held
      );
      if (deriveScope.length === 0) continue;
      entry.warnings.push(`${listOf(held)} ${held.length === 1 ? 'keeps its' : 'keep their'} offer price: the plan schedules ${held.length === 1 ? 'its' : 'their'} base price from ${earliest(dates)}; sync again then.`);
    }
    const used = productOps.filter(
      (op) => deriveScope.includes(op.target.territory) && (op.kind === 'setPrice' || (op.kind === 'schedulePrice' && policy === 'deriveNow'))
    );
    if (used.length > 0) entry.pricedAgainst = 'planTargets';
    const projected = projectBasePrices(data.base, used, policy);

    let derivation: OfferDerivation;
    try {
      derivation = deriveOfferPrices({
        rule: resolved,
        offer: { mode: state.mode, duration: state.duration },
        billingPeriod: data.billingPeriod,
        base: projected,
        ladders: data.ladders,
        territories: deriveScope,
        ...(rule.deviationThreshold ? { deviationThreshold: rule.deviationThreshold } : {}),
      });
    } catch (error) {
      if (!(error instanceof OfferRuleError)) throw error;
      manual('RULE_NOT_APPLICABLE', `The rule can't price the ${label} "${rule.key}": ${error.message}`);
      continue;
    }
    entry.derivation = derivation;

    const derived: Record<string, OfferTerritoryPrice> = {};
    for (const row of derivation.rows) {
      for (const f of row.flags) if (f.severity === 'warning') entry.warnings.push(`${row.territory}: ${f.message}`);
      if (!row.ok || row.snappedPrice === null || !row.pricePointId) {
        const detail = row.flags.filter((f) => f.severity === 'error').map((f) => f.message).join('; ') || `${row.snappedPrice} ${row.currency} has no price point ID`;
        skipped.push({ product: rule.product, territory: row.territory, offerKey: rule.key, reason: row.ok ? 'UNRESOLVED_PRICE_POINT' : skipReason(row), detail: `${detail} (the offer keeps its current price here)` });
        continue;
      }
      derived[row.territory] = {
        currency: row.currency,
        amount: row.snappedPrice,
        pricePointId: row.pricePointId,
        ...(row.proceeds ? { proceeds: row.proceeds } : {}),
      };
    }

    // Base prices already scheduled in the store (not replaced by this plan) will move under the offer later
    const replaced = new Set(productOps.filter((op) => op.kind === 'schedulePrice' || op.kind === 'deleteScheduled').map((op) => op.target.territory));
    const storeScheduled = deriveScope.filter((t) => data.base.territories[t]?.scheduled && !replaced.has(t));
    if (storeScheduled.length > 0) {
      const dates = storeScheduled.map((t) => data.base.territories[t]!.scheduled!.startDate ?? '').filter(Boolean);
      entry.warnings.push(
        `${storeScheduled.length} of this offer's territories already have a scheduled base price${dates.length ? ` (from ${earliest(dates)})` : ''} (${listOf(storeScheduled)}). The offer is priced against today's base price there and will drift when the scheduled price takes effect; sync again then.`
      );
    }
    if (policy === 'deriveNow' && scheduledOps.length > 0) {
      const dates = [...new Set(scheduledOps.map((op) => op.after!.startDate!))].sort();
      entry.warnings.push(
        `Priced against base prices scheduled from ${listOf(dates, 3)} (${listOf(scheduledOps.map((op) => op.target.territory).sort())}). The offer's new prices apply as soon as this plan is applied, before the base prices change.`
      );
    }

    const after: OfferState = { ...state, prices: { ...state.prices, ...derived } };
    const changed = changedTerritories(state.prices, after.prices);
    if (changed.length === 0) {
      entry.action = entry.manual ? 'manual' : 'none';
      for (const t of Object.keys(derived).sort()) skipped.push({ product: rule.product, territory: t, offerKey: rule.key, reason: 'ALREADY_AT_TARGET' });
      continue;
    }
    entry.changes = changed.map((t) => ({ territory: t, before: state.prices[t] ?? null, after: after.prices[t] }));
    if (rule.kind !== 'apple.promo') {
      manual(
        'PRICES_IMMUTABLE',
        `${changed.length} territories of the ${label} "${rule.key}" no longer match the rule (${listOf(changed)}). ${HOW_TO_REPRICE[rule.kind as AppleOfferKind] ?? 'The store can\'t re-price this offer'}. PricingKit never deletes or re-creates an offer by itself.`,
        changed
      );
      continue;
    }

    const id = newId();
    const dependsOn = used.map((op) => op.id).sort();
    const op: Omit<OfferOp, 'idempotencyKey'> = {
      id,
      kind: 'updateOfferPrices',
      platform: 'apple',
      target: { product: rule.product, offer: { kind: 'apple.promo', key: state.key } },
      before: state,
      after,
      note:
        entry.pricedAgainst === 'planTargets'
          ? `sync: ${resolved.percent}% of the base prices this plan sets (${dependsOn.length} base-price ops)`
          : `sync: ${resolved.percent}% of current base prices`,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    };
    offerOps.push({ ...op, idempotencyKey: computeOfferIdempotencyKey(op) });
    entry.action = 'updatePrices';
    entry.opId = id;
    if (dependsOn.length > 0) entry.dependsOn = dependsOn;
    for (const message of entry.warnings) warnings.push({ opId: id, message });
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const ops: ChangeOp[] = [...(base?.ops ?? []), ...offerOps];
  const allSkipped = [...(base?.skipped ?? []), ...skipped];
  const allWarnings = [...(base?.warnings ?? []), ...warnings];
  const description = input.description ?? base?.description;
  const changeSet: ChangeSet = {
    schemaVersion: CHANGESET_SCHEMA_VERSION,
    kind: CHANGESET_KIND,
    id: input.id ?? `sync-${createdAt.replace(/[^0-9]/g, '').slice(0, 14)}-${changeSetHash({ app: input.app, ops }).slice(0, 8)}`,
    createdAt,
    ...(description ? { description } : {}),
    app: input.app,
    ops,
    ...(allSkipped.length > 0 ? { skipped: allSkipped } : {}),
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    ...(manualActions.length > 0 ? { manualActions } : {}),
  };
  const problems = checkChangeSetRules(changeSet);
  if (problems.length > 0) throw new ChangeSetValidationError(problems);
  return { changeSet, hash: changeSetHash(changeSet), entries, manualActions };
}

function canonicalApp(app: AppRef): string {
  return 'bundleId' in app ? `apple:${app.bundleId}` : `google:${app.packageName}`;
}

// ---------------------------------------------------------------------------
// Drift across every offer in a rules file

export const RULES_DRIFT_KIND = 'pricingkit.rulesDrift' as const;
export const RULES_DRIFT_SCHEMA_VERSION = 1 as const;

export interface RulesDriftEntry {
  product: ProductRef;
  kind: OfferKind;
  key: string;
  syncWithBase: boolean;
  /**
   * inSync   - every checked territory matches
   * drifted  - the offer's report is out of sync (see `report`)
   * notFound - the product has no such offer
   * error    - the rule can't be checked against this offer (`error`)
   */
  status: 'inSync' | 'drifted' | 'notFound' | 'error';
  report?: OfferDriftReport | PlayOfferDriftReport;
  error?: { message: string; code: string };
}

export interface RulesDriftReport {
  kind: typeof RULES_DRIFT_KIND;
  schemaVersion: typeof RULES_DRIFT_SCHEMA_VERSION;
  checkedAt: string;
  app: AppRef;
  /** True when every offer in the rules file is in sync */
  inSync: boolean;
  summary: { offers: number; inSync: number; drifted: number; notFound: number; errors: number };
  offers: RulesDriftEntry[];
  /** What this report doesn't cover */
  notChecked?: string[];
}

export interface RulesDriftInput {
  app: AppRef;
  rules: OfferRule[];
  products: OfferSyncProduct[];
  /** ISO timestamp (tests) */
  now?: string;
}

/**
 * Check every offer in a rules file against its rule and today's base
 * prices. One entry per rule, each with its pricingkit.offerDrift report.
 * A rule that can't apply to its offer (a free trial, weeks against months)
 * is an `error` entry, not a thrown error, so the other offers are still
 * reported.
 */
export function checkRulesDrift(input: RulesDriftInput): RulesDriftReport {
  const checkedAt = input.now ?? new Date().toISOString();
  const products = new Map(input.products.map((p) => [productKey(p.product), p]));
  const offers: RulesDriftEntry[] = input.rules.map((rule) => {
    const head = { product: rule.product, kind: rule.kind, key: rule.key, syncWithBase: rule.syncWithBase };
    const data = products.get(productKey(rule.product));
    if (!data) throw new Error(`checkRulesDrift: no state was passed for ${productKey(rule.product)}`);
    const matches = findRuleOffer(rule, data.offers);
    if (matches.length === 0) return { ...head, status: 'notFound' as const };
    if (matches.length > 1) {
      return { ...head, status: 'error' as const, error: { code: 'AMBIGUOUS_OFFER', message: `${matches.length} offers match "${rule.key}"; name it by its store ID` } };
    }
    const offer = matches[0];
    try {
      const report = checkOfferDrift({
        rule: resolveOfferRule(rule.pricing, offer),
        offer,
        billingPeriod: data.billingPeriod,
        base: data.base,
        ladders: data.ladders,
        ...(rule.territories && rule.territories !== 'all' ? { territories: rule.territories } : {}),
        ...(rule.deviationThreshold ? { deviationThreshold: rule.deviationThreshold } : {}),
        now: checkedAt,
      });
      if (data.ladderTerritories) {
        const read = new Set(data.ladderTerritories);
        for (const entry of report.territories) {
          // Only "no price points" (they weren't read), not e.g. a territory without a base price
          if (entry.status !== 'unresolved' || entry.actual || read.has(entry.territory) || entry.reason !== `No price points for ${entry.territory}`) continue;
          entry.status = 'missing';
          entry.reason = 'The offer has no price in this territory';
          report.summary.unresolved--;
          report.summary.missing++;
        }
      }
      return { ...head, status: report.inSync ? ('inSync' as const) : ('drifted' as const), report };
    } catch (error) {
      if (!(error instanceof OfferRuleError)) throw error;
      return { ...head, status: 'error' as const, error: { code: 'OFFER_RULE', message: error.message } };
    }
  });
  const count = (status: RulesDriftEntry['status']) => offers.filter((o) => o.status === status).length;
  return {
    kind: RULES_DRIFT_KIND,
    schemaVersion: RULES_DRIFT_SCHEMA_VERSION,
    checkedAt,
    app: input.app,
    inSync: offers.every((o) => o.status === 'inSync'),
    summary: { offers: offers.length, inSync: count('inSync'), drifted: count('drifted'), notFound: count('notFound'), errors: count('error') },
    offers,
  };
}
