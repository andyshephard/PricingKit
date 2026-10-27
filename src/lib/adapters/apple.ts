// AppleAdapter: App Store Connect behind the core's PlatformAdapter interface.
//
// Phase 1 covers subscription base prices (current and scheduled). In-app
// purchase prices and offers come later; the adapter refuses them clearly.

import {
  decimalEquals,
  invertOp,
  isDecimalString,
  normalizeDecimal,
  snapToPricePoints,
  type ApplyContext,
  type BasePriceOp,
  type OpResponse,
  type PlatformAdapter,
  type ProductPriceState,
  type ProductRef,
  type ResolveResult,
  type ResolveTarget,
  type SnapMode,
  type TerritoryPriceState,
} from '@/lib/pricing';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';
import {
  deleteSubscriptionPrice,
  getSubscriptionPrices,
  updateSubscriptionPrice,
} from '@/lib/apple-connect/subscriptions';
import {
  getSubscriptionPricePointEqualizations,
  listSubscriptionPricePointsByTerritory,
  type TerritoryPricePoint,
} from '@/lib/apple-connect/price-points';
import { alpha2ToAlpha3, alpha3ToAlpha2 } from '@/lib/apple-connect/territories';
import { ApiError, getErrorStatus } from '@/lib/utils/api-error';
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

  constructor(options: AppleAdapterOptions) {
    this.credentials = options.credentials;
    this.budget = options.budget;
  }

  private get ctx() {
    return { budget: this.budget };
  }

  async fetchState(product: ProductRef): Promise<ProductPriceState> {
    const id = subscriptionId(product);
    const { current, scheduled } = await getSubscriptionPrices(this.credentials, id, this.ctx);
    const territories: Record<string, TerritoryPriceState> = {};
    const warnings: string[] = [];

    const entry = (code: string, currency: string): TerritoryPriceState | undefined => {
      const alpha2 = toAlpha2(code);
      if (!alpha2) {
        warnings.push(`Ignored a price in unknown territory ${code}`);
        return undefined;
      }
      return (territories[alpha2] ??= { territory: alpha2, currency, current: null });
    };

    for (const [code, price] of Object.entries(current)) {
      if (!isDecimalString(price.customerPrice)) {
        warnings.push(`${code}: unreadable price ${JSON.stringify(price.customerPrice)}`);
        continue;
      }
      const t = entry(price.territoryCode || code, price.currency);
      if (!t) continue;
      t.current = {
        currency: price.currency,
        amount: normalizeDecimal(price.customerPrice),
        pricePointId: price.pricePointId,
        ...(isDecimalString(price.proceeds) ? { proceeds: normalizeDecimal(price.proceeds) } : {}),
      };
    }
    for (const [code, price] of Object.entries(scheduled)) {
      if (!isDecimalString(price.customerPrice) || !price.startDate) continue;
      const t = entry(price.territoryCode || code, price.currency);
      if (!t) continue;
      t.scheduled = {
        currency: price.currency,
        amount: normalizeDecimal(price.customerPrice),
        pricePointId: price.pricePointId,
        startDate: price.startDate,
        ...(isDecimalString(price.proceeds) ? { proceeds: normalizeDecimal(price.proceeds) } : {}),
      };
      if (price.subscriptionPriceId) t.refs = { scheduledPriceId: price.subscriptionPriceId };
    }

    return {
      product,
      capturedAt: new Date().toISOString(),
      territories,
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
        const created = await updateSubscriptionPrice(this.credentials, id, op.after!.pricePointId!, territory, undefined, preserve, this.ctx);
        return { createdPriceId: created.id ?? null };
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
        if (!scheduled || !priceId || !op.before || scheduled.pricePointId !== op.before.pricePointId || !decimalEquals(scheduled.amount, op.before.amount)) {
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
}
