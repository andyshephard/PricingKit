// AppleAdapter: App Store Connect behind the core's PlatformAdapter interface.
//
// Phase 1 covers subscription base prices (current and scheduled). In-app
// purchase prices and offers come later; the adapter refuses them clearly.

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
  type PlatformAdapter,
  type ProductPriceState,
  type ProductRef,
  type ResolveResult,
  type ResolveTarget,
  type SnapMode,
  type TerritoryPriceState,
} from '@/lib/pricing';
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

  constructor(options: AppleAdapterOptions) {
    this.credentials = options.credentials;
    this.budget = options.budget;
    this.now = options.now;
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
}
