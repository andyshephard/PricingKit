// Sync and drift for Google Play offers, from the same rules file as App
// Store offers (`pricingkit.offerRules`, for a packageName app). Pure: the
// Play adapter reads the base plans, their offers and Play's prices for
// percent-of-current targets, and passes them in.
//
// What a base price change does to each kind of Play rule:
//   play.relativeDiscount - nothing: Play applies the fraction to whatever the
//                           base price is, so the offer follows it by itself
//                           ("follows base automatically"). Drift checks only
//                           that every region still has that fraction.
//   play.absoluteDiscount - the offer keeps the same amount off the new base
//                           price. Drift checks the amounts; sync re-writes
//                           them only if they differ from the rule, and flags
//                           regions where the amount is no longer below the
//                           base price.
//   fixed                 - fixed offer prices: drift checks them; sync
//                           re-writes them if they differ and flags regions
//                           where the price is no longer below the base.
//   percentOfCurrent      - absolute prices derived from the base price, so
//                           they drift when it changes: sync re-derives them
//                           against the new base (Play's own price for each
//                           target) and re-writes the phase prices.

import {
  basePriceOps,
  CHANGESET_KIND,
  CHANGESET_SCHEMA_VERSION,
  changeSetHash,
  checkChangeSetRules,
  ChangeSetValidationError,
  type ChangeOp,
  type ChangeSet,
  type ManualAction,
  type ManualActionCode,
  type PlanSkip,
} from './changeset';
import type { Decimal } from './decimal';
import { productKey, type AppRef, type ProductPriceState, type ProductRef } from './model';
import type { OfferDriftStatus } from './offer-derivation';
import { isOfferOp } from './offer-ops';
import type { StoreOffer } from './offers';
import {
  derivePlayPhasePrices,
  playPercentTargets,
  playPricingProblem,
  type PlayPhasePricing,
} from './play-offer-plan';
import {
  changedPlayRegions,
  computePlayOfferIdempotencyKey,
  describePlayPhase,
  describePlayTargeting,
  samePhaseRegionPrice,
  storeOfferProblems,
  type PlayOfferOp,
  type PlayOfferState,
  type PlayPhaseRegionPrice,
} from './play-offers';
import { projectBasePrices, type OfferRule, type OfferSyncEntry, type OfferSyncPlan, type PlayRulePricing, type RulesDriftEntry, type RulesDriftReport } from './offer-sync';

export const PLAY_OFFER_DRIFT_KIND = 'pricingkit.playOfferDrift' as const;
export const PLAY_OFFER_DRIFT_SCHEMA_VERSION = 1 as const;

/** What sync and drift need about one base plan */
export interface PlayRuleProduct {
  product: ProductRef;
  /** The base plan's billing period (ISO 8601) */
  billingPeriod: string;
  /** Current base prices */
  base: ProductPriceState;
  /** The base plan's offers */
  offers: StoreOffer[];
}

/** Play's prices for a percentOfCurrent rule's targets, keyed by playRuleKey(rule) */
export type PlayRuleSnaps = Record<string, { resolved: Record<string, { currency: string; amount: Decimal }>; unresolved: Record<string, string> }>;

export function playRuleKey(rule: Pick<OfferRule, 'product' | 'key'>): string {
  return `${productKey(rule.product)}|${rule.key}`;
}

export interface PlayOfferDriftEntry {
  territory: string;
  status: OfferDriftStatus;
  /** The phase's price config as Play has it */
  actual?: PlayPhaseRegionPrice;
  /** What the rule gives */
  expected?: PlayPhaseRegionPrice;
  basePrice?: Decimal;
  /** What the rule's price comes to per recurrence (an estimate for discounts) */
  offerPrice?: Decimal;
  reason?: string;
}

export interface PlayOfferDriftReport {
  kind: typeof PLAY_OFFER_DRIFT_KIND;
  schemaVersion: typeof PLAY_OFFER_DRIFT_SCHEMA_VERSION;
  checkedAt: string;
  offer: {
    kind: 'play.offer';
    key: string;
    storeId: string;
    state: PlayOfferState['state'];
    eligibility: string;
    tags: string[];
    phases: string[];
  };
  rule: PlayRulePricing;
  /** 1-based phase the rule prices */
  phase: number;
  billingPeriod: string;
  /** Relative discounts follow the base price by themselves: no sync needed when in sync */
  followsBase: boolean;
  inSync: boolean;
  summary: Record<OfferDriftStatus, number>;
  territories: PlayOfferDriftEntry[];
  outOfScope?: string[];
  problems?: string[];
  warnings?: Array<{ territory: string; message: string }>;
}

/** The rule as derivation pricing: percentOfCurrent keeps an optional basis (Play default: prorated over the phase) */
function pricingOf(rule: OfferRule): PlayPhasePricing {
  return rule.pricing as PlayPhasePricing;
}

/** Which phase (0-based) a rule prices: `phase`, or the offer's only phase that isn't free */
export function playRulePhase(rule: Pick<OfferRule, 'phase'>, offer: PlayOfferState): { index: number } | { error: string } {
  if (rule.phase !== undefined) {
    if (rule.phase > offer.phases.length) return { error: `the rule prices phase ${rule.phase}, but the offer has ${offer.phases.length}` };
    const phase = offer.phases[rule.phase - 1];
    if (Object.values(phase.regions).every((p) => p.type === 'free')) return { error: `phase ${rule.phase} is free; it has no price to keep in step` };
    return { index: rule.phase - 1 };
  }
  const priced = offer.phases.map((p, i) => ({ p, i })).filter(({ p }) => !Object.values(p.regions).every((x) => x.type === 'free'));
  if (priced.length === 0) return { error: 'the offer is free (a free trial); it has no price to keep in step' };
  if (priced.length > 1) return { error: 'the offer has two priced phases; say which one the rule prices with "phase": 1 or 2' };
  return { index: priced[0].i };
}

/** The offer a rule names: by offer ID or store ID, on the rule's base plan */
export function findPlayRuleOffer(rule: Pick<OfferRule, 'key' | 'product'>, offers: StoreOffer[]): StoreOffer[] {
  const p = rule.product;
  return offers.filter(
    (o) =>
      o.kind === 'play.offer' &&
      (o.key === rule.key || o.storeId === rule.key) &&
      (!o.play || p.platform !== 'google' || p.type !== 'subscription' || (o.play.productId === p.productId && o.play.basePlanId === p.basePlanId))
  );
}

/** The regions a rule covers: drift - the rule's list, or every base plan region; sync - the offer's regions (within the list) */
function ruleScope(rule: OfferRule, offer: PlayOfferState, purpose: 'sync' | 'drift'): 'all' | string[] {
  const list = rule.territories && rule.territories !== 'all' ? rule.territories : undefined;
  const own = Object.keys(offer.regions).sort();
  if (purpose === 'sync') return list ? own.filter((r) => list.includes(r)) : own;
  return list ?? 'all';
}

export type PlayRuleTarget = { rule: OfferRule; base: ProductPriceState; targets: Record<string, { currency: string; amount: Decimal }> };

/**
 * The exact targets the adapter has to turn into Play prices for each
 * percentOfCurrent rule, against `bases` (the plan's projected base prices
 * for sync; today's for drift). Rules that can't price their offer are
 * left out (the planner reports them).
 */
export function playRuleTargets(rules: OfferRule[], products: PlayRuleProduct[], purpose: 'sync' | 'drift', bases?: Map<string, ProductPriceState>): PlayRuleTarget[] {
  const out: PlayRuleTarget[] = [];
  for (const rule of rules) {
    if (rule.kind !== 'play.offer' || rule.pricing.type !== 'percentOfCurrent') continue;
    if (purpose === 'sync' && !rule.syncWithBase) continue;
    const data = products.find((p) => productKey(p.product) === productKey(rule.product));
    if (!data) continue;
    const matches = findPlayRuleOffer(rule, data.offers);
    const offer = matches.length === 1 && storeOfferProblems(matches[0]).length === 0 ? matches[0].play?.offer : undefined;
    if (!offer) continue;
    const phase = playRulePhase(rule, offer);
    if ('error' in phase) continue;
    const base = bases?.get(productKey(rule.product)) ?? data.base;
    const targets = playPercentTargets({ pricing: pricingOf(rule), phase: offer.phases[phase.index], billingPeriod: data.billingPeriod, base, territories: ruleScope(rule, offer, purpose) });
    if (Object.keys(targets).length > 0) out.push({ rule, base, targets });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drift

function emptySummary(): Record<OfferDriftStatus, number> {
  return { match: 0, mismatch: 0, missing: 0, extra: 0, unresolved: 0, unreadable: 0 };
}

function checkPlayRule(rule: OfferRule, data: PlayRuleProduct, snaps: PlayRuleSnaps, checkedAt: string): RulesDriftEntry {
  const head = { product: rule.product, kind: rule.kind, key: rule.key, syncWithBase: rule.syncWithBase };
  const matches = findPlayRuleOffer(rule, data.offers);
  if (matches.length === 0) return { ...head, status: 'notFound' };
  if (matches.length > 1) return { ...head, status: 'error', error: { code: 'AMBIGUOUS_OFFER', message: `${matches.length} offers match "${rule.key}"` } };
  const store = matches[0];
  const offer = store.play?.offer;
  if (!offer) return { ...head, status: 'error', error: { code: 'OFFER_UNREADABLE', message: `The Play offer "${rule.key}" has no readable details` } };
  const phase = playRulePhase(rule, offer);
  if ('error' in phase) return { ...head, status: 'error', error: { code: 'OFFER_RULE', message: `The rule can't check the Play offer "${rule.key}": ${phase.error}` } };
  const pricing = pricingOf(rule);
  const problem = playPricingProblem(pricing, offer.phases[phase.index], data.billingPeriod);
  if (problem) return { ...head, status: 'error', error: { code: 'OFFER_RULE', message: problem } };

  const scope = ruleScope(rule, offer, 'drift');
  const rows = derivePlayPhasePrices({
    pricing,
    phase: offer.phases[phase.index],
    billingPeriod: data.billingPeriod,
    base: data.base,
    territories: scope,
    ...(snaps[playRuleKey(rule)] ? { snapped: snaps[playRuleKey(rule)] } : {}),
    ...(rule.deviationThreshold ? { deviationThreshold: rule.deviationThreshold } : {}),
  });
  const actualPhase = offer.phases[phase.index];
  const entries: PlayOfferDriftEntry[] = [];
  const warnings: Array<{ territory: string; message: string }> = [];
  const covered = new Set<string>();
  for (const row of rows) {
    covered.add(row.region);
    for (const f of row.flags) if (f.severity === 'warning') warnings.push({ territory: row.region, message: f.message });
    const actual = actualPhase.regions[row.region];
    const unreadable = store.territoryProblems?.[row.region];
    const extras = { ...(row.basePrice ? { basePrice: row.basePrice } : {}), ...(row.offerPrice ? { offerPrice: row.offerPrice } : {}) };
    if (unreadable) entries.push({ territory: row.region, status: 'unreadable', reason: unreadable });
    else if (!row.ok || !row.config) {
      entries.push({ territory: row.region, status: 'unresolved', ...(actual ? { actual } : {}), ...extras, reason: row.flags.filter((f) => f.severity === 'error').map((f) => f.message).join('; ') });
    } else if (!actual) entries.push({ territory: row.region, status: 'missing', expected: row.config, ...extras, reason: 'The offer has no price in this region' });
    else if (samePhaseRegionPrice(actual, row.config)) entries.push({ territory: row.region, status: 'match', actual, expected: row.config, ...extras });
    else entries.push({ territory: row.region, status: 'mismatch', actual, expected: row.config, ...extras, reason: `Offer has ${describe(actual)}, rule gives ${describe(row.config)}` });
  }
  const scoped = scope !== 'all';
  const outOfScope: string[] = [];
  for (const region of Object.keys(offer.regions).sort()) {
    if (covered.has(region)) continue;
    if (scoped) outOfScope.push(region);
    else entries.push({ territory: region, status: 'extra', ...(actualPhase.regions[region] ? { actual: actualPhase.regions[region] } : {}), reason: 'The offer has a price in a region the rule does not cover' });
  }
  entries.sort((a, b) => a.territory.localeCompare(b.territory));
  const summary = emptySummary();
  for (const e of entries) summary[e.status]++;
  const problems = store.problems ?? [];
  const report: PlayOfferDriftReport = {
    kind: PLAY_OFFER_DRIFT_KIND,
    schemaVersion: PLAY_OFFER_DRIFT_SCHEMA_VERSION,
    checkedAt,
    offer: {
      kind: 'play.offer',
      key: offer.key,
      storeId: store.storeId,
      state: offer.state,
      eligibility: describePlayTargeting(offer.targeting),
      tags: offer.tags,
      phases: offer.phases.map(describePlayPhase),
    },
    rule: rule.pricing,
    phase: phase.index + 1,
    billingPeriod: data.billingPeriod,
    followsBase: rule.pricing.type === 'play.relativeDiscount',
    inSync: entries.length > 0 && entries.every((e) => e.status === 'match') && problems.length === 0,
    summary,
    territories: entries,
    ...(scoped ? { outOfScope } : {}),
    ...(problems.length ? { problems: [...problems] } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
  return { ...head, status: report.inSync ? 'inSync' : 'drifted', report };
}

function describe(price: PlayPhaseRegionPrice): string {
  switch (price.type) {
    case 'free':
      return 'free';
    case 'relativeDiscount':
      return `relative discount ${price.fraction}`;
    case 'absoluteDiscount':
      return `${price.amount} ${price.currency} off`;
    default:
      return `${price.amount} ${price.currency}`;
  }
}

export interface PlayRulesDriftInput {
  app: AppRef;
  rules: OfferRule[];
  products: PlayRuleProduct[];
  /** Play's prices for percentOfCurrent targets against today's base prices */
  snaps?: PlayRuleSnaps;
  now?: string;
}

/** Check every Play offer in a rules file against its rule; one pricingkit.rulesDrift report */
export function checkPlayRulesDrift(input: PlayRulesDriftInput): RulesDriftReport {
  const checkedAt = input.now ?? new Date().toISOString();
  const offers = input.rules.map((rule) => {
    const data = input.products.find((p) => productKey(p.product) === productKey(rule.product));
    if (!data) throw new Error(`checkPlayRulesDrift: no state was passed for ${productKey(rule.product)}`);
    return checkPlayRule(rule, data, input.snaps ?? {}, checkedAt);
  });
  const count = (status: RulesDriftEntry['status']) => offers.filter((o) => o.status === status).length;
  return {
    kind: 'pricingkit.rulesDrift',
    schemaVersion: 1,
    checkedAt,
    app: input.app,
    inSync: offers.every((o) => o.status === 'inSync'),
    summary: { offers: offers.length, inSync: count('inSync'), drifted: count('drifted'), notFound: count('notFound'), errors: count('error') },
    offers,
  };
}

// ---------------------------------------------------------------------------
// Sync

export interface PlanPlayOfferSyncInput {
  app: AppRef;
  rules: OfferRule[];
  products: PlayRuleProduct[];
  /** Play's prices for percentOfCurrent targets against the projected base prices (playRuleTargets with the same base) */
  snaps?: PlayRuleSnaps;
  /** regionsVersion.version for the patches */
  regionsVersion?: string;
  /** A base-price plan to ship with: offers are re-derived against its target prices and its ops go first */
  base?: ChangeSet;
  id?: string;
  createdAt?: string;
  description?: string;
}

/** Base prices of each product once the plan's setPrice ops are applied (Play has no scheduled prices) */
export function projectedPlayBases(products: PlayRuleProduct[], base?: ChangeSet): Map<string, ProductPriceState> {
  const ops = base ? basePriceOps(base) : [];
  return new Map(products.map((p) => [productKey(p.product), projectBasePrices(p.base, ops)]));
}

const listOf = (items: string[], max = 8) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

/**
 * Re-derive every `syncWithBase` Play offer in `rules` and plan the phase
 * price patches that bring it back in step. With `base`, offers are derived
 * against the base prices that plan sets, and the result is one plan: the
 * base ops (same IDs) first, then the offer ops, each depending on its base
 * plan's base ops. Sync only re-prices regions the offer already has.
 */
export function planPlayOfferSync(input: PlanPlayOfferSyncInput): OfferSyncPlan {
  const base = input.base;
  if (base) {
    const appKey = (a: AppRef) => ('bundleId' in a ? `apple:${a.bundleId}` : `google:${a.packageName}`);
    if (appKey(base.app) !== appKey(input.app)) throw new ChangeSetValidationError(['the base-price plan is for another app than the rules']);
    if (base.ops.some(isOfferOp)) throw new ChangeSetValidationError(['the base-price plan already has offer ops; plan the sync from a base-price plan only']);
  }
  const baseOps = base ? basePriceOps(base) : [];
  const projected = projectedPlayBases(input.products, base);
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
  const offerOps: PlayOfferOp[] = [];
  const skipped: PlanSkip[] = [];
  const warnings: Array<{ opId: string; message: string }> = [];

  for (const rule of input.rules) {
    const pk = productKey(rule.product);
    const entry: OfferSyncEntry = { product: rule.product, kind: rule.kind, key: rule.key, action: 'none', pricedAgainst: 'currentPrices', changes: [], warnings: [] };
    entries.push(entry);
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
    const data = input.products.find((p) => productKey(p.product) === pk);
    if (!data) throw new Error(`planPlayOfferSync: no state was passed for ${pk}`);
    const matches = findPlayRuleOffer(rule, data.offers);
    if (matches.length === 0) {
      manual('OFFER_NOT_FOUND', `${pk} has no Play offer "${rule.key}". Sync never creates offers: create it with an offer plan spec, or fix the key in the rules file.`);
      continue;
    }
    if (matches.length > 1) {
      manual('OFFER_UNREADABLE', `${matches.length} Play offers on ${pk} match "${rule.key}".`);
      continue;
    }
    const store = matches[0];
    const state = store.play?.offer;
    const unreadable = storeOfferProblems(store);
    if (!state || unreadable.length > 0) {
      manual('OFFER_UNREADABLE', `The Play offer "${rule.key}" can't be read unambiguously (${listOf(unreadable, 3) || 'no offer details'}); nothing is re-derived from a guess.`);
      continue;
    }
    const phase = playRulePhase(rule, state);
    if ('error' in phase) {
      manual('RULE_NOT_APPLICABLE', `The rule can't price the Play offer "${rule.key}": ${phase.error}.`);
      continue;
    }
    const pricing = pricingOf(rule);
    const problem = playPricingProblem(pricing, state.phases[phase.index], data.billingPeriod);
    if (problem) {
      manual('RULE_NOT_APPLICABLE', `The rule can't price the Play offer "${rule.key}": ${problem}`);
      continue;
    }

    const scope = ruleScope(rule, state, 'sync') as string[];
    const used = baseOps.filter((op) => productKey(op.target.product) === pk && op.kind === 'setPrice' && scope.includes(op.target.territory));
    if (used.length > 0) entry.pricedAgainst = 'planTargets';
    const rows = derivePlayPhasePrices({
      pricing,
      phase: state.phases[phase.index],
      billingPeriod: data.billingPeriod,
      base: projected.get(pk) ?? data.base,
      territories: scope,
      ...(input.snaps?.[playRuleKey(rule)] ? { snapped: input.snaps[playRuleKey(rule)] } : {}),
      ...(rule.deviationThreshold ? { deviationThreshold: rule.deviationThreshold } : {}),
    });
    const derived: Record<string, PlayPhaseRegionPrice> = {};
    const tooLarge: string[] = [];
    for (const row of rows) {
      for (const f of row.flags) if (f.severity === 'warning') entry.warnings.push(`${row.region}: ${f.message}`);
      if (!row.ok || !row.config) {
        // A discount the new base price no longer covers needs a decision, not a silent skip
        if (row.flags.some((f) => f.code === 'DISCOUNT_TOO_LARGE')) {
          tooLarge.push(row.region);
          continue;
        }
        const detail = row.flags.filter((f) => f.severity === 'error').map((f) => f.message).join('; ');
        const reason: PlanSkip['reason'] = row.flags.some((f) => f.code === 'NO_CURRENT_PRICE')
          ? 'NOT_CONFIGURED'
          : row.flags.some((f) => f.code === 'NO_PLAY_PRICE')
            ? 'UNRESOLVED_PRICE_POINT'
            : row.flags.some((f) => f.code === 'DEVIATION_ABOVE_THRESHOLD')
              ? 'DEVIATION_ABOVE_THRESHOLD'
              : 'INVALID_TARGET';
        skipped.push({ product: rule.product, territory: row.region, offerKey: rule.key, reason, detail: `${detail} (the offer keeps its current price here)` });
        continue;
      }
      derived[row.region] = row.config;
    }
    if (tooLarge.length > 0) {
      manual(
        'RULE_NOT_APPLICABLE',
        `The amount off of the Play offer "${rule.key}" is no longer below the base price over the phase in ${listOf(tooLarge)}. Lower the discount for ${tooLarge.length === 1 ? 'that region' : 'those regions'} in the rules file (and the offer), or raise the base price; this plan leaves ${tooLarge.length === 1 ? 'it' : 'them'} as they are.`,
        tooLarge
      );
    }
    const after: PlayOfferState = {
      ...state,
      phases: state.phases.map((p, i) => (i === phase.index ? { ...p, regions: { ...p.regions, ...derived } } : p)),
    };
    const changed = changedPlayRegions(state, after);
    entry.play = {
      rule: rule.pricing,
      phase: phase.index + 1,
      rows,
      changes: changed.map((region) => ({ region, phase: phase.index + 1, before: state.phases[phase.index].regions[region] ?? null, after: after.phases[phase.index].regions[region] ?? null })),
    };
    if (changed.length === 0) {
      if (entry.manual) continue;
      entry.action = rule.pricing.type === 'play.relativeDiscount' ? 'followsBase' : 'none';
      if (rule.pricing.type === 'play.absoluteDiscount' && used.length > 0) entry.warnings.push('The offer keeps the same amount off the new base prices; Play works the new offer prices out itself.');
      for (const t of Object.keys(derived).sort()) skipped.push({ product: rule.product, territory: t, offerKey: rule.key, reason: 'ALREADY_AT_TARGET' });
      continue;
    }
    if (!input.regionsVersion) throw new Error('planPlayOfferSync: a regionsVersion is needed to patch Play offers');
    const id = newId();
    const dependsOn = used.map((op) => op.id).sort();
    const op: Omit<PlayOfferOp, 'idempotencyKey'> = {
      id,
      kind: 'updateOfferPrices',
      platform: 'google',
      target: { product: rule.product, offer: { kind: 'play.offer', key: state.key } },
      before: state,
      after,
      regionsVersion: input.regionsVersion,
      note:
        rule.pricing.type === 'percentOfCurrent'
          ? entry.pricedAgainst === 'planTargets'
            ? `sync: ${rule.pricing.percent}% of the base prices this plan sets (${dependsOn.length} base-price ops)`
            : `sync: ${rule.pricing.percent}% of current base prices`
          : `sync: back to the rule (${rule.pricing.type})`,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    };
    offerOps.push({ ...op, idempotencyKey: computePlayOfferIdempotencyKey(op) });
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
    // The base plan's planner notes (existing subscribers, proceeds, reference data) carry over
    ...(base?.priceChanges?.length ? { priceChanges: base.priceChanges } : {}),
    ...(base?.dataFreshness?.length ? { dataFreshness: base.dataFreshness } : {}),
  };
  const problems = checkChangeSetRules(changeSet);
  if (problems.length > 0) throw new ChangeSetValidationError(problems);
  return { changeSet, hash: changeSetHash(changeSet), entries, manualActions };
}

