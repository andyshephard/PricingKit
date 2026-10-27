// PlayAdapter: Google Play Developer API behind the core's PlatformAdapter
// interface. Covers base plan regional prices and one-time product prices.
// All ops on one product are written in a single PATCH (batchKey/applyMany),
// which changes only the regions named; everything else is sent back as fetched.

import {
  decimalToMoney,
  deviationRatio,
  divideDecimal,
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
} from '@/lib/pricing';
import type { Money, RegionalBasePlanConfig, ServiceAccountCredentials } from '@/lib/google-play/types';
import { deleteBasePlanRegionPrice, getSubscription, updateBasePlanPrices } from '@/lib/google-play/subscriptions';
import { deleteRegionPrice, getInAppProductRaw, updateInAppProductPrices } from '@/lib/google-play/products';
import { convertRegionPrices, type ConvertRegionPricesResponse } from '@/lib/google-play/pricing';
import { ApiError } from '@/lib/utils/api-error';
import type { RequestBudget } from '@/lib/utils/request-budget';

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

export class PlayAdapter implements PlatformAdapter {
  readonly platform = 'google' as const;
  private readonly credentials: ServiceAccountCredentials;
  private readonly packageName: string;
  private readonly budget?: RequestBudget;

  constructor(options: PlayAdapterOptions) {
    this.credentials = options.credentials;
    this.packageName = options.packageName;
    this.budget = options.budget;
  }

  private get ctx() {
    return { budget: this.budget };
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
   * price and returns tax-inclusive regional prices, so: one call learns each
   * region's tax share, then each target is converted back to tax-exclusive
   * and run through Play once more. Requests: 1 + one per distinct target.
   * Play has no price ladder, so snap modes don't apply.
   */
  async resolvePricePoints(product: ProductRef, targets: Record<string, ResolveTarget>): Promise<ResolveResult> {
    if (product.platform !== 'google') throw new ApiError('Not a Google Play product', { status: 400, platform: 'google', retryable: false });
    const result: ResolveResult = { resolved: {}, unresolved: {} };
    const entries = Object.entries(targets).filter(([territory, target]) => {
      if (isDecimalString(target.amount)) return true;
      result.unresolved[territory] = `Invalid amount ${JSON.stringify(target.amount)}`;
      return false;
    });
    if (entries.length === 0) return result;

    const convert = (currency: string, amount: string) =>
      convertRegionPrices(this.credentials, this.packageName, toMoney(currency, amount), this.ctx);

    // 1. Tax share per region, from any one conversion
    const [, firstTarget] = entries[0];
    const probe = await convert(firstTarget.currency, normalizeDecimal(firstTarget.amount));

    // 2. Convert each distinct tax-exclusive target
    const cache = new Map<string, Promise<ConvertRegionPricesResponse>>();
    for (const [territory, target] of entries) {
      const probed = probe.convertedRegionPrices?.[territory];
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
      const amount = normalizeDecimal(target.amount);
      const net = subtractDecimal(gross, tax);
      // The tax-exclusive input that should come back as `amount`: amount * net / gross
      const exclusive = isZeroDecimal(gross) ? amount : divideDecimal(multiplyDecimal(amount, net), gross, currencyScale(target.currency));
      const key = `${target.currency} ${exclusive}`;
      if (!cache.has(key)) cache.set(key, convert(target.currency, exclusive));
      const converted = (await cache.get(key)!).convertedRegionPrices?.[territory];
      const snapped = moneyDecimal(converted?.price);
      if (!converted || snapped === undefined || converted.price.currencyCode !== target.currency) {
        result.unresolved[territory] = `Play returned no usable price for ${territory}`;
        continue;
      }
      result.resolved[territory] = {
        currency: target.currency,
        amount: snapped,
        target: amount,
        deviation: subtractDecimal(snapped, amount),
        deviationRatio: deviationRatio(amount, snapped),
      };
    }
    return result;
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
          const configs: RegionalBasePlanConfig[] = sets.map(({ op }) => ({
            regionCode: op.target.territory,
            price: toMoney(op.after!.currency, op.after!.amount),
          } as RegionalBasePlanConfig));
          await updateBasePlanPrices(this.credentials, this.packageName, product.productId, product.basePlanId, configs, this.ctx);
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
          await deleteBasePlanRegionPrice(this.credentials, this.packageName, product.productId, product.basePlanId, op.target.territory, this.ctx);
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
}
