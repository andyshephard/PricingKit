// Pricing spec: the desired base prices, as a file (pricing as code).
//
// A spec names products and the base price each territory should have.
// `plan` reads the current state, turns the spec into per-territory targets
// (specTargets), snaps them to store prices through an adapter and diffs
// them into a ChangeSet. The spec never names price point IDs: those are
// resolved live when planning.
//
// Format v1 is JSON:
// {
//   "kind": "pricingkit.spec", "schemaVersion": 1,
//   "app": { "bundleId": "com.example.app" },
//   "products": [{
//     "product": { "platform": "apple", "type": "subscription", "id": "1234567890" },
//     "targets": { "type": "fixed", "prices": { "GB": "4.99", "US": { "amount": "5.99", "currency": "USD" } } },
//     "snap": "nearest"
//   }]
// }
//
// Targets: "fixed" (prices per territory), "percentOfCurrent" (each
// territory's current price times a percentage) or "strategy" (one base
// price spread to every territory by a price-parity strategy from
// strategies.ts: PPP, Big Mac or Netflix index, or plain currency
// conversion), e.g.
//   { "type": "strategy", "strategy": "ppp", "base": { "territory": "US", "amount": "9.99" },
//     "rounding": "nearest-99" }
// Strategy targets use the built-in indexes and, unless the spec gives
// "exchangeRates" (units of each currency per US dollar), the built-in
// fallback exchange rates, so a plan is reproducible offline.

import { z } from 'zod';
import { appRefSchema, productRefSchema, type PlanSkip } from './changeset';
import { compareDecimal, decimalFromNumber, decimalToNumber, divideDecimal, isDecimalString, multiplyDecimal, normalizeDecimal, type Decimal } from './decimal';
import type { AppRef, ProductPriceState, ProductRef } from './model';
import type { ResolveTarget } from './adapter';
import { currencyScale } from './rounding';
import type { SnapMode } from './snap';
import { calculateRegionalPrice, type DynamicExchangeRates } from './strategies';

export const PRICING_SPEC_KIND = 'pricingkit.spec' as const;
export const PRICING_SPEC_SCHEMA_VERSION = 1 as const;

/** A price in the territory's own currency. A bare amount takes the currency the territory is priced in now. */
export type SpecPrice = Decimal | { amount: Decimal; currency: string };

export type SpecTargets =
  /** These territories get exactly these prices (before snapping) */
  | { type: 'fixed'; prices: Record<string, SpecPrice> }
  /** Each territory's current price times percent/100 ("110" = a 10% rise) */
  | { type: 'percentOfCurrent'; percent: Decimal; territories?: 'all' | string[] }
  /** One base price spread to each territory by a pricing strategy (strategies.ts) */
  | StrategyTargets;

/** Strategies a spec can name: the price-parity indexes and plain conversion ("custom" needs per-territory multipliers, not yet supported) */
export const SPEC_STRATEGIES = ['ppp', 'bigmac', 'netflix', 'direct'] as const;
export type SpecStrategy = (typeof SPEC_STRATEGIES)[number];
/** Rounding before snapping (rounding.ts); "nearest-tier" needs a tier ladder, which snapping to store prices replaces */
export const SPEC_ROUNDINGS = ['none', 'nearest-99', 'round-up'] as const;
export type SpecRounding = (typeof SPEC_ROUNDINGS)[number];

export interface StrategyTargets {
  type: 'strategy';
  strategy: SpecStrategy;
  /** The price in one territory every other price is derived from. Currency defaults to the territory's current one. */
  base: { territory: string; amount: Decimal; currency?: string };
  /** Default: "none" on the App Store (snapping picks the price point), "nearest-99" on Google Play */
  rounding?: SpecRounding;
  /** Territories to price (default: every territory the product is priced in now) */
  territories?: 'all' | string[];
  /** Units of each currency per US dollar; overrides the built-in fallback rates for those currencies */
  exchangeRates?: Record<string, Decimal>;
}

export interface PricingSpecProduct {
  product: ProductRef;
  targets: SpecTargets;
  /** Apple: how a target snaps to the territory's price points (default nearest). Play has no ladder; ignored there. */
  snap?: SnapMode;
  /** Apple: schedule the prices for this date (YYYY-MM-DD) instead of changing them now */
  startDate?: string;
  /** Allow prices for territories that have none yet (default false) */
  allowNewTerritories?: boolean;
  /** Apple: keep existing subscribers on their current price (default true) */
  preserveCurrentPrice?: boolean;
}

export interface PricingSpec {
  kind: typeof PRICING_SPEC_KIND;
  schemaVersion: typeof PRICING_SPEC_SCHEMA_VERSION;
  app: AppRef;
  description?: string;
  products: PricingSpecProduct[];
}

const decimalSchema = z
  .string()
  .refine((v) => isDecimalString(v), { message: 'must be a plain decimal string such as "4.99"' })
  .transform((v) => normalizeDecimal(v));
const nonNegativeDecimal = decimalSchema.refine((v) => !v.startsWith('-'), { message: 'must not be negative' });
const territorySchema = z.string().regex(/^[A-Z]{2}$/, 'territory must be ISO 3166-1 alpha-2, e.g. "GB"');
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'currency must be ISO 4217, e.g. "EUR"');

const specPriceSchema = z.union([
  nonNegativeDecimal,
  z.object({ amount: nonNegativeDecimal, currency: currencySchema }).strict(),
]);

const positiveDecimal = decimalSchema.refine((v) => !isDecimalString(v) || compareDecimal(v, '0') > 0, { message: 'must be above 0' });

const targetsSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('strategy'),
      strategy: z.enum(SPEC_STRATEGIES),
      base: z.object({ territory: territorySchema, amount: positiveDecimal, currency: currencySchema.optional() }).strict(),
      rounding: z.enum(SPEC_ROUNDINGS).optional(),
      territories: z.union([z.literal('all'), z.array(territorySchema).min(1)]).optional(),
      exchangeRates: z.record(currencySchema, positiveDecimal).optional(),
    })
    .strict(),
  z.object({ type: z.literal('fixed'), prices: z.record(territorySchema, specPriceSchema) }).strict(),
  z
    .object({
      type: z.literal('percentOfCurrent'),
      percent: decimalSchema,
      territories: z.union([z.literal('all'), z.array(territorySchema).min(1)]).optional(),
    })
    .strict()
    // A malformed percent is already reported by decimalSchema; only range-check a real decimal
    .refine((t) => !isDecimalString(t.percent) || (compareDecimal(t.percent, '0') > 0 && compareDecimal(t.percent, '1000') <= 0), {
      message: 'percent must be above 0 and at most 1000',
      path: ['percent'],
    })
    .refine((t) => !isDecimalString(t.percent) || (t.percent.split('.')[1]?.length ?? 0) <= 4, { message: 'percent may have at most 4 decimal places', path: ['percent'] }),
]);

const specProductSchema = z
  .object({
    product: productRefSchema,
    targets: targetsSchema,
    snap: z.enum(['nearest', 'floor', 'ceil']).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be a date, YYYY-MM-DD').optional(),
    allowNewTerritories: z.boolean().optional(),
    preserveCurrentPrice: z.boolean().optional(),
  })
  .strict();

export const pricingSpecSchema = z
  .object({
    kind: z.literal(PRICING_SPEC_KIND),
    schemaVersion: z.literal(PRICING_SPEC_SCHEMA_VERSION),
    app: appRefSchema,
    description: z.string().optional(),
    products: z.array(specProductSchema).min(1),
  })
  .strict();

export class PricingSpecError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid pricing spec:\n- ${issues.join('\n- ')}`);
    this.name = 'PricingSpecError';
  }
}

function productLabel(ref: ProductRef): string {
  if (ref.platform === 'apple') return `apple ${ref.type} ${ref.id}`;
  return ref.type === 'subscription' ? `google subscription ${ref.productId}/${ref.basePlanId}` : `google inapp ${ref.productId}`;
}

/** Rules the schema can't express. Returns problems; empty means valid. */
function checkSpecRules(spec: PricingSpec): string[] {
  const problems: string[] = [];
  const platform = 'bundleId' in spec.app ? 'apple' : 'google';
  const seen = new Set<string>();
  spec.products.forEach((entry, index) => {
    const where = `products.${index} (${productLabel(entry.product)})`;
    const key = JSON.stringify(entry.product);
    if (seen.has(key)) problems.push(`${where}: the product is listed twice`);
    seen.add(key);
    const storeName = (p: string) => (p === 'apple' ? 'App Store' : 'Google Play');
    if (entry.product.platform !== platform) problems.push(`${where}: a ${storeName(entry.product.platform)} product, but the spec is for an app on ${storeName(platform)}`);
    if (entry.product.platform === 'apple' && entry.product.type !== 'subscription') {
      problems.push(`${where}: Apple in-app purchase prices aren't supported by the planner yet`);
    }
    if (entry.startDate && entry.product.platform !== 'apple') problems.push(`${where}: startDate (scheduled prices) is Apple-only`);
    if (entry.targets.type === 'fixed' && Object.keys(entry.targets.prices).length === 0) {
      problems.push(`${where}: targets.prices is empty`);
    }
  });
  return problems;
}

/** Parse and validate a pricing spec from JSON text or a parsed object. */
export function parsePricingSpec(input: string | unknown): PricingSpec {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new PricingSpecError(['not valid JSON']);
    }
  }
  const result = pricingSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new PricingSpecError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const spec = result.data as PricingSpec;
  const problems = checkSpecRules(spec);
  if (problems.length > 0) throw new PricingSpecError(problems);
  return spec;
}

export interface SpecTargetResult {
  /** Unsnapped targets, keyed by alpha-2 territory */
  targets: Record<string, ResolveTarget>;
  /** Territories the spec names that get no target, and why */
  skipped: PlanSkip[];
  /** Strategy targets: the strategy's own notes per territory (e.g. a minimum price not enforced) */
  warnings?: Array<{ territory: string; message: string }>;
}

/**
 * Turn one spec entry into unsnapped per-territory targets against the
 * product's current state. Pure: no store access. A percent target on Apple
 * keeps the exact fraction (snapping happens against the price points); on
 * Play it is rounded to the currency's minor unit, since Play takes the
 * amount as given.
 */
export function specTargets(entry: PricingSpecProduct, state: ProductPriceState): SpecTargetResult {
  const product = state.product;
  const targets: Record<string, ResolveTarget> = {};
  const skipped: PlanSkip[] = [];
  const skip = (territory: string, reason: PlanSkip['reason'], detail: string) => skipped.push({ product, territory, reason, detail });

  if (entry.targets.type === 'fixed') {
    for (const territory of Object.keys(entry.targets.prices).sort()) {
      const price = entry.targets.prices[territory];
      const known = state.territories[territory]?.currency || undefined;
      const amount = typeof price === 'string' ? price : price.amount;
      const currency = typeof price === 'string' ? known : price.currency;
      if (!currency) {
        skip(territory, 'INVALID_TARGET', 'territory has no price yet, so its currency is unknown; give { "amount", "currency" }');
        continue;
      }
      targets[territory] = { currency, amount };
    }
    return { targets, skipped };
  }

  if (entry.targets.type === 'strategy') return strategyTargets(entry.targets, state, skip, targets, skipped);

  const { percent } = entry.targets;
  const wanted =
    entry.targets.territories === undefined || entry.targets.territories === 'all'
      ? Object.keys(state.territories)
      : entry.targets.territories;
  for (const territory of [...new Set(wanted)].sort()) {
    const current = state.territories[territory];
    if (current?.problems?.current) {
      skip(territory, 'AMBIGUOUS_STATE', `current price can't be read unambiguously: ${current.problems.current}`);
      continue;
    }
    if (!current?.current) {
      skip(territory, 'NOT_CONFIGURED', 'territory has no current price to scale');
      continue;
    }
    const scaled = multiplyDecimal(current.current.amount, percent);
    const scale = product.platform === 'apple' ? 8 : currencyScale(current.current.currency);
    targets[territory] = { currency: current.current.currency, amount: normalizeDecimal(divideDecimal(scaled, '100', scale)) };
  }
  return { targets, skipped };
}

/**
 * Strategy targets: the base price spread to each territory with
 * calculateRegionalPrice (the same maths as the web app's bulk pricing),
 * in the currency the territory is priced in now. A territory with no
 * price yet has no known currency and is skipped; so is one the strategy
 * can't price (no exchange rate).
 */
function strategyTargets(
  t: StrategyTargets,
  state: ProductPriceState,
  skip: (territory: string, reason: PlanSkip['reason'], detail: string) => void,
  targets: Record<string, ResolveTarget>,
  skipped: PlanSkip[]
): SpecTargetResult {
  const platform = state.product.platform;
  const baseState = state.territories[t.base.territory];
  const baseCurrency = t.base.currency ?? baseState?.current?.currency ?? (baseState?.currency || undefined);
  const wanted = t.territories === undefined || t.territories === 'all' ? Object.keys(state.territories) : t.territories;
  if (!baseCurrency) {
    for (const territory of [...new Set(wanted)].sort()) {
      skip(territory, 'INVALID_TARGET', `the base territory ${t.base.territory} has no price, so its currency is unknown; give base.currency`);
    }
    return { targets, skipped };
  }
  const rounding = t.rounding ?? (platform === 'apple' ? 'none' : 'nearest-99');
  const rates: DynamicExchangeRates | undefined = t.exchangeRates
    ? { base: 'USD', fetchedAt: '', rates: Object.fromEntries(Object.entries(t.exchangeRates).map(([c, r]) => [c, decimalToNumber(r)])) }
    : undefined;
  const baseAmount = decimalToNumber(t.base.amount);
  const warnings: Array<{ territory: string; message: string }> = [];
  for (const territory of [...new Set(wanted)].sort()) {
    const current = state.territories[territory];
    const currency = current?.currency || undefined;
    if (!currency) {
      skip(territory, 'NOT_CONFIGURED', 'territory has no price yet, so its currency is unknown');
      continue;
    }
    const price = calculateRegionalPrice(baseAmount, territory, t.strategy, rounding, undefined, undefined, { [territory]: currency }, rates, baseCurrency, t.base.territory);
    if (price.error || !Number.isFinite(price.rawPrice) || price.rawPrice <= 0) {
      skip(territory, 'INVALID_TARGET', price.errorMessage ?? `the ${t.strategy} strategy gave no price`);
      continue;
    }
    targets[territory] = { currency, amount: normalizeDecimal(decimalFromNumber(price.rawPrice, currencyScale(currency))) };
    for (const message of price.warnings ?? []) warnings.push({ territory, message });
  }
  return { targets, skipped, ...(warnings.length > 0 ? { warnings } : {}) };
}
