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
//
// The "custom" strategy takes a per-territory multiplier table instead of an
// index: { "strategy": "custom", "base": {...}, "multipliers": { "IN": "0.4",
// "GB": "0.9" } }. A territory's price is the base price converted to its
// currency times multipliers[territory] / multipliers[base territory] (the
// base territory's multiplier defaults to 1). Without "territories" it prices
// the territories in the table. The CLI also reads the table from a CSV file
// ("multipliersFile", see src/cli/spec-file.ts).
//
// Phase 8 options:
// - "measure": "proceeds" makes a product's fixed or strategy targets mean
//   what the developer receives (net of tax and the store's commission)
//   rather than the customer price. Apple snaps to the price point with the
//   nearest proceeds; Google Play prices proceeds / (1 - commission) as the
//   tax-exclusive price ("commission", default "0.15").
// - "consent": the existing-subscriber rules (price-increase.ts) need the
//   billing period and the last increase; "maxIncreaseWithoutConsent": true
//   refuses a plan in which any territory would need subscribers' consent.
// - "pppStaleness" (ppp strategy): cap (default; skip PPP data older than
//   maxAgeYears) or inflate (carry it forward with the "cpi" ratios given).
// - "freshness": maximum ages of the reference data (freshness.ts); stale
//   data is a warning, or refuses the plan with "refuseStale".
//
// Phase 6: "baseTerritory" is per product. It is the territory a product's
// prices are anchored on (products of one app may use different ones), and a
// strategy target that leaves out base.territory takes it. There is no
// app-wide base territory anywhere in a spec. Fixed targets may also come
// from a prices CSV ("pricesFile", read by the CLI, see prices-csv.ts).

import { z } from 'zod';
import { appRefSchema, productRefSchema, type PlanSkip } from './changeset';
import { compareDecimal, decimalFromNumber, decimalToNumber, divideDecimal, isDecimalString, multiplyDecimal, normalizeDecimal, type Decimal } from './decimal';
import { isCalendarDate, type AppRef, type ProductPriceState, type ProductRef } from './model';
import type { ResolveTarget } from './adapter';
import { currencyScale } from './rounding';
import type { SnapMode } from './snap';
import { calculateRegionalPrice, MAX_MULTIPLIER, MIN_MULTIPLIER, type DynamicExchangeRates, type DynamicPPPData } from './strategies';
import type { TargetMeasure } from './adapter';
import { DEFAULT_PPP_MAX_AGE_YEARS, pppStalenessAdjustment, REFERENCE_DATA, REFERENCE_DATA_IDS, type ReferenceDataId } from './freshness';
import { getPricingIndexEntry } from './indexes/ppp';

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

/** Strategies a spec can name: the price-parity indexes, plain conversion, and "custom" (a per-territory multiplier table) */
export const SPEC_STRATEGIES = ['ppp', 'bigmac', 'netflix', 'direct', 'custom'] as const;
export type SpecStrategy = (typeof SPEC_STRATEGIES)[number];
/** Rounding before snapping (rounding.ts); "nearest-tier" needs a tier ladder, which snapping to store prices replaces */
export const SPEC_ROUNDINGS = ['none', 'nearest-99', 'round-up'] as const;
export type SpecRounding = (typeof SPEC_ROUNDINGS)[number];

export interface StrategyTargets {
  type: 'strategy';
  strategy: SpecStrategy;
  /**
   * The price in one territory every other price is derived from. Currency
   * defaults to the territory's current one. The territory defaults to the
   * product's own baseTerritory (filled in when the spec is parsed).
   */
  base: { territory: string; amount: Decimal; currency?: string };
  /** Default: "none" on the App Store (snapping picks the price point), "nearest-99" on Google Play */
  rounding?: SpecRounding;
  /** Territories to price (default: every territory the product is priced in now) */
  territories?: 'all' | string[];
  /** Units of each currency per US dollar; overrides the built-in fallback rates for those currencies */
  exchangeRates?: Record<string, Decimal>;
  /** The date of `exchangeRates` (YYYY-MM-DD), for the freshness check */
  exchangeRatesAsOf?: string;
  /** custom strategy: multiplier per territory, relative to the base territory (whose own defaults to 1) */
  multipliers?: Record<string, Decimal>;
  /** ppp strategy: what to do with PPP data older than maxAgeYears */
  pppStaleness?: {
    mode?: 'cap' | 'inflate';
    maxAgeYears?: number;
    /** inflate: CPI now / CPI in the PPP data year, per territory (the base territory included) */
    cpi?: Record<string, Decimal>;
  };
}

export interface SpecConsent {
  /** Refuse the plan if any territory's change would need existing subscribers' consent */
  maxIncreaseWithoutConsent?: boolean;
  /** The subscription's billing period (ISO 8601: P1W, P1M, P3M, P6M, P1Y) */
  billingPeriod?: string;
  /** When existing subscribers last saw a price increase (YYYY-MM-DD), for every territory or per territory */
  lastIncreaseAt?: string | Record<string, string>;
}

export interface PricingSpecProduct {
  product: ProductRef;
  /**
   * This product's base territory (alpha-2): the territory its prices are
   * anchored on. Per product, never app-wide. A strategy target without
   * base.territory uses it; when both are given they must agree.
   */
  baseTerritory?: string;
  targets: SpecTargets;
  /** Apple: how a target snaps to the territory's price points (default nearest). Play has no ladder; ignored there. */
  snap?: SnapMode;
  /** Apple: schedule the prices for this date (YYYY-MM-DD) instead of changing them now */
  startDate?: string;
  /** Allow prices for territories that have none yet (default false) */
  allowNewTerritories?: boolean;
  /** Apple: keep existing subscribers on their current price (default true) */
  preserveCurrentPrice?: boolean;
  /** What the target amounts mean: the customer price (default) or the developer's proceeds */
  measure?: TargetMeasure;
  /** Google Play: service fee assumed for proceeds, a fraction (default "0.15") */
  commission?: Decimal;
  /** Existing-subscriber rules: inputs and the no-consent guard */
  consent?: SpecConsent;
}

export interface SpecFreshness {
  /** Maximum age in days per reference data set (defaults: freshness.ts DEFAULT_MAX_AGE_DAYS) */
  maxAgeDays?: Partial<Record<ReferenceDataId, number>>;
  /** Refuse the plan when data it used is older than its maximum age (default: warn) */
  refuseStale?: boolean;
}

export interface PricingSpec {
  kind: typeof PRICING_SPEC_KIND;
  schemaVersion: typeof PRICING_SPEC_SCHEMA_VERSION;
  app: AppRef;
  description?: string;
  products: PricingSpecProduct[];
  freshness?: SpecFreshness;
}

const decimalSchema = z
  .string()
  .refine((v) => isDecimalString(v), { message: 'must be a plain decimal string such as "4.99"' })
  .transform((v) => normalizeDecimal(v));
const nonNegativeDecimal = decimalSchema.refine((v) => !v.startsWith('-'), { message: 'must not be negative' });
const territorySchema = z.string().regex(/^[A-Z]{2}$/, 'territory must be ISO 3166-1 alpha-2, e.g. "GB"');
const dateSchema = z.string().refine((v) => isCalendarDate(v), { message: 'must be a real date, YYYY-MM-DD' });
/** Custom multipliers: within [0.01, 10] (index multipliers are clamped to [0.1, 2]; a custom table may go further, not without limit) */
const multiplierSchema = z
  .string()
  .refine((v) => isDecimalString(v), { message: 'must be a plain decimal string such as "0.8"' })
  .transform((v) => normalizeDecimal(v))
  .refine((v) => !isDecimalString(v) || (compareDecimal(v, '0.01') >= 0 && compareDecimal(v, '10') <= 0), { message: 'must be from 0.01 to 10' });
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
      // territory may come from the product's baseTerritory (checked and filled in by specProductSchema / parsePricingSpec)
      base: z.object({ territory: territorySchema.optional(), amount: positiveDecimal, currency: currencySchema.optional() }).strict(),
      rounding: z.enum(SPEC_ROUNDINGS).optional(),
      territories: z.union([z.literal('all'), z.array(territorySchema).min(1)]).optional(),
      exchangeRates: z.record(currencySchema, positiveDecimal).optional(),
      exchangeRatesAsOf: dateSchema.optional(),
      multipliers: z.record(territorySchema, multiplierSchema).optional(),
      pppStaleness: z
        .object({
          mode: z.enum(['cap', 'inflate']).optional(),
          maxAgeYears: z.number().int().min(0).max(50).optional(),
          cpi: z.record(territorySchema, positiveDecimal).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((t, ctx) => {
      if (t.strategy === 'custom') {
        if (!t.multipliers || Object.keys(t.multipliers).length === 0) {
          ctx.addIssue({ code: 'custom', message: 'the custom strategy needs "multipliers" (territory -> multiplier) or, in the CLI, "multipliersFile"', path: ['multipliers'] });
        }
      } else if (t.multipliers) {
        ctx.addIssue({ code: 'custom', message: 'multipliers go with the custom strategy only', path: ['multipliers'] });
      }
      if (t.pppStaleness && t.strategy !== 'ppp') ctx.addIssue({ code: 'custom', message: 'pppStaleness goes with the ppp strategy only', path: ['pppStaleness'] });
      if (t.exchangeRatesAsOf && !t.exchangeRates) ctx.addIssue({ code: 'custom', message: 'exchangeRatesAsOf goes with exchangeRates', path: ['exchangeRatesAsOf'] });
    }),
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
    baseTerritory: territorySchema.optional(),
    targets: targetsSchema,
    snap: z.enum(['nearest', 'floor', 'ceil']).optional(),
    startDate: z.string().refine((v) => isCalendarDate(v), { message: 'startDate must be a real date, YYYY-MM-DD' }).optional(),
    allowNewTerritories: z.boolean().optional(),
    preserveCurrentPrice: z.boolean().optional(),
    measure: z.enum(['customerPrice', 'proceeds']).optional(),
    commission: decimalSchema
      .refine((v) => !isDecimalString(v) || (compareDecimal(v, '0') >= 0 && compareDecimal(v, '1') < 0), { message: 'must be a fraction from 0 up to 1, e.g. "0.15"' })
      .optional(),
    consent: z
      .object({
        maxIncreaseWithoutConsent: z.boolean().optional(),
        billingPeriod: z.string().regex(/^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?$/, 'billingPeriod must be an ISO 8601 period such as "P1M" or "P1Y"').optional(),
        lastIncreaseAt: z.union([dateSchema, z.record(territorySchema, dateSchema)]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.targets.type !== 'strategy') return;
    const t = entry.targets;
    // The base territory is per product: the target's own, else the product's
    const base = t.base.territory ?? entry.baseTerritory;
    if (!base) {
      ctx.addIssue({ code: 'custom', message: "a strategy target needs a base territory: give targets.base.territory or the product's baseTerritory (there is no app-wide default)", path: ['targets', 'base', 'territory'] });
      return;
    }
    if (t.base.territory && entry.baseTerritory && t.base.territory !== entry.baseTerritory) {
      ctx.addIssue({ code: 'custom', message: `targets.base.territory (${t.base.territory}) and the product's baseTerritory (${entry.baseTerritory}) differ; give one`, path: ['targets', 'base', 'territory'] });
    }
    if (t.strategy === 'custom' && t.multipliers && Array.isArray(t.territories)) {
      const missing = t.territories.filter((x) => !(x in t.multipliers!) && x !== base);
      if (missing.length > 0) ctx.addIssue({ code: 'custom', message: `no multiplier for ${missing.join(', ')}`, path: ['targets', 'territories'] });
    }
    if (t.pppStaleness?.mode === 'inflate' && !t.pppStaleness.cpi?.[base]) {
      ctx.addIssue({ code: 'custom', message: `the inflate policy needs cpi for the base territory ${base}`, path: ['targets', 'pppStaleness', 'cpi'] });
    }
  });

export const pricingSpecSchema = z
  .object({
    kind: z.literal(PRICING_SPEC_KIND),
    schemaVersion: z.literal(PRICING_SPEC_SCHEMA_VERSION),
    app: appRefSchema,
    description: z.string().optional(),
    products: z.array(specProductSchema).min(1),
    freshness: z
      .object({
        maxAgeDays: z.partialRecord(z.enum(REFERENCE_DATA_IDS), z.number().int().min(0)).optional(),
        refuseStale: z.boolean().optional(),
      })
      .strict()
      .optional(),
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
    if (entry.measure === 'proceeds' && entry.targets.type === 'percentOfCurrent') {
      problems.push(`${where}: measure "proceeds" works with fixed and strategy targets (a percent of the current price changes proceeds by about the same percent)`);
    }
    if (entry.commission !== undefined && entry.product.platform !== 'google') {
      problems.push(`${where}: commission is Google Play only (App Store price points report their own proceeds)`);
    }
    if (entry.consent?.billingPeriod === 'P') problems.push(`${where}: consent.billingPeriod is empty`);
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
  // A strategy target without base.territory takes the product's own (the schema checked one exists)
  for (const entry of spec.products) {
    if (entry.targets.type === 'strategy' && !entry.targets.base.territory) entry.targets.base.territory = entry.baseTerritory!;
  }
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
export function specTargets(entry: PricingSpecProduct, state: ProductPriceState, options: { now?: Date } = {}): SpecTargetResult {
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

  if (entry.targets.type === 'strategy') return strategyTargets(entry.targets, state, skip, targets, skipped, options.now ?? new Date());

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
  skipped: PlanSkip[],
  now: Date
): SpecTargetResult {
  const platform = state.product.platform;
  const baseState = state.territories[t.base.territory];
  const baseCurrency = t.base.currency ?? baseState?.current?.currency ?? (baseState?.currency || undefined);
  const custom = t.strategy === 'custom' ? (t.multipliers ?? {}) : undefined;
  // custom without a territory list prices the territories in its table
  const wanted =
    t.territories === undefined
      ? custom
        ? Object.keys(custom)
        : Object.keys(state.territories)
      : t.territories === 'all'
        ? Object.keys(state.territories)
        : t.territories;
  if (!baseCurrency) {
    for (const territory of [...new Set(wanted)].sort()) {
      skip(territory, 'INVALID_TARGET', `the base territory ${t.base.territory} has no price, so its currency is unknown; give base.currency`);
    }
    return { targets, skipped };
  }
  const rounding = t.rounding ?? (platform === 'apple' ? 'none' : 'nearest-99');
  const rates: DynamicExchangeRates | undefined = t.exchangeRates
    ? { base: 'USD', fetchedAt: t.exchangeRatesAsOf ?? '', rates: Object.fromEntries(Object.entries(t.exchangeRates).map(([c, r]) => [c, decimalToNumber(r)])) }
    : undefined;
  const baseAmount = decimalToNumber(t.base.amount);
  const warnings: Array<{ territory: string; message: string }> = [];

  // PPP data older than the policy allows: skip (cap) or inflate by relative CPI
  const ppp = t.strategy === 'ppp' ? pppAdjustments(t, now) : undefined;
  const baseMultiplier = custom ? decimalToNumber(custom[t.base.territory] ?? '1') : 1;

  for (const territory of [...new Set(wanted)].sort()) {
    const current = state.territories[territory];
    const currency = current?.currency || undefined;
    if (!currency) {
      skip(territory, 'NOT_CONFIGURED', 'territory has no price yet, so its currency is unknown');
      continue;
    }
    let customMultiplier: number | undefined;
    if (custom) {
      const m = custom[territory] ?? (territory === t.base.territory ? '1' : undefined);
      if (m === undefined) {
        skip(territory, 'NO_TARGET', `no multiplier for ${territory} in the custom table`);
        continue;
      }
      customMultiplier = decimalToNumber(m) / baseMultiplier;
    }
    let dynamicPPP: DynamicPPPData | undefined;
    if (ppp) {
      const adjustment = ppp(territory);
      if (!adjustment.ok) {
        skip(territory, 'STALE_REFERENCE_DATA', adjustment.reason);
        continue;
      }
      if (adjustment.stale) {
        const entry = getPricingIndexEntry(territory);
        const multiplier = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, entry.pppMultiplier * adjustment.factorRatio));
        dynamicPPP = { [territory]: { pppMultiplier: multiplier, minPrice: entry.minPrice, suggestedRounding: entry.suggestedRounding, source: 'static' } };
        warnings.push({ territory, message: adjustment.note });
      }
    }
    const price = calculateRegionalPrice(baseAmount, territory, t.strategy, rounding, customMultiplier, dynamicPPP, { [territory]: currency }, rates, baseCurrency, t.base.territory);
    if (price.error || !Number.isFinite(price.rawPrice) || price.rawPrice <= 0) {
      skip(territory, 'INVALID_TARGET', price.errorMessage ?? `the ${t.strategy} strategy gave no price`);
      continue;
    }
    targets[territory] = { currency, amount: normalizeDecimal(decimalFromNumber(price.rawPrice, currencyScale(currency))) };
    for (const message of price.warnings ?? []) warnings.push({ territory, message });
  }
  return { targets, skipped, ...(warnings.length > 0 ? { warnings } : {}) };
}

/** Per territory: may the static PPP data be used (and scaled by how much) under the spec's staleness policy? */
function pppAdjustments(t: StrategyTargets, now: Date) {
  const dataYear = REFERENCE_DATA.ppp.dataYear!;
  const policy = { mode: t.pppStaleness?.mode ?? 'cap', maxAgeYears: t.pppStaleness?.maxAgeYears ?? DEFAULT_PPP_MAX_AGE_YEARS };
  const cpi = t.pppStaleness?.cpi ?? {};
  const baseCpi = cpi[t.base.territory];
  return (territory: string) =>
    pppStalenessAdjustment(dataYear, now.getUTCFullYear(), policy, {
      ...(cpi[territory] ? { cpiRatio: decimalToNumber(cpi[territory]) } : {}),
      ...(baseCpi ? { baseCpiRatio: decimalToNumber(baseCpi) } : {}),
    });
}
