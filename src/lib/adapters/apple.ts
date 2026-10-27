// AppleAdapter: App Store Connect behind the core's PlatformAdapter interface.
//
// Phase 1 covers subscription base prices (current and scheduled). Phase 2a
// adds subscription offer reads, previews and drift checks; Phase 2b plans
// and applies offer ops (create, re-price, end, delete). In-app purchase
// prices come later; the adapter refuses them clearly.

import {
  decimalEquals,
  describePrice,
  invertOp,
  normalizeStartDate,
  samePrice,
  isDecimalString,
  normalizeDecimal,
  snapToPricePoints,
  type ApplyContext,
  type BasePriceOp,
  type OpResponse,
  type PriceValue,
  type PlatformAdapter,
  type ProductPriceState,
  type ProductRef,
  type ResolveResult,
  type ResolveTarget,
  type SnapMode,
  type TerritoryPriceState,
  appleSubscriptionPeriodToIso,
  assertDerivableOffer,
  checkOfferDrift,
  defaultOfferBasis,
  OfferRuleError,
  deriveOfferPrices,
  type AppleOfferKind,
  type BillingPeriod,
  type Decimal,
  type OfferDerivation,
  type OfferDriftReport,
  type OfferDuration,
  type OfferMode,
  type OfferTerritoryPrice,
  type PercentOfCurrentRule,
  type PriceLadder,
  type StoreOffer,
  offerKindLabel,
  planOfferChanges,
  planOfferLifecycle,
  sameOfferPrice,
  type AppRef,
  type OfferApplyContext,
  type OfferLifecycleInput,
  type OfferOp,
  type AnyOfferOp,
  type OfferState,
  isPlayOfferOp,
  type OfferPlan,
  type OfferPlanInput,
  type OfferSpec,
  checkRulesDrift,
  findRuleOffer,
  planOfferSync,
  productKey,
  ruleProducts,
  type ChangeSet,
  type OfferRules,
  type OfferSyncPlan,
  type OfferSyncProduct,
  type RulesDriftReport,
  type ScheduledBasePolicy,
} from '@/lib/pricing';
import { getSubscriptionOffer, listSubscriptionOffers, listSubscriptionOffersOfKind } from '@/lib/apple-connect/offers';
import {
  createIntroductoryOffer,
  createOfferCode,
  createPromotionalOffer,
  createWinBackOffer,
  deleteIntroductoryOffer,
  deletePromotionalOffer,
  deleteWinBackOffer,
  isoToAppleOfferDuration,
  replacePromotionalOfferPrices,
  setIntroductoryOfferEndDate,
  setOfferCodeActive,
  updateWinBackOffer,
  type OfferPriceInput,
} from '@/lib/apple-connect/offer-writes';
import { AppleApiError } from '@/lib/apple-connect/client';
import { SubscriptionOwnership } from '@/lib/apple-connect/ownership';
import { getSubscriptionById } from '@/lib/apple-connect/subscriptions';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';
import { deleteSubscriptionPrice, updateSubscriptionPrice } from '@/lib/apple-connect/subscriptions';
import {
  getSubscriptionPricePointEqualizations,
  listSubscriptionPriceEntries,
  listSubscriptionPricePointsByTerritory,
  type SubscriptionPriceEntry,
  type TerritoryPricePoint,
} from '@/lib/apple-connect/price-points';
import { alpha2ToAlpha3, alpha3ToAlpha2 } from '@/lib/apple-connect/territories';
import { getBaseTerritoryForProduct, getInAppPurchase, listInAppPurchasePriceEntries, type InAppPurchasePriceEntry } from '@/lib/apple-connect/products';
import { ApiError, getErrorStatus, toApiError } from '@/lib/utils/api-error';
import { isBudgetExceeded, type RequestBudget } from '@/lib/utils/request-budget';

export interface AppleAdapterOptions {
  credentials: AppleConnectCredentials;
  /** Every request the adapter sends is charged here */
  budget?: RequestBudget;
  /** Clock for telling current from scheduled prices (tests) */
  now?: () => Date;
}

function unsupported(message: string): ApiError {
  return new ApiError(message, { status: 422, code: 'UNSUPPORTED_OPERATION', platform: 'apple', retryable: false });
}

function subscriptionId(product: ProductRef): string {
  if (product.platform !== 'apple' || product.type !== 'subscription') {
    throw unsupported('The Apple adapter handles subscription base prices only (in-app purchases come in a later phase)');
  }
  return product.id;
}

function toAlpha2(territory: string): string | undefined {
  return territory.length === 3 ? alpha3ToAlpha2(territory) ?? undefined : territory;
}

export class AppleAdapter implements PlatformAdapter {
  readonly platform = 'apple' as const;
  private readonly credentials: AppleConnectCredentials;
  private readonly budget?: RequestBudget;
  private readonly now?: () => Date;
  private readonly ownership: SubscriptionOwnership;

  constructor(options: AppleAdapterOptions) {
    this.credentials = options.credentials;
    this.budget = options.budget;
    this.now = options.now;
    this.ownership = new SubscriptionOwnership(this.credentials, this.credentials.bundleId, { budget: this.budget });
  }

  /**
   * Throws APP_MISMATCH unless the subscription belongs to the adapter's app
   * (credentials.bundleId). API keys reach every app of a team, so a
   * subscription ID from another app would otherwise be written to.
   * Checked once per subscription per adapter.
   */
  async verifyProduct(product: ProductRef): Promise<void> {
    await this.ownership.assert(subscriptionId(product));
  }

  private get ctx() {
    return { budget: this.budget };
  }

  async fetchState(product: ProductRef): Promise<ProductPriceState> {
    const id = subscriptionId(product);
    const entries = await listSubscriptionPriceEntries(this.credentials, id, this.ctx);
    const today = (this.now?.() ?? new Date()).toISOString().slice(0, 10);
    const territories: Record<string, TerritoryPriceState> = {};
    const warnings: string[] = [];

    // Group by territory; entries Apple returned without a territory can't be placed at all
    const byTerritory = new Map<string, SubscriptionPriceEntry[]>();
    for (const entry of entries) {
      if (!entry.territory) {
        warnings.push(entry.problem ?? `price ${entry.subscriptionPriceId} has no territory`);
        continue;
      }
      byTerritory.set(entry.territory, [...(byTerritory.get(entry.territory) ?? []), entry]);
    }

    for (const [territory, list] of byTerritory) {
      const future = list.filter((e) => e.startDate !== null && normalizeStartDate(e.startDate) > today);
      const active = list.filter((e) => !future.includes(e));
      const state: TerritoryPriceState = { territory, currency: list.find((e) => e.currency)?.currency ?? '', current: null };
      const problems: { current?: string; scheduled?: string } = {};

      // Current: the active entry with the latest start date (no start date = oldest)
      const key = (e: SubscriptionPriceEntry) => (e.startDate ? normalizeStartDate(e.startDate) : '');
      const latest = active.reduce<string | undefined>((max, e) => (max === undefined || key(e) > max ? key(e) : max), undefined);
      const currentCandidates = active.filter((e) => key(e) === latest);
      if (currentCandidates.length > 1) {
        problems.current = `${currentCandidates.length} prices share the latest start date`;
      } else if (currentCandidates.length === 1) {
        const entry = currentCandidates[0];
        if (entry.problem || !entry.pricePoint || !entry.currency || !isDecimalString(entry.pricePoint.customerPrice)) {
          problems.current = entry.problem ?? `unreadable price ${entry.subscriptionPriceId}`;
        } else {
          state.current = {
            currency: entry.currency,
            amount: normalizeDecimal(entry.pricePoint.customerPrice),
            pricePointId: entry.pricePoint.id,
            ...(isDecimalString(entry.pricePoint.proceeds) ? { proceeds: normalizeDecimal(entry.pricePoint.proceeds) } : {}),
          };
        }
      }

      // Scheduled: Apple keeps one future price per territory. More than one
      // (a create that took effect after an error, or a run stopped between
      // create and delete) is reported, never resolved by picking one.
      if (future.length > 1) {
        problems.scheduled = `${future.length} future prices (${future.map((e) => `${e.pricePoint?.customerPrice ?? '?'} from ${e.startDate}`).join(', ')})`;
      } else if (future.length === 1) {
        const entry = future[0];
        if (entry.problem || !entry.pricePoint || !entry.currency || !isDecimalString(entry.pricePoint.customerPrice)) {
          problems.scheduled = entry.problem ?? `unreadable price ${entry.subscriptionPriceId}`;
        } else {
          state.scheduled = {
            currency: entry.currency,
            amount: normalizeDecimal(entry.pricePoint.customerPrice),
            pricePointId: entry.pricePoint.id,
            startDate: normalizeStartDate(entry.startDate!),
            ...(isDecimalString(entry.pricePoint.proceeds) ? { proceeds: normalizeDecimal(entry.pricePoint.proceeds) } : {}),
          };
          state.refs = { scheduledPriceId: entry.subscriptionPriceId };
        }
      }

      if (problems.current || problems.scheduled) {
        state.problems = problems;
        for (const [slot, message] of Object.entries(problems)) warnings.push(`${territory} ${slot}: ${message}`);
      }
      territories[territory] = state;
    }

    return {
      product,
      capturedAt: new Date().toISOString(),
      territories,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * Current and scheduled prices of one of this app's in-app purchases,
   * found by its product ID among the app's own in-app purchases (so an ID
   * from another app is "not found"). Read only, for export: plans and
   * apply still handle subscriptions only. Manual and automatic prices are
   * both read; an expired entry (end date passed) is ignored, two prices
   * active at once or two future prices in a territory are a problem, never
   * a pick.
   */
  async fetchInAppPurchaseState(productId: string): Promise<ProductPriceState> {
    const iap = await getInAppPurchase(this.credentials, productId, this.ctx);
    if (!iap) throw new ApiError(`In-app purchase ${productId} not found in ${this.credentials.bundleId}`, { status: 404, code: 'NOT_FOUND', platform: 'apple', retryable: false });
    const { entries, warnings: readWarnings } = await listInAppPurchasePriceEntries(this.credentials, iap.id, this.ctx);
    const base = await getBaseTerritoryForProduct(this.credentials, iap.id, this.ctx);
    const today = (this.now?.() ?? new Date()).toISOString().slice(0, 10);
    const territories: Record<string, TerritoryPriceState> = {};
    const warnings: string[] = [...readWarnings];
    const byTerritory = new Map<string, InAppPurchasePriceEntry[]>();
    for (const entry of entries) {
      if (!entry.territory) {
        warnings.push(entry.problem ?? `price ${entry.priceId} has no territory`);
        continue;
      }
      byTerritory.set(entry.territory, [...(byTerritory.get(entry.territory) ?? []), entry]);
    }
    const value = (entry: InAppPurchasePriceEntry, scheduled: boolean): PriceValue | string => {
      if (entry.problem || !entry.pricePoint || !entry.currency || !isDecimalString(entry.pricePoint.customerPrice)) return entry.problem ?? `unreadable price ${entry.priceId}`;
      return {
        currency: entry.currency,
        amount: normalizeDecimal(entry.pricePoint.customerPrice),
        pricePointId: entry.pricePoint.id,
        ...(isDecimalString(entry.pricePoint.proceeds) ? { proceeds: normalizeDecimal(entry.pricePoint.proceeds) } : {}),
        ...(scheduled && entry.startDate ? { startDate: normalizeStartDate(entry.startDate) } : {}),
      };
    };
    for (const [territory, list] of [...byTerritory].sort(([a], [b]) => a.localeCompare(b))) {
      const live = list.filter((e) => e.endDate === null || normalizeStartDate(e.endDate) > today);
      const future = live.filter((e) => e.startDate !== null && normalizeStartDate(e.startDate) > today);
      const active = live.filter((e) => !future.includes(e));
      const state: TerritoryPriceState = { territory, currency: list.find((e) => e.currency)?.currency ?? '', current: null };
      const problems: { current?: string; scheduled?: string } = {};
      const key = (e: InAppPurchasePriceEntry) => (e.startDate ? normalizeStartDate(e.startDate) : '');
      const latest = active.reduce<string | undefined>((max, e) => (max === undefined || key(e) > max ? key(e) : max), undefined);
      const current = active.filter((e) => key(e) === latest);
      if (current.length > 1) problems.current = `${current.length} prices share the latest start date`;
      else if (current.length === 1) {
        const v = value(current[0], false);
        if (typeof v === 'string') problems.current = v;
        else state.current = v;
      }
      if (future.length > 1) problems.scheduled = `${future.length} future prices (${future.map((e) => `${e.pricePoint?.customerPrice ?? '?'} from ${e.startDate}`).join(', ')})`;
      else if (future.length === 1) {
        const v = value(future[0], true);
        if (typeof v === 'string') problems.scheduled = v;
        else state.scheduled = v;
      }
      if (problems.current || problems.scheduled) {
        state.problems = problems;
        for (const [slot, message] of Object.entries(problems)) warnings.push(`${territory} ${slot}: ${message}`);
      }
      territories[territory] = state;
    }
    const baseTerritory = base ? toAlpha2(base) : undefined;
    if (entries.length > 0 && !baseTerritory) warnings.push('the price schedule has no readable base territory');
    return {
      product: { platform: 'apple', type: 'inapp', id: iap.id, productId: iap.productId },
      capturedAt: new Date().toISOString(),
      territories,
      ...(baseTerritory ? { baseTerritory } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * Snap each territory's target to that territory's own live price points
   * for this subscription. Reads the ladders of several territories per
   * request (limit 8000), never a static tier table.
   */
  async resolvePricePoints(
    product: ProductRef,
    targets: Record<string, ResolveTarget>,
    options: { mode?: SnapMode } = {}
  ): Promise<ResolveResult> {
    const id = subscriptionId(product);
    const result: ResolveResult = { resolved: {}, unresolved: {} };
    const alpha3ByAlpha2 = new Map<string, string>();
    for (const territory of Object.keys(targets)) {
      const alpha3 = alpha2ToAlpha3(territory);
      if (!alpha3) result.unresolved[territory] = `Unknown Apple territory ${territory}`;
      else if (!isDecimalString(targets[territory].amount)) result.unresolved[territory] = `Invalid amount ${JSON.stringify(targets[territory].amount)}`;
      else alpha3ByAlpha2.set(territory, alpha3);
    }
    if (alpha3ByAlpha2.size === 0) return result;

    const ladders = await listSubscriptionPricePointsByTerritory(this.credentials, id, [...alpha3ByAlpha2.values()], this.ctx);
    for (const [territory, alpha3] of alpha3ByAlpha2) {
      const target = targets[territory];
      const ladder: TerritoryPricePoint[] = (ladders.get(alpha3) ?? []).filter((p) => isDecimalString(p.customerPrice));
      if (ladder.length === 0) {
        result.unresolved[territory] = `No Apple price points for ${territory}`;
        continue;
      }
      const currency = ladder[0].currency;
      if (currency && currency !== target.currency) {
        result.unresolved[territory] = `${territory} is priced in ${currency}, target is ${target.currency}`;
        continue;
      }
      const snapped = snapToPricePoints(
        normalizeDecimal(target.amount),
        ladder.map((p) => ({ ...p, customerPrice: normalizeDecimal(p.customerPrice) })),
        options.mode ?? 'nearest'
      );
      if (!snapped) {
        result.unresolved[territory] = `No ${options.mode ?? 'nearest'} price point for ${target.amount} ${target.currency}`;
        continue;
      }
      result.resolved[territory] = {
        currency: target.currency,
        amount: snapped.point.customerPrice,
        pricePointId: snapped.point.id,
        ...(isDecimalString(snapped.point.proceeds) ? { proceeds: normalizeDecimal(snapped.point.proceeds) } : {}),
        target: normalizeDecimal(target.amount),
        deviation: snapped.deviation,
        deviationRatio: snapped.deviationRatio,
      };
    }
    return result;
  }

  /**
   * Apple's own equivalents of one price point across territories (alpha-2
   * keyed). Fits "same tier everywhere" plans; not used for per-territory
   * targets.
   */
  async equalize(pricePointId: string, territories?: string[]): Promise<Record<string, TerritoryPricePoint>> {
    const alpha3 = territories?.map((t) => alpha2ToAlpha3(t)).filter((t): t is string => Boolean(t));
    const points = await getSubscriptionPricePointEqualizations(this.credentials, pricePointId, { territories: alpha3 }, this.ctx);
    const out: Record<string, TerritoryPricePoint> = {};
    for (const point of points) {
      const alpha2 = toAlpha2(point.territory);
      if (alpha2) out[alpha2] = point;
    }
    return out;
  }

  /** A scheduled-price replacement is two requests (create, then delete); everything else one. */
  requestsNeeded(ops: BasePriceOp[], contexts: ApplyContext[]): number {
    return ops.reduce(
      (sum, op, i) => sum + (op.kind === 'schedulePrice' && op.before && contexts[i]?.territoryState?.refs?.scheduledPriceId ? 2 : 1),
      0
    );
  }

  async apply(op: BasePriceOp, context: ApplyContext): Promise<OpResponse> {
    const id = subscriptionId(op.target.product);
    const territory = op.target.territory;
    const preserve = op.options?.preserveCurrentPrice ?? true;

    switch (op.kind) {
      case 'setPrice': {
        try {
          const created = await updateSubscriptionPrice(this.credentials, id, op.after!.pricePointId!, territory, undefined, preserve, this.ctx);
          return { createdPriceId: created.id ?? null };
        } catch (error) {
          const scheduled = context.territoryState?.scheduled;
          if (getErrorStatus(error) === 409 && scheduled) {
            // Same wording as the subscription PATCH route: name the scheduled
            // price, never delete anything on a 409
            const apiError = toApiError(error, 'apple');
            const detail = (apiError as { detail?: unknown }).detail;
            throw new ApiError(
              `${typeof detail === 'string' && detail ? detail : apiError.message} (a scheduled price already exists for ${territory}: ${describePrice(scheduled)}. If this is the conflict, clear the scheduled price first, then apply again.)`,
              { status: 409, code: apiError.code, platform: 'apple', retryable: false, cause: error }
            );
          }
          throw error;
        }
      }
      case 'schedulePrice': {
        // Create the new scheduled price first. Only once it exists is the one
        // it replaces deleted; a failed create deletes nothing.
        const created = await updateSubscriptionPrice(
          this.credentials,
          id,
          op.after!.pricePointId!,
          territory,
          op.after!.startDate,
          preserve,
          this.ctx
        );
        const replacedId = op.before ? context.territoryState?.refs?.scheduledPriceId : undefined;
        if (!replacedId) return { createdPriceId: created.id ?? null };
        try {
          await deleteSubscriptionPrice(this.credentials, replacedId, this.ctx);
          return { createdPriceId: created.id ?? null, deletedPriceId: replacedId };
        } catch (error) {
          if (getErrorStatus(error) === 404) return { createdPriceId: created.id ?? null, deletedPriceId: replacedId };
          if (isBudgetExceeded(error)) {
            // Don't report this as done: the run must stop and say so. The
            // territory now has two scheduled prices; a resume reports it as
            // changed rather than guessing which to keep.
            throw new ApiError(
              `New scheduled price ${created.id ?? ''} created in ${territory}, but the request budget ran out before the one it replaces (${replacedId}) could be deleted. Delete one of the two scheduled prices.`,
              { status: 429, code: 'BUDGET_EXCEEDED', platform: 'apple', retryable: false, cause: error }
            );
          }
          return {
            createdPriceId: created.id ?? null,
            warning: `New scheduled price added, but the one it replaces (${replacedId}) could not be removed: ${(error as Error).message}`,
          };
        }
      }
      case 'deleteScheduled': {
        const scheduled = context.territoryState?.scheduled;
        const priceId = context.territoryState?.refs?.scheduledPriceId;
        if (!scheduled || !priceId || !op.before || !samePrice('apple', scheduled, op.before, 'scheduled') || !decimalEquals(scheduled.amount, op.before.amount)) {
          throw new ApiError(`No scheduled price matching the plan in ${territory}; nothing deleted`, {
            status: 409,
            code: 'STATE_CHANGED',
            platform: 'apple',
            retryable: false,
          });
        }
        await deleteSubscriptionPrice(this.credentials, priceId, this.ctx);
        return { deletedPriceId: priceId };
      }
      case 'removePrice':
        throw unsupported("Apple can't remove a territory's current price");
    }
  }

  inverse(op: BasePriceOp) {
    return invertOp(op);
  }

  // -------------------------------------------------------------------------
  // Offers (read-only)

  /** Every offer of the subscription (intro, promotional, offer codes, win-back), with prices per territory */
  async fetchOffers(product: ProductRef): Promise<StoreOffer[]> {
    return listSubscriptionOffers(this.credentials, subscriptionId(product), this.ctx);
  }

  /** One offer by store ID or key; null if the subscription has none */
  async fetchOffer(product: ProductRef, kind: AppleOfferKind, idOrKey: string): Promise<StoreOffer | null> {
    return getSubscriptionOffer(this.credentials, subscriptionId(product), kind, idOrKey, this.ctx);
  }

  /** The subscription's billing period, as an ISO duration */
  async fetchBillingPeriod(product: ProductRef): Promise<BillingPeriod> {
    const id = subscriptionId(product);
    const subscription = await getSubscriptionById(this.credentials, id, this.ctx);
    if (!subscription) throw new ApiError(`Subscription ${id} not found`, { status: 404, code: 'NOT_FOUND', platform: 'apple', retryable: false });
    const period = appleSubscriptionPeriodToIso(subscription.period);
    if (!period) {
      throw new ApiError(`Subscription ${id} has an unknown billing period ${JSON.stringify(subscription.period)}`, {
        status: 422,
        code: 'UNKNOWN_PERIOD',
        platform: 'apple',
        retryable: false,
      });
    }
    return period;
  }

  /** Each territory's valid subscription price points (alpha-2 keyed), for offer derivation */
  async fetchPriceLadders(product: ProductRef, territories: string[]): Promise<Record<string, PriceLadder>> {
    const id = subscriptionId(product);
    const alpha3 = [...new Set(territories)].map((t) => alpha2ToAlpha3(t)).filter((t): t is string => Boolean(t));
    if (alpha3.length === 0) return {};
    const ladders = await listSubscriptionPricePointsByTerritory(this.credentials, id, alpha3, this.ctx);
    const out: Record<string, PriceLadder> = {};
    for (const [territory, points] of ladders) {
      const alpha2 = toAlpha2(territory);
      if (!alpha2) continue;
      out[alpha2] = {
        ...(points[0]?.currency ? { currency: points[0].currency } : {}),
        points: points.map((p) => ({ id: p.id, customerPrice: p.customerPrice, proceeds: p.proceeds })),
      };
    }
    return out;
  }

  /**
   * Preview a percent-of-current offer. Refuses a rule that can't apply
   * (free trial, weeks against months, bad percent) after reading only the
   * billing period; then reads the current prices and each territory's
   * price points and derives the offer price per territory. Reads only.
   */
  async previewOffer(
    product: ProductRef,
    options: { rule: PercentOfCurrentRule; mode: OfferMode; duration: OfferDuration; territories?: 'all' | string[]; deviationThreshold?: Decimal }
  ): Promise<OfferDerivation> {
    const offer = { mode: options.mode, duration: options.duration };
    const billingPeriod = await this.fetchBillingPeriod(product);
    assertDerivableOffer(options.rule, offer, billingPeriod);
    const base = await this.fetchState(product);
    const ladders = await this.fetchPriceLadders(product, this.ladderTerritories(base, options.territories));
    return deriveOfferPrices({
      rule: options.rule,
      offer,
      billingPeriod,
      base,
      ladders,
      territories: options.territories,
      deviationThreshold: options.deviationThreshold,
    });
  }

  /**
   * Check an existing offer against its rule: which territories' offer
   * prices no longer match the rule applied to today's base prices. Returns
   * null when the subscription has no such offer. An offer the rule can't
   * apply to (free trial, unknown mode or duration, weeks against months)
   * is refused with OfferRuleError before any base price or price point is
   * read. Without a basis, a pay-up-front offer is checked over its whole
   * duration and any other offer per billing period. Reads only.
   */
  async checkOfferDrift(
    product: ProductRef,
    options: {
      kind: AppleOfferKind;
      offer: string;
      rule: Omit<PercentOfCurrentRule, 'basis'> & { basis?: PercentOfCurrentRule['basis'] };
      territories?: 'all' | string[];
      deviationThreshold?: Decimal;
    }
  ): Promise<OfferDriftReport | null> {
    const offer = await this.fetchOffer(product, options.kind, options.offer);
    if (!offer) return null;
    if (offer.mode === null || offer.duration === null || offer.mode === 'FREE_TRIAL') {
      // Same refusal the core gives, before spending requests on prices and ladders
      throw new OfferRuleError(
        offer.mode === 'FREE_TRIAL'
          ? `Offer ${offer.key} is a free trial; it has no price to check`
          : `Offer ${offer.key} has an unknown mode or duration; its rule can't be checked`
      );
    }
    const rule: PercentOfCurrentRule = { ...options.rule, basis: options.rule.basis ?? defaultOfferBasis(offer.mode) };
    const billingPeriod = await this.fetchBillingPeriod(product);
    assertDerivableOffer(rule, offer, billingPeriod);
    const base = await this.fetchState(product);
    const ladders = await this.fetchPriceLadders(product, this.ladderTerritories(base, options.territories));
    return checkOfferDrift({
      rule,
      offer,
      billingPeriod,
      base,
      ladders,
      territories: options.territories,
      deviationThreshold: options.deviationThreshold,
      now: (this.now?.() ?? new Date()).toISOString(),
    });
  }

  private ladderTerritories(base: ProductPriceState, territories: 'all' | string[] | undefined): string[] {
    return territories === undefined || territories === 'all' ? Object.keys(base.territories) : territories;
  }

  // -------------------------------------------------------------------------
  // Offer plans (reads only)

  /**
   * Plan offers from specs: reads each product's billing period, current
   * prices, price points and existing offers once, then plans every offer
   * (create, re-price, leave alone or refuse) into one ChangeSet. Several
   * products, each with its own offer key, go in one plan. Reads only.
   */
  async planOffers(input: {
    app: AppRef;
    offers: OfferSpec[];
    deviationThreshold?: Decimal;
    today?: string;
    id?: string;
    createdAt?: string;
    description?: string;
  }): Promise<OfferPlan> {
    this.assertApp(input.app);
    const products = new Map<string, { billingPeriod?: BillingPeriod; base?: ProductPriceState; ladders?: Record<string, PriceLadder>; offers: Map<string, StoreOffer[]> }>();
    const inputs: OfferPlanInput[] = [];
    for (const spec of input.offers) {
      const product = spec.productRef;
      const id = subscriptionId(product);
      let cache = products.get(id);
      if (!cache) {
        await this.verifyProduct(product);
        cache = { offers: new Map() };
        products.set(id, cache);
      }
      cache.billingPeriod ??= await this.fetchBillingPeriod(product);
      cache.base ??= await this.fetchState(product);
      const needsLadders = spec.pricing.type === 'percentOfCurrent' || spec.pricing.type === 'fixed';
      if (needsLadders && !cache.ladders) cache.ladders = await this.fetchPriceLadders(product, Object.keys(cache.base.territories));
      if (!cache.offers.has(spec.kind)) {
        cache.offers.set(spec.kind, await listSubscriptionOffersOfKind(this.credentials, id, spec.kind as AppleOfferKind, this.ctx));
      }
      inputs.push({
        spec,
        billingPeriod: cache.billingPeriod,
        base: cache.base,
        ladders: cache.ladders ?? {},
        existing: cache.offers.get(spec.kind)!,
        ...(input.deviationThreshold ? { deviationThreshold: input.deviationThreshold } : {}),
      });
    }
    return planOfferChanges({
      app: input.app,
      inputs,
      today: input.today ?? (this.now?.() ?? new Date()).toISOString().slice(0, 10),
      ...(input.id ? { id: input.id } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.description ? { description: input.description } : {}),
    });
  }

  /** Plan ending, re-activating or deleting one existing offer. Reads only. */
  async planOfferLifecycle(input: Omit<OfferLifecycleInput, 'existing'>): Promise<OfferPlan> {
    this.assertApp(input.app);
    await this.verifyProduct(input.product);
    const existing = await listSubscriptionOffersOfKind(this.credentials, subscriptionId(input.product), input.kind, this.ctx);
    return planOfferLifecycle({ ...input, existing });
  }

  // -------------------------------------------------------------------------
  // Sync and drift from a rules file (reads only)

  /**
   * What sync and drift need for each product a rules file names, each read
   * once: app ownership, billing period, base prices (or the state a base
   * plan was made against, from `states`) and the offers of every kind the
   * rules name. Price points, the expensive read (one request per 10
   * territories), are read only for offers a rule can price (found, known
   * terms, not a free trial), and only for their territories:
   *   sync  - the offer's territories within the rule's `territories`
   *   drift - the offer's territories, or the rule's list when it has one
   *           (a listed territory the offer lacks is reported as missing)
   * For 'sync', products without a syncWithBase rule aren't read at all.
   * `ladderTerritories` records what was read. Reads only.
   */
  async readRuleProducts(
    rules: OfferRules,
    options: { states?: ProductPriceState[]; purpose?: 'sync' | 'drift' } = {}
  ): Promise<OfferSyncProduct[]> {
    this.assertApp(rules.app);
    const purpose = options.purpose ?? 'drift';
    const active = purpose === 'sync' ? rules.offers.filter((r) => r.syncWithBase) : rules.offers;
    const out: OfferSyncProduct[] = [];
    for (const product of ruleProducts({ offers: active })) {
      const id = subscriptionId(product);
      const key = productKey(product);
      const productRules = active.filter((r) => productKey(r.product) === key);
      await this.verifyProduct(product);
      const billingPeriod = await this.fetchBillingPeriod(product);
      const base = options.states?.find((s) => productKey(s.product) === key) ?? (await this.fetchState(product));
      const offers: StoreOffer[] = [];
      for (const kind of [...new Set(productRules.map((r) => r.kind as AppleOfferKind))]) {
        offers.push(...(await listSubscriptionOffersOfKind(this.credentials, id, kind, this.ctx)));
      }
      const wanted = new Set<string>();
      for (const rule of productRules) {
        const matches = findRuleOffer(rule, offers);
        if (matches.length !== 1) continue; // missing or ambiguous: reported without pricing
        const offer = matches[0];
        if (!offer.mode || !offer.duration || offer.mode === 'FREE_TRIAL') continue; // the rule can't price it
        const own = [...Object.keys(offer.prices), ...Object.keys(offer.territoryProblems ?? {})];
        const list = rule.territories && rule.territories !== 'all' ? rule.territories : undefined;
        const territories = !list ? own : purpose === 'drift' ? list : own.filter((t) => list.includes(t));
        // A territory without a base price can't be priced; its price points aren't needed
        for (const t of territories) if (base.territories[t]) wanted.add(t);
      }
      const ladderTerritories = [...wanted].sort();
      const ladders = ladderTerritories.length > 0 ? await this.fetchPriceLadders(product, ladderTerritories) : {};
      out.push({ product, billingPeriod, base, ladders, offers, ladderTerritories });
    }
    return out;
  }

  /**
   * Plan keeping the rules file's syncWithBase offers in step: against the
   * target prices of `base` (a base-price plan, whose ops come first), or
   * today's prices without one. Pass the states `base` was planned against
   * to avoid reading them again. Reads only.
   */
  async planOfferSync(input: {
    rules: OfferRules;
    base?: ChangeSet;
    states?: ProductPriceState[];
    scheduledBase?: ScheduledBasePolicy;
    id?: string;
    createdAt?: string;
    description?: string;
  }): Promise<OfferSyncPlan> {
    const products = await this.readRuleProducts(input.rules, { purpose: 'sync', ...(input.states ? { states: input.states } : {}) });
    return planOfferSync({
      app: input.rules.app,
      rules: input.rules.offers,
      products,
      ...(input.base ? { base: input.base } : {}),
      ...(input.scheduledBase ? { scheduledBase: input.scheduledBase } : {}),
      ...(input.id ? { id: input.id } : {}),
      createdAt: input.createdAt ?? (this.now?.() ?? new Date()).toISOString(),
      ...(input.description ? { description: input.description } : {}),
    });
  }

  /** Check every offer in a rules file against its rule; one combined pricingkit.rulesDrift report. Reads only. */
  async checkRulesDrift(rules: OfferRules): Promise<RulesDriftReport> {
    const products = await this.readRuleProducts(rules, { purpose: 'drift' });
    return checkRulesDrift({ app: rules.app, rules: rules.offers, products, now: (this.now?.() ?? new Date()).toISOString() });
  }

  /** The executor's app check: the plan must be for the credentials' app (bundle ID) */
  verifyApp(app: AppRef): void {
    this.assertApp(app);
  }

  private assertApp(app: AppRef): void {
    if (!('bundleId' in app) || (this.credentials.bundleId && app.bundleId !== this.credentials.bundleId)) {
      throw new ApiError(`The plan is for ${'bundleId' in app ? app.bundleId : app.packageName}, but the session is for ${this.credentials.bundleId}`, {
        status: 409,
        code: 'APP_MISMATCH',
        platform: 'apple',
        retryable: false,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Offer writes (called by the executor after it has checked the offer's state)

  /** An intro offer op sends one request per pending territory; every other offer op one */
  offerRequestsNeeded(op: AnyOfferOp, context: OfferApplyContext): number {
    if (isPlayOfferOp(op)) return 1;
    if (op.target.offer.kind === 'apple.intro') return Math.max(1, context.pending?.length ?? Object.keys((op.after ?? op.before)!.prices).length);
    return 1;
  }

  async applyOffer(op: AnyOfferOp, context: OfferApplyContext): Promise<OpResponse> {
    if (isPlayOfferOp(op)) throw unsupported('The Apple adapter applies App Store offer ops only');
    const id = subscriptionId(op.target.product);
    try {
      switch (op.target.offer.kind) {
        case 'apple.promo':
          return await this.applyPromo(id, op, context);
        case 'apple.intro':
          return await this.applyIntro(id, op, context);
        case 'apple.offerCode':
          return await this.applyOfferCode(id, op, context);
        case 'apple.winBack':
          return await this.applyWinBack(id, op, context);
        default:
          throw unsupported(`Unknown offer kind ${op.target.offer.kind}`);
      }
    } catch (error) {
      throw explainOfferRefusal(error, op);
    }
  }

  private storeId(op: OfferOp, context: OfferApplyContext): string {
    const id = context.offer?.storeId;
    if (!id) throw unsupported(`The ${offerKindLabel(op.target.offer.kind)} "${op.target.offer.key}" has no store ID to act on`);
    return id;
  }

  private async applyPromo(subscription: string, op: OfferOp, context: OfferApplyContext): Promise<OpResponse> {
    switch (op.kind) {
      case 'createOffer': {
        const after = op.after!;
        const created = await createPromotionalOffer(
          this.credentials,
          {
            subscriptionId: subscription,
            name: after.name ?? after.key,
            offerCode: after.key,
            duration: isoToAppleOfferDuration(after.duration),
            offerMode: after.mode,
            numberOfPeriods: after.periods,
            prices: offerPrices(after.prices),
          },
          this.ctx
        );
        return { createdOfferId: created.id, territories: Object.keys(after.prices).length };
      }
      case 'updateOfferPrices': {
        const offerId = this.storeId(op, context);
        const refs = context.offer?.priceRefs ?? {};
        const observed = (context.observed as OfferState | null)?.prices ?? {};
        const keep: string[] = [];
        const add: Record<string, OfferTerritoryPrice> = {};
        for (const [territory, price] of Object.entries(op.after!.prices)) {
          if (refs[territory] && sameOfferPrice(observed[territory], price)) keep.push(refs[territory]);
          else add[territory] = price;
        }
        await replacePromotionalOfferPrices(this.credentials, offerId, keep, offerPrices(add), this.ctx);
        return { offerId, kept: keep.length, replaced: Object.keys(add).length };
      }
      case 'deleteOffer': {
        const offerId = this.storeId(op, context);
        await deletePromotionalOffer(this.credentials, offerId, this.ctx);
        return { deletedOfferId: offerId };
      }
      default:
        throw unsupported('Apple promotional offers have no active switch or end date');
    }
  }

  private async applyIntro(subscription: string, op: OfferOp, context: OfferApplyContext): Promise<OpResponse> {
    const state = (op.after ?? op.before)!;
    const pending = context.pending ?? [];
    const done: string[] = [];
    const ids: Record<string, string> = {};
    const step = async (territory: string, run: () => Promise<string | void>) => {
      try {
        const result = await run();
        if (result) ids[territory] = result;
        done.push(territory);
      } catch (error) {
        if (done.length === 0) throw error;
        // Some territories were written: say so, so the run log is truthful. A resume skips them.
        const apiError = toApiError(error, 'apple');
        const detail = error instanceof AppleApiError ? error.detail : apiError.message;
        const partial = new ApiError(`${territory} failed after ${done.length} of ${pending.length} territories were written (${done.join(', ')}): ${detail}. Resume the run to continue with the rest.`, {
          status: apiError.status,
          ...(apiError.code !== undefined ? { code: apiError.code } : {}),
          platform: 'apple',
          retryable: false,
          details: { written: [...done] },
          cause: error,
        });
        // The executor records this in the run log: a resume and an undo then know exactly which resources exist
        Object.assign(partial, { partialResponse: { territories: done.length, ...(Object.keys(ids).length ? { createdIds: { ...ids } } : {}) } });
        throw partial;
      }
    };
    for (const territory of pending) {
      const ref = context.storeRefs?.[territory];
      switch (op.kind) {
        case 'createOffer': {
          const price = state.prices[territory];
          await step(territory, async () =>
            (
              await createIntroductoryOffer(
                this.credentials,
                {
                  subscriptionId: subscription,
                  territory,
                  ...(price.free ? {} : { pricePointId: price.pricePointId }),
                  duration: isoToAppleOfferDuration(state.duration),
                  offerMode: state.mode,
                  numberOfPeriods: state.periods,
                  ...(state.schedule?.start ? { startDate: state.schedule.start } : {}),
                  ...(state.schedule?.end ? { endDate: state.schedule.end } : {}),
                },
                this.ctx
              )
            ).id
          );
          break;
        }
        case 'deactivateOffer':
        case 'activateOffer':
          if (!ref) throw unsupported(`${territory}: no introductory offer resource to update`);
          await step(territory, () => setIntroductoryOfferEndDate(this.credentials, ref, op.after!.schedule?.end ?? null, this.ctx));
          break;
        case 'deleteOffer':
          if (!ref) throw unsupported(`${territory}: no introductory offer resource to delete`);
          await step(territory, async () => {
            try {
              await deleteIntroductoryOffer(this.credentials, ref, this.ctx);
            } catch (error) {
              if (getErrorStatus(error) !== 404) throw error; // already gone: done
            }
          });
          break;
        default:
          throw unsupported("Apple can't change an introductory offer's price; end or delete it and create a new one");
      }
    }
    return { territories: done.length, ...(Object.keys(ids).length ? { createdIds: ids } : {}) };
  }

  private async applyOfferCode(subscription: string, op: OfferOp, context: OfferApplyContext): Promise<OpResponse> {
    switch (op.kind) {
      case 'createOffer': {
        const after = op.after!;
        if (after.eligibility?.type !== 'apple.offerCode') throw unsupported('An offer code needs its eligibility');
        const created = await createOfferCode(
          this.credentials,
          {
            subscriptionId: subscription,
            name: after.key,
            customerEligibilities: after.eligibility.customerEligibilities,
            offerEligibility: after.eligibility.offerEligibility,
            duration: isoToAppleOfferDuration(after.duration),
            offerMode: after.mode,
            numberOfPeriods: after.periods,
            ...(after.autoRenewEnabled !== undefined ? { autoRenewEnabled: after.autoRenewEnabled } : {}),
            prices: offerPrices(after.prices),
          },
          this.ctx
        );
        return { createdOfferId: created.id, territories: Object.keys(after.prices).length };
      }
      case 'deactivateOffer':
      case 'activateOffer': {
        const offerId = this.storeId(op, context);
        await setOfferCodeActive(this.credentials, offerId, op.kind === 'activateOffer', this.ctx);
        return { offerId, active: op.kind === 'activateOffer' };
      }
      default:
        throw unsupported(
          op.kind === 'deleteOffer'
            ? "App Store Connect's API can't delete an offer code; deactivate it instead"
            : "Apple can't change an offer code's prices; create a new offer code and deactivate this one"
        );
    }
  }

  private async applyWinBack(subscription: string, op: OfferOp, context: OfferApplyContext): Promise<OpResponse> {
    switch (op.kind) {
      case 'createOffer': {
        const after = op.after!;
        if (after.eligibility?.type !== 'apple.winBack' || !after.schedule?.start) throw unsupported('A win-back offer needs its eligibility and a start date');
        const created = await createWinBackOffer(
          this.credentials,
          {
            subscriptionId: subscription,
            referenceName: after.name ?? after.key,
            offerId: after.key,
            duration: isoToAppleOfferDuration(after.duration),
            offerMode: after.mode,
            periodCount: after.periods,
            paidSubscriptionDurationInMonths: after.eligibility.paidSubscriptionDurationInMonths,
            timeSinceLastSubscribedInMonths: after.eligibility.timeSinceLastSubscribedInMonths,
            ...(after.eligibility.waitBetweenOffersInMonths !== undefined ? { waitBetweenOffersInMonths: after.eligibility.waitBetweenOffersInMonths } : {}),
            startDate: after.schedule.start,
            ...(after.schedule.end ? { endDate: after.schedule.end } : {}),
            priority: after.priority ?? 'NORMAL',
            ...(after.promotionIntent ? { promotionIntent: after.promotionIntent } : {}),
            prices: offerPrices(after.prices),
          },
          this.ctx
        );
        return { createdOfferId: created.id, territories: Object.keys(after.prices).length };
      }
      case 'deactivateOffer':
      case 'activateOffer': {
        const offerId = this.storeId(op, context);
        await updateWinBackOffer(this.credentials, offerId, { endDate: op.after!.schedule?.end ?? null }, this.ctx);
        return { offerId, endDate: op.after!.schedule?.end ?? null };
      }
      case 'deleteOffer': {
        const offerId = this.storeId(op, context);
        await deleteWinBackOffer(this.credentials, offerId, this.ctx);
        return { deletedOfferId: offerId };
      }
      default:
        throw unsupported("Apple's win-back offer update has no prices; create a new win-back offer and end or delete this one");
    }
  }
}

function offerPrices(prices: Record<string, OfferTerritoryPrice>): OfferPriceInput[] {
  return Object.keys(prices)
    .sort()
    .map((territory) => ({ territory, ...(prices[territory].free ? {} : { pricePointId: prices[territory].pricePointId }) }));
}

const VERBS: Record<OfferOp['kind'], string> = {
  createOffer: 'create',
  updateOfferPrices: 'change the prices of',
  deactivateOffer: 'deactivate',
  activateOffer: 'reactivate',
  deleteOffer: 'delete',
};

/** What Apple's refusal most likely means for this kind of write */
function refusalHint(op: OfferOp, status: number | undefined): string | undefined {
  if (status !== 409 && status !== 422 && status !== 400) return undefined;
  const kind = op.target.offer.kind;
  if (kind === 'apple.promo' && op.kind === 'createOffer') {
    return 'A subscription can have at most 10 promotional offers, and an offer code must be unique across its subscription group';
  }
  if (kind === 'apple.promo' && op.kind === 'updateOfferPrices') {
    return "Only a promotional offer's prices can change; its duration, mode and number of periods can't be edited, and every price must be one of this subscription's price points";
  }
  if (kind === 'apple.intro' && op.kind === 'createOffer') return 'Apple allows one introductory offer per territory at a time; check for an overlapping offer';
  if (kind === 'apple.offerCode' && op.kind === 'createOffer') return 'Check the offer code name is unique and the eligibility fits the offer mode';
  if (kind === 'apple.winBack' && op.kind === 'createOffer') {
    return 'Check the offer ID is unique, the start date is not in the past, and the eligibility months are within Apple\'s limits';
  }
  return undefined;
}

/**
 * Turn an App Store Connect refusal into an error that says which offer write
 * was refused and why, keeping the status and code (a spent budget stays
 * BUDGET_EXCEEDED so the run stops).
 */
export function explainOfferRefusal(error: unknown, op: OfferOp): unknown {
  if (isBudgetExceeded(error) || !(error instanceof ApiError)) return error;
  if (error.code === 'UNSUPPORTED_OPERATION') return error;
  const detail = error instanceof AppleApiError ? error.detail || error.title : error.message;
  const hint = refusalHint(op, error.status);
  const explained = new ApiError(
    `Apple refused to ${VERBS[op.kind]} the ${offerKindLabel(op.target.offer.kind)} "${op.target.offer.key}": ${detail}${hint ? `. ${hint}.` : ''}`,
    { status: error.status, ...(error.code !== undefined ? { code: error.code } : {}), platform: 'apple', retryable: error.retryable, details: error.details, cause: error }
  );
  // Keep what was written before the refusal (intro offers created in some territories)
  const partial = (error as { partialResponse?: unknown }).partialResponse;
  if (partial) Object.assign(explained, { partialResponse: partial });
  return explained;
}
