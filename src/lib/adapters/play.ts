// PlayAdapter: Google Play Developer API behind the core's PlatformAdapter
// interface. Covers base plan regional prices and one-time product prices.
// All ops on one product are written in a single PATCH (batchKey/applyMany),
// which changes only the regions named; everything else is sent back as fetched.
//
// Phase 3 adds subscription offers: reading them per base plan, planning
// them from offer specs, keeping them in step with a rules file (sync), and
// applying Play offer ops (create, patch, activate, deactivate,
// delete) for the executor.

import {
  decimalToMoney,
  deviationRatio,
  divideDecimal,
  compareDecimal,
  roundDecimal,
  DEFAULT_PLAY_COMMISSION,
  type ResolveOptions,
  invertOp,
  isDecimalString,
  moneyToDecimal,
  normalizeDecimal,
  productKey,
  subtractDecimal,
  currencyScale,
  isZeroDecimal,
  multiplyDecimal,
  type ApplyContext,
  type BasePriceOp,
  type OpResponse,
  type PlatformAdapter,
  type ProductPriceState,
  type ProductRef,
  type ResolveResult,
  type ResolveTarget,
  type TerritoryPriceState,
  changedPlayRegions,
  changedPlayOfferFields,
  findPlayRuleOffer,
  isPlayOfferOp,
  isPlayDuration,
  planPlayOfferChanges,
  planPlayOfferLifecycle,
  planPlayOfferSync,
  playPercentTargets,
  playRuleKey,
  playRuleTargets,
  playSpecPhase,
  projectedPlayBases,
  ruleProducts,
  samePlayOfferContent,
  type AnyOfferOp,
  type AppRef,
  type ChangeSet,
  type OfferApplyContext,
  type OfferPlan,
  type OfferRules,
  type OfferSpec,
  type OfferSyncPlan,
  type PlayOfferOp,
  type PlayOfferPlanInput,
  type PlayPhasePricing,
  type PlayRuleProduct,
  type PlayRuleSnaps,
  type StoreOffer,
} from '@/lib/pricing';
import type { BasePlan, Money, RegionalBasePlanConfig, ServiceAccountCredentials, Subscription } from '@/lib/google-play/types';
import {
  createSubscriptionOffer,
  deleteSubscriptionOffer,
  getSubscriptionOffer,
  listSubscriptionOffers,
  parsePlayOffer,
  patchSubscriptionOffer,
  playOfferResource,
  setSubscriptionOfferActive,
  type PlayOfferIdentity,
} from '@/lib/google-play/offers';
import { deleteBasePlanRegionPrice, getSubscription, updateBasePlanPrices } from '@/lib/google-play/subscriptions';
import { deleteRegionPrice, getInAppProductRaw, updateInAppProductPrices } from '@/lib/google-play/products';
import { convertRegionPrices, type ConvertRegionPricesResponse } from '@/lib/google-play/pricing';
import { ApiError, getErrorStatus } from '@/lib/utils/api-error';
import { isBudgetExceeded, type RequestBudget } from '@/lib/utils/request-budget';

export interface PlayAdapterOptions {
  credentials: ServiceAccountCredentials;
  packageName: string;
  budget?: RequestBudget;
}

function notFound(message: string): ApiError {
  return new ApiError(message, { status: 404, code: 'NOT_FOUND', platform: 'google', retryable: false });
}

function moneyDecimal(price: { units?: string; nanos?: number } | undefined): string | undefined {
  if (!price) return undefined;
  try {
    return moneyToDecimal(price.units, price.nanos);
  } catch {
    return undefined;
  }
}

function toMoney(currency: string, amount: string): Money {
  return { currencyCode: currency, ...decimalToMoney(amount) };
}

function unsupported(message: string): ApiError {
  return new ApiError(message, { status: 422, code: 'UNSUPPORTED_OPERATION', platform: 'google', retryable: false });
}

function basePlanRef(product: ProductRef): { productId: string; basePlanId: string } {
  if (product.platform !== 'google' || product.type !== 'subscription') throw unsupported('Play offers belong to a Google Play base plan (subscription productId + basePlanId)');
  return { productId: product.productId, basePlanId: product.basePlanId };
}

function appMismatch(message: string): ApiError {
  return new ApiError(message, { status: 409, code: 'APP_MISMATCH', platform: 'google', retryable: false });
}

export class PlayAdapter implements PlatformAdapter {
  readonly platform = 'google' as const;
  private readonly credentials: ServiceAccountCredentials;
  private readonly packageName: string;
  private readonly budget?: RequestBudget;

  /** Subscriptions verified to belong to this app (productId -> base plan IDs) */
  private readonly verified = new Map<string, Set<string>>();
  private regionsVersionRead?: Promise<string | undefined>;

  constructor(options: PlayAdapterOptions) {
    this.credentials = options.credentials;
    this.packageName = options.packageName;
    this.budget = options.budget;
  }

  private get ctx() {
    return { budget: this.budget };
  }

  /**
   * Throws APP_MISMATCH unless a plan is for this adapter's app. A service
   * account can reach every app it was granted, so a plan made for one
   * package must never be applied through an adapter for another.
   */
  verifyApp(app: AppRef): void {
    if (!('packageName' in app) || app.packageName !== this.packageName) {
      throw appMismatch(`The plan is for ${'packageName' in app ? app.packageName : app.bundleId}, but this session is for ${this.packageName}`);
    }
  }

  /**
   * Throws unless the base plan (or one-time product) exists in this app:
   * the subscription is read from this package and must name it, and the
   * base plan must be one of its own. Checked once per subscription.
   */
  async verifyProduct(product: ProductRef): Promise<void> {
    if (product.platform !== 'google') throw new ApiError('Not a Google Play product', { status: 400, platform: 'google', retryable: false });
    if (product.type !== 'subscription') return; // one-time products are read and written by package and ID only
    let plans = this.verified.get(product.productId);
    if (!plans) {
      const subscription = await getSubscription(this.credentials, this.packageName, product.productId, this.ctx);
      if (!subscription) throw notFound(`Subscription ${product.productId} not found in ${this.packageName}`);
      if (subscription.packageName && subscription.packageName !== this.packageName) {
        throw appMismatch(`Subscription ${product.productId} belongs to ${subscription.packageName}, not ${this.packageName}`);
      }
      plans = new Set((subscription.basePlans ?? []).map((bp) => bp.basePlanId));
      this.verified.set(product.productId, plans);
    }
    if (!plans.has(product.basePlanId)) throw notFound(`Base plan ${product.productId}/${product.basePlanId} not found in ${this.packageName}`);
  }

  async fetchState(product: ProductRef): Promise<ProductPriceState> {
    if (product.platform !== 'google') throw new ApiError('Not a Google Play product', { status: 400, platform: 'google', retryable: false });
    const territories: Record<string, TerritoryPriceState> = {};
    const warnings: string[] = [];
    const add = (region: string, price: { currencyCode?: string; units?: string; nanos?: number } | undefined, availability?: string) => {
      const amount = moneyDecimal(price);
      if (!price?.currencyCode || amount === undefined) {
        warnings.push(`${region}: no readable price`);
        return;
      }
      territories[region] = {
        territory: region,
        currency: price.currencyCode,
        current: { currency: price.currencyCode, amount },
        ...(availability ? { availability } : {}),
      };
    };

    if (product.type === 'subscription') {
      const subscription = await getSubscription(this.credentials, this.packageName, product.productId, this.ctx);
      const basePlan = subscription?.basePlans?.find((bp) => bp.basePlanId === product.basePlanId);
      if (!basePlan) throw notFound(`Base plan ${product.productId}/${product.basePlanId} not found`);
      for (const config of basePlan.regionalConfigs ?? []) {
        add(config.regionCode, config.price, config.newSubscriberAvailability === false ? 'NO_NEW_SUBSCRIBERS' : 'AVAILABLE');
      }
    } else {
      const raw = await getInAppProductRaw(this.credentials, this.packageName, product.productId, this.ctx);
      const options = raw.purchaseOptions ?? [];
      const option = product.purchaseOptionId ? options.find((o) => o.purchaseOptionId === product.purchaseOptionId) : options[0];
      if (!option) throw notFound(`Purchase option of ${product.productId} not found`);
      if (option !== options[0]) {
        throw new ApiError('Only the first purchase option can be edited', { status: 422, code: 'UNSUPPORTED_OPERATION', platform: 'google', retryable: false });
      }
      for (const config of option.regionalPricingAndAvailabilityConfigs ?? []) {
        if (config.regionCode) add(config.regionCode, config.price, config.availability);
      }
    }
    return { product, capturedAt: new Date().toISOString(), territories, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  /**
   * Snap targets to prices Play would produce itself, with
   * monetization.convertRegionPrices. That endpoint takes a tax-exclusive
   * price and returns tax-inclusive regional prices (with the tax amount), so:
   * - customer price targets: one call learns each region's tax share, then
   *   each target is converted back to tax-exclusive and run through Play once
   *   more. Requests: 1 + one per distinct target.
   * - proceeds targets (options.measure "proceeds"): the tax-exclusive price
   *   that leaves `target` after the service fee is target / (1 - commission);
   *   it goes through Play once. Requests: one per distinct target.
   * Every resolved price carries Play's tax and the estimated proceeds,
   * (price - tax) x (1 - commission), commission defaulting to 15%.
   * Play has no price ladder, so snap modes don't apply.
   */
  async resolvePricePoints(product: ProductRef, targets: Record<string, ResolveTarget>, options: ResolveOptions = {}): Promise<ResolveResult> {
    if (product.platform !== 'google') throw new ApiError('Not a Google Play product', { status: 400, platform: 'google', retryable: false });
    const result: ResolveResult = { resolved: {}, unresolved: {} };
    const commission = options.commission ?? DEFAULT_PLAY_COMMISSION;
    if (!isDecimalString(commission) || compareDecimal(commission, '0') < 0 || compareDecimal(commission, '1') >= 0) {
      throw new ApiError(`Invalid commission ${JSON.stringify(commission)}: a fraction from 0 up to (not including) 1`, { status: 400, platform: 'google', retryable: false });
    }
    const keep = subtractDecimal('1', commission);
    const byProceeds = options.measure === 'proceeds';
    const entries = Object.entries(targets).filter(([territory, target]) => {
      if (isDecimalString(target.amount)) return true;
      result.unresolved[territory] = `Invalid amount ${JSON.stringify(target.amount)}`;
      return false;
    });
    if (entries.length === 0) return result;

    const convert = (currency: string, amount: string) =>
      convertRegionPrices(this.credentials, this.packageName, toMoney(currency, amount), this.ctx);

    // 1. Customer price targets: tax share per region, from any one conversion
    let probe: ConvertRegionPricesResponse | undefined;
    if (!byProceeds) {
      const [, firstTarget] = entries[0];
      probe = await convert(firstTarget.currency, normalizeDecimal(firstTarget.amount));
    }

    // 2. Convert each distinct tax-exclusive target
    const cache = new Map<string, Promise<ConvertRegionPricesResponse>>();
    for (const [territory, target] of entries) {
      const amount = normalizeDecimal(target.amount);
      let exclusive: string;
      if (byProceeds) {
        exclusive = divideDecimal(amount, keep, currencyScale(target.currency));
      } else {
        const probed = probe!.convertedRegionPrices?.[territory];
        const gross = moneyDecimal(probed?.price);
        const tax = moneyDecimal(probed?.taxAmount) ?? '0';
        if (!probed || gross === undefined) {
          result.unresolved[territory] = `Play returned no converted price for ${territory}`;
          continue;
        }
        if (probed.price.currencyCode !== target.currency) {
          result.unresolved[territory] = `${territory} is priced in ${probed.price.currencyCode}, target is ${target.currency}`;
          continue;
        }
        const net = subtractDecimal(gross, tax);
        // The tax-exclusive input that should come back as `amount`: amount * net / gross
        exclusive = isZeroDecimal(gross) ? amount : divideDecimal(multiplyDecimal(amount, net), gross, currencyScale(target.currency));
      }
      const key = `${target.currency} ${exclusive}`;
      if (!cache.has(key)) cache.set(key, convert(target.currency, exclusive));
      const converted = (await cache.get(key)!).convertedRegionPrices?.[territory];
      const snapped = moneyDecimal(converted?.price);
      if (!converted || snapped === undefined || converted.price.currencyCode !== target.currency) {
        result.unresolved[territory] = converted && converted.price?.currencyCode !== target.currency
          ? `${territory} is priced in ${converted.price?.currencyCode}, target is ${target.currency}`
          : `Play returned no usable price for ${territory}`;
        continue;
      }
      const tax = moneyDecimal(converted.taxAmount) ?? '0';
      const proceeds = roundDecimal(multiplyDecimal(subtractDecimal(snapped, tax), keep), currencyScale(target.currency));
      const measured = byProceeds ? proceeds : snapped;
      result.resolved[territory] = {
        currency: target.currency,
        amount: snapped,
        tax,
        proceeds,
        proceedsEstimated: true,
        ...(byProceeds ? { measure: 'proceeds' as const } : {}),
        target: amount,
        deviation: subtractDecimal(measured, amount),
        deviationRatio: deviationRatio(amount, measured),
      };
    }
    return result;
  }

  /**
   * Price edits: one read and one PATCH for the whole batch. Each region
   * removal: a read and a PATCH. Plus one price conversion when the plan
   * recorded no regions version.
   */
  requestsNeeded(ops: BasePriceOp[]): number {
    const sets = ops.some((op) => op.kind === 'setPrice') ? 2 : 0;
    const version = ops.some((op) => op.options?.regionsVersion) || this.regionsVersionRead ? 0 : 1;
    return sets + 2 * ops.filter((op) => op.kind === 'removePrice').length + version;
  }

  /** The regions version a batch sends: the plan's (reviewed), else Play's current one */
  private async baseRegionsVersion(ops: BasePriceOp[]): Promise<{ regionsVersion?: string }> {
    const recorded = ops.find((op) => op.options?.regionsVersion)?.options?.regionsVersion;
    const regionsVersion = recorded ?? (await this.fetchRegionsVersion());
    return regionsVersion ? { regionsVersion } : {};
  }

  batchKey(op: BasePriceOp): string {
    return productKey(op.target.product);
  }

  /** All ops of one product: price edits in one PATCH, then any region removals one by one. */
  async applyMany(ops: BasePriceOp[], _contexts: ApplyContext[]): Promise<Array<{ response?: OpResponse; error?: unknown }>> {
    const outcomes: Array<{ response?: OpResponse; error?: unknown }> = ops.map(() => ({}));
    const product = ops[0].target.product;
    if (product.platform !== 'google') throw new ApiError('Not a Google Play product', { status: 400, platform: 'google', retryable: false });
    if (ops.some((op) => productKey(op.target.product) !== productKey(product))) {
      throw new ApiError('applyMany needs ops for a single product', { status: 400, platform: 'google', retryable: false });
    }

    const sets = ops.map((op, i) => ({ op, i })).filter(({ op }) => op.kind === 'setPrice');
    for (const { op, i } of ops.map((op, i) => ({ op, i }))) {
      if (op.kind !== 'setPrice' && op.kind !== 'removePrice') {
        outcomes[i] = { error: new ApiError(`${op.kind} is not supported on Google Play`, { status: 422, code: 'UNSUPPORTED_OPERATION', platform: 'google', retryable: false }) };
      }
    }

    if (sets.length > 0) {
      try {
        if (product.type === 'subscription') {
          const version = await this.baseRegionsVersion(ops);
          const configs: RegionalBasePlanConfig[] = sets.map(({ op }) => ({
            regionCode: op.target.territory,
            price: toMoney(op.after!.currency, op.after!.amount),
          } as RegionalBasePlanConfig));
          await updateBasePlanPrices(this.credentials, this.packageName, product.productId, product.basePlanId, configs, this.ctx, version);
        } else {
          const prices: Record<string, Money> = {};
          for (const { op } of sets) prices[op.target.territory] = toMoney(op.after!.currency, op.after!.amount);
          await updateInAppProductPrices(this.credentials, this.packageName, product.productId, prices, undefined, this.ctx);
        }
        for (const { i } of sets) outcomes[i] = { response: { patchedRegions: sets.length } };
      } catch (error) {
        for (const { i } of sets) outcomes[i] = { error };
      }
    }

    for (const { op, i } of ops.map((op, i) => ({ op, i })).filter(({ op }) => op.kind === 'removePrice')) {
      try {
        if (product.type === 'subscription') {
          await deleteBasePlanRegionPrice(this.credentials, this.packageName, product.productId, product.basePlanId, op.target.territory, this.ctx, await this.baseRegionsVersion([op]));
        } else {
          await deleteRegionPrice(this.credentials, this.packageName, product.productId, op.target.territory, this.ctx);
        }
        outcomes[i] = { response: { removedRegion: op.target.territory } };
      } catch (error) {
        outcomes[i] = { error };
      }
    }
    return outcomes;
  }

  async apply(op: BasePriceOp, context: ApplyContext): Promise<OpResponse> {
    const [outcome] = await this.applyMany([op], [context]);
    if (outcome.error !== undefined) throw outcome.error;
    return outcome.response ?? {};
  }

  inverse(op: BasePriceOp) {
    return invertOp(op);
  }

  // -------------------------------------------------------------------------
  // Offers (reads)

  private identity(product: ProductRef): PlayOfferIdentity {
    return { packageName: this.packageName, ...basePlanRef(product) };
  }

  /** Every offer of a base plan, each read strictly (problems instead of guesses) */
  async fetchOffers(product: ProductRef): Promise<StoreOffer[]> {
    const { productId, basePlanId } = basePlanRef(product);
    const raw = await listSubscriptionOffers(this.credentials, this.packageName, productId, basePlanId, this.ctx);
    return raw.map((r) => parsePlayOffer(r, { productId, basePlanId }));
  }

  /** Every offer of a subscription, across its base plans (offers list with basePlanId "-") */
  async fetchSubscriptionOffers(productId: string): Promise<StoreOffer[]> {
    const raw = await listSubscriptionOffers(this.credentials, this.packageName, productId, '-', this.ctx);
    return raw.map((r) => parsePlayOffer(r, { productId }));
  }

  private async readBasePlan(product: ProductRef): Promise<{ subscription: Subscription; basePlan: BasePlan }> {
    const { productId, basePlanId } = basePlanRef(product);
    const subscription = await getSubscription(this.credentials, this.packageName, productId, this.ctx);
    const basePlan = subscription?.basePlans?.find((bp) => bp.basePlanId === basePlanId);
    if (!subscription || !basePlan) throw notFound(`Base plan ${productId}/${basePlanId} not found`);
    return { subscription, basePlan };
  }

  /** The base plan's billing period (ISO 8601). Only auto-renewing base plans can have offers. */
  async fetchBillingPeriod(product: ProductRef): Promise<string> {
    const { basePlan } = await this.readBasePlan(product);
    return billingPeriodOf(product, basePlan);
  }

  /**
   * The regionsVersion.version to send with offer creates and patches. Play's
   * subscription resource has no regionsVersion field (discovery document),
   * so it is read from a price conversion's regionVersion (one read-only
   * request, once per adapter). Undefined when Play doesn't report one.
   */
  async fetchRegionsVersion(): Promise<string | undefined> {
    this.regionsVersionRead ??= convertRegionPrices(this.credentials, this.packageName, { currencyCode: 'USD', units: '1' }, this.ctx).then(
      (r) => (typeof r?.regionVersion?.version === 'string' && r.regionVersion.version ? r.regionVersion.version : undefined)
    );
    try {
      return await this.regionsVersionRead;
    } catch (error) {
      this.regionsVersionRead = undefined;
      throw error;
    }
  }

  /** Play's own prices for exact targets (convertRegionPrices), as a plan's `snapped` input */
  private async snap(product: ProductRef, targets: Record<string, { currency: string; amount: string }>): Promise<PlayRuleSnaps[string]> {
    if (Object.keys(targets).length === 0) return { resolved: {}, unresolved: {} };
    const result = await this.resolvePricePoints(product, targets);
    return {
      resolved: Object.fromEntries(Object.entries(result.resolved).map(([r, p]) => [r, { currency: p.currency, amount: p.amount }])),
      unresolved: result.unresolved,
    };
  }

  // -------------------------------------------------------------------------
  // Offer plans (reads only)

  /**
   * Plan Play offers from specs: for each base plan, its ownership, billing
   * period, base prices and offers are read once; percent-of-current targets
   * are priced with Play's conversion; the regions version comes from the
   * spec or from Play. Then every offer is planned (create, change, activate,
   * leave alone or refuse) into one ChangeSet. Reads only.
   */
  async planOffers(input: { app: AppRef; offers: OfferSpec[]; deviationThreshold?: string; id?: string; createdAt?: string; description?: string }): Promise<OfferPlan> {
    this.verifyApp(input.app);
    const cache = new Map<string, { billingPeriod: string; base: ProductPriceState; offers: StoreOffer[] }>();
    const inputs: PlayOfferPlanInput[] = [];
    for (const spec of input.offers) {
      const product = spec.productRef;
      const key = productKey(product);
      let data = cache.get(key);
      if (!data) {
        await this.verifyProduct(product);
        data = { billingPeriod: await this.fetchBillingPeriod(product), base: await this.fetchState(product), offers: await this.fetchOffers(product) };
        cache.set(key, data);
      }
      let snapped: PlayOfferPlanInput['snapped'];
      if (spec.pricing.type === 'percentOfCurrent') {
        const targets = playPercentTargets({ pricing: spec.pricing as PlayPhasePricing, phase: playSpecPhase(spec), billingPeriod: data.billingPeriod, base: data.base, territories: spec.territories });
        snapped = await this.snap(product, targets);
      }
      const regionsVersion = spec.play?.regionsVersion ?? (await this.fetchRegionsVersion());
      inputs.push({
        spec,
        billingPeriod: data.billingPeriod,
        base: data.base,
        existing: data.offers,
        ...(snapped ? { snapped } : {}),
        ...(regionsVersion ? { regionsVersion } : {}),
        ...(input.deviationThreshold ? { deviationThreshold: input.deviationThreshold } : {}),
      });
    }
    return planPlayOfferChanges({
      app: input.app,
      inputs,
      ...(input.id ? { id: input.id } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.description ? { description: input.description } : {}),
    });
  }

  /** Plan activating, deactivating or deleting one existing Play offer. Reads only. */
  async planOfferLifecycle(input: { app: AppRef; product: ProductRef; key: string; action: 'activate' | 'deactivate' | 'delete'; createdAt?: string; id?: string }): Promise<OfferPlan> {
    this.verifyApp(input.app);
    await this.verifyProduct(input.product);
    const existing = await this.fetchOffers(input.product);
    const regionsVersion = input.action === 'delete' ? await this.fetchRegionsVersion() : undefined;
    return planPlayOfferLifecycle({ ...input, existing, ...(regionsVersion ? { regionsVersion } : {}) });
  }

  // -------------------------------------------------------------------------
  // Sync from a rules file (reads only)

  /**
   * What sync needs for each base plan a rules file names with a
   * syncWithBase rule, each read once: ownership, billing period, base prices
   * (or the state a base plan was made against, from `states`) and the base
   * plan's offers. Reads only.
   */
  async readRuleProducts(rules: OfferRules, options: { states?: ProductPriceState[] } = {}): Promise<PlayRuleProduct[]> {
    this.verifyApp(rules.app);
    const active = rules.offers.filter((r) => r.syncWithBase);
    const out: PlayRuleProduct[] = [];
    for (const product of ruleProducts({ offers: active })) {
      await this.verifyProduct(product);
      const billingPeriod = await this.fetchBillingPeriod(product);
      const base = options.states?.find((s) => productKey(s.product) === productKey(product)) ?? (await this.fetchState(product));
      out.push({ product, billingPeriod, base, offers: await this.fetchOffers(product) });
    }
    return out;
  }

  private async snapRules(targets: ReturnType<typeof playRuleTargets>): Promise<PlayRuleSnaps> {
    const snaps: PlayRuleSnaps = {};
    for (const t of targets) snaps[playRuleKey(t.rule)] = await this.snap(t.rule.product, t.targets);
    return snaps;
  }

  /**
   * Plan keeping the rules file's syncWithBase Play offers in step: against
   * the target prices of `base` (a base-price plan, whose ops come first), or
   * today's prices. Percent-of-current offers are re-priced with Play's
   * conversion (about one request per region); relative discounts follow the
   * base price by themselves. Reads only.
   */
  async planOfferSync(input: { rules: OfferRules; base?: ChangeSet; states?: ProductPriceState[]; id?: string; createdAt?: string; description?: string }): Promise<OfferSyncPlan> {
    const products = await this.readRuleProducts(input.rules, input.states ? { states: input.states } : {});
    const projected = projectedPlayBases(products, input.base);
    const snaps = await this.snapRules(playRuleTargets(input.rules.offers, products, projected));
    const needsPatch = input.rules.offers.some((r) => r.syncWithBase && products.some((p) => productKey(p.product) === productKey(r.product) && findPlayRuleOffer(r, p.offers).length === 1));
    const regionsVersion = needsPatch ? await this.fetchRegionsVersion() : undefined;
    if (needsPatch && !regionsVersion) {
      throw new ApiError("Play reported no regions version, which offer patches need; nothing was planned", { status: 422, code: 'NO_REGIONS_VERSION', platform: 'google', retryable: false });
    }
    return planPlayOfferSync({
      app: input.rules.app,
      rules: input.rules.offers,
      products,
      snaps,
      ...(regionsVersion ? { regionsVersion } : {}),
      ...(input.base ? { base: input.base } : {}),
      ...(input.id ? { id: input.id } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.description ? { description: input.description } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Offer writes (called by the executor after it has checked the offer's state)

  /**
   * Most requests an offer op can send: a create is the POST, a re-read if
   * Play answers 409 (it may already exist), and the activation.
   */
  offerRequestsNeeded(op: AnyOfferOp, context: OfferApplyContext): number {
    if (!isPlayOfferOp(op)) return 1;
    if (op.kind !== 'createOffer') return 1;
    if (context.pending?.includes('activate')) return 1;
    return op.after?.state === 'ACTIVE' ? 3 : 2;
  }

  async applyOffer(op: AnyOfferOp, context: OfferApplyContext): Promise<OpResponse> {
    if (!isPlayOfferOp(op)) throw unsupported('The Play adapter applies Google Play offer ops only');
    try {
      return await this.applyPlayOffer(op, context);
    } catch (error) {
      throw explainPlayOfferRefusal(error, op);
    }
  }

  private async applyPlayOffer(op: PlayOfferOp, context: OfferApplyContext): Promise<OpResponse> {
    const id = this.identity(op.target.product);
    const offerId = op.target.offer.key;
    switch (op.kind) {
      case 'createOffer': {
        // What the run log records, so a resume and an undo know what may exist:
        //   createSent      the create POST went out (it may have taken effect whatever the answer)
        //   created         true once Play confirmed the offer exists
        //   activationSent  the activate POST went out
        //   activated       true / false (Play refused it) / 'unknown' (no answer)
        const after = op.after!;
        let record: Record<string, unknown> = context.pending?.includes('activate') ? { created: true } : {};
        if (!context.pending?.includes('activate')) {
          try {
            await createSubscriptionOffer(this.credentials, id, playOfferResource(id, after), op.regionsVersion!, this.ctx);
            record = { createSent: true, created: true };
          } catch (error) {
            // Creates retry 429 only, so a 409 means the offer existed before this request (an earlier
            // attempt took effect). Use it only if it is exactly this one.
            if (getErrorStatus(error) === 409) {
              const existing = await getSubscriptionOffer(this.credentials, id, offerId, this.ctx).catch(() => null);
              const read = existing ? parsePlayOffer(existing, id) : undefined;
              if (read?.play && (read.problems?.length ?? 0) === 0 && samePlayOfferContent(read.play.offer, after)) {
                record = { createSent: true, created: true, foundAfterConflict: true };
              }
            }
            if (!record.created) {
              // Whatever the status, the create may have applied: the next read (or a resume) decides
              Object.assign(error as object, { partialResponse: { createSent: true, activationSent: false } });
              throw error;
            }
          }
        }
        if (after.state === 'ACTIVE') {
          try {
            await setSubscriptionOfferActive(this.credentials, id, offerId, true, this.ctx);
          } catch (error) {
            // The draft exists. A refusal (4xx) means it is still a draft; no answer means it may be either.
            const status = getErrorStatus(error);
            const activated = status !== undefined && status < 500 ? false : 'unknown';
            Object.assign(error as object, { partialResponse: { ...record, activationSent: true, activated } });
            throw error;
          }
          return { ...record, activationSent: true, activated: true, regions: Object.keys(after.regions).length };
        }
        return { ...record, regions: Object.keys(after.regions).length };
      }
      case 'updateOffer':
      case 'updateOfferPrices': {
        const fields = changedPlayOfferFields(op.before!, op.after!);
        await patchSubscriptionOffer(this.credentials, id, playOfferResource(id, op.after!), fields, op.regionsVersion!, this.ctx);
        return { updateMask: fields.join(','), regions: changedPlayRegions(op.before!, op.after!).length };
      }
      case 'activateOffer':
      case 'deactivateOffer':
        await setSubscriptionOfferActive(this.credentials, id, offerId, op.kind === 'activateOffer', this.ctx);
        return { state: op.after!.state };
      case 'deleteOffer':
        try {
          await deleteSubscriptionOffer(this.credentials, id, offerId, this.ctx);
        } catch (error) {
          // Already gone (e.g. a retried delete whose first attempt took effect)
          if (getErrorStatus(error) === 404) return { deleted: offerId, alreadyGone: true };
          throw error;
        }
        return { deleted: offerId };
    }
  }
}

function billingPeriodOf(product: ProductRef, basePlan: BasePlan): string {
  const period = basePlan.autoRenewingBasePlanType?.billingPeriodDuration;
  const where = product.platform === 'google' && product.type === 'subscription' ? `${product.productId}/${product.basePlanId}` : '';
  if (!basePlan.autoRenewingBasePlanType) {
    throw unsupported(`Base plan ${where} doesn't renew automatically; Google Play allows offers on auto-renewing base plans only`);
  }
  if (!isPlayDuration(period)) {
    throw new ApiError(`Base plan ${where} has an unknown billing period ${JSON.stringify(period ?? null)}`, { status: 422, code: 'UNKNOWN_PERIOD', platform: 'google', retryable: false });
  }
  return period;
}

const PLAY_VERBS: Record<PlayOfferOp['kind'], string> = {
  createOffer: 'create',
  updateOffer: 'change',
  updateOfferPrices: 'change the prices of',
  activateOffer: 'activate',
  deactivateOffer: 'deactivate',
  deleteOffer: 'delete',
};

function playRefusalHint(op: PlayOfferOp, status: number | undefined): string | undefined {
  if (status !== 400 && status !== 409 && status !== 412 && status !== 422) return undefined;
  switch (op.kind) {
    case 'createOffer':
      return 'Check the offer ID is unused on this base plan (Play never reuses one), every region has a price, prices are at or above the region minimum, and the regions version is current';
    case 'updateOffer':
    case 'updateOfferPrices':
      return 'Play may not allow changing this field on an existing offer; check prices are at or above the region minimum and the regions version is current';
    case 'deleteOffer':
      return 'Google Play deletes only draft offers';
    default:
      return undefined;
  }
}

/**
 * Turn a Play refusal into an error that says which offer write was refused
 * and why, keeping the status and code (a spent budget stays
 * BUDGET_EXCEEDED, so the run stops) and anything written before it.
 */
export function explainPlayOfferRefusal(error: unknown, op: PlayOfferOp): unknown {
  if (isBudgetExceeded(error) || !(error instanceof ApiError) || error.code === 'UNSUPPORTED_OPERATION') return error;
  const hint = playRefusalHint(op, error.status);
  const explained = new ApiError(`Google Play refused to ${PLAY_VERBS[op.kind]} the Play offer "${op.target.offer.key}": ${error.message}${hint ? `. ${hint}.` : ''}`, {
    status: error.status,
    ...(error.code !== undefined ? { code: error.code } : {}),
    platform: 'google',
    retryable: error.retryable,
    details: error.details,
    cause: error,
  });
  const partial = (error as { partialResponse?: unknown }).partialResponse;
  if (partial) Object.assign(explained, { partialResponse: partial });
  return explained;
}
