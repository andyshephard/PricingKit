// Price changes and existing subscribers: which territory changes reach
// people already subscribed, and which need their consent.
//
// Every base-price op of a plan is classified (plans and `pricingkit diff`
// show it per territory):
//   decrease                              the price goes down
//   unchanged                             same amount (e.g. another price point at the same price)
//   new-price                             the territory had no price
//   increase-to-new-subscribers-only      existing subscribers keep their price
//                                         (App Store preserveCurrentPrice, or any
//                                         Google Play base plan edit: see below)
//   increase-within-no-consent-threshold  existing subscribers are notified, no consent needed
//   increase-needs-consent                existing subscribers must agree, or their
//                                         subscription expires at the end of the period
//   one-time-product                      not a subscription: nobody to notify
//
// RULES AND SOURCES (retrieved 2026-10-27; re-check before relying on them):
//
// App Store: "Manage pricing for auto-renewable subscriptions", App Store Connect Help,
// https://developer.apple.com/help/app-store-connect/manage-subscriptions/manage-pricing-for-auto-renewable-subscriptions
//  A1 Consent is needed if ANY of these applies (quoted): "The subscriber is located in a
//     region that requires consent for any price changes." / "The price increase is more
//     than 50% of the current price and the difference in price exceeds approximately
//     US$5 per period for non-annual subscriptions, or US$50 per year for annual
//     subscriptions." / "The subscriber experienced a price increase for that subscription
//     within the past 12 months." Otherwise subscribers are notified, no consent.
//  A2 Per-storefront thresholds in local currency, and the storefronts where consent is
//     always required (Austria, Germany, Poland, Republic of Korea): "Auto-renewable
//     subscription price increase thresholds",
//     https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/auto-renewable-subscription-price-increase-thresholds
//     transcribed below (175 storefronts). Apple: "These thresholds are subject to change
//     based on changes in tax or foreign exchange rates", and whether consent is needed is
//     judged "when the renewal occurs", so a scheduled increase can change class.
//  A3 Decreases: "existing subscriptions will automatically renew at the lower price. You
//     don't have the option to preserve the higher price for existing subscribers."
//  A4 Preserving prices ("Keep the current price for existing subscribers") leaves current
//     subscribers on their price; only new subscribers pay the new one. PricingKit sends
//     this as preserveCurrentPrice (default true).
//  NOT ENCODED / UNCONFIRMED: the 12-month rule needs the subscription's price history,
//     which PricingKit can't read (give consent.lastIncreaseAt, else it is assumed that
//     there was no increase); multiseat purchases (other criteria); subscribers still on
//     an introductory or promotional offer (renew once more at the old price); local-law
//     cases Apple describes separately (India UPI AutoPay, South Korea offer conversions);
//     whether the API ignores preserveCurrentPrice on a decrease, as the UI does (assumed);
//     storefronts missing from Apple's table (Bangladesh, Monaco, Samoa) are treated as
//     needing consent.
//
// Google Play: "Understanding subscriptions" / price changes, Play Console Help,
// https://support.google.com/googleplay/android-developer/answer/12154973
//  G1 Changing a base plan's price applies to new purchases: "existing subscribers move
//     into a legacy cohort and keep paying their current price" until the developer ends
//     the legacy pricing (migrates the cohort; PricingKit can't do that yet). So every
//     Play base-price change is new-subscribers-only, decreases included; `ifMigrated`
//     says what migrating that cohort would need:
//  G2 Decreases: "automatic and need no user approval" (no-consent).
//  G3 Opt-out increases (notice, no consent) only if: the country allows them, the
//     developer is in good standing, at most one per base plan and country in 365 days,
//     and the increase is at most "the greater of: 50% of the price the user is currently
//     paying; or 17 USD cents per day (converted to local currency as needed)"; plus a
//     30- or 60-day notice and an in-app notice. Otherwise opt-in (users must accept).
//  NOT ENCODED / UNCONFIRMED: which countries allow opt-out increases (Play lists them on
//     a separate page; not checked), developer standing, the in-app notice. "Per day" is
//     computed with 7 days a week, 30 a month and 365 a year. Without a billing period
//     only the 50% limit is used (the stricter reading). Converting 17 US cents uses the
//     spec's exchange rates, else the built-in fallback rates.
//
// Framework-free: pure functions.

import { alpha2ToAlpha3 } from '../apple-connect/territories';
import { compareDecimal, decimalFromNumber, divideDecimal, isZeroDecimal, multiplyDecimal, subtractDecimal, type Decimal } from './decimal';
import { FALLBACK_EXCHANGE_RATES } from './indexes/exchange-rates';
import { isCalendarDate, type Platform, type PriceValue } from './model';

export const APPLE_PRICE_INCREASE_RULES_URL =
  'https://developer.apple.com/help/app-store-connect/manage-subscriptions/manage-pricing-for-auto-renewable-subscriptions';
export const APPLE_PRICE_INCREASE_THRESHOLDS_URL =
  'https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/auto-renewable-subscription-price-increase-thresholds';
export const PLAY_PRICE_CHANGE_RULES_URL = 'https://support.google.com/googleplay/android-developer/answer/12154973';
/** When the rules and the threshold table were last read from the sources above */
export const PRICE_INCREASE_RULES_RETRIEVED = '2026-10-27';

/**
 * App Store storefront (alpha-3) -> 'consent' (any increase needs consent) or
 * [currency, non-annual threshold, annual threshold] in local currency (A2).
 */
export const APPLE_PRICE_INCREASE_THRESHOLDS: Record<string, 'consent' | readonly [string, string, string]> = {
  AFG: ['USD', '5', '50'], ALB: ['USD', '6', '60'], DZA: ['USD', '5', '50'], AGO: ['USD', '5', '50'],
  AIA: ['USD', '5', '50'], ATG: ['USD', '5', '50'], ARG: ['USD', '5', '50'], ARM: ['USD', '6', '60'],
  AUS: ['AUD', '8', '80'], AUT: 'consent', AZE: ['USD', '6', '60'], BHS: ['USD', '5', '50'],
  BHR: ['USD', '5', '50'], BRB: ['USD', '6', '60'], BLR: ['USD', '6', '60'], BEL: ['EUR', '5', '50'],
  BLZ: ['USD', '5', '50'], BEN: ['USD', '6', '60'], BMU: ['USD', '5', '50'], BTN: ['USD', '5', '50'],
  BOL: ['USD', '5', '50'], BIH: ['EUR', '5', '50'], BWA: ['USD', '5', '50'], BRA: ['BRL', '40', '400'],
  VGB: ['USD', '5', '50'], BRN: ['USD', '5', '50'], BGR: ['EUR', '5', '50'], BFA: ['USD', '5', '50'],
  KHM: ['USD', '5', '50'], CMR: ['USD', '6', '60'], CAN: ['CAD', '7', '70'], CPV: ['USD', '5', '50'],
  CYM: ['USD', '5', '50'], TCD: ['USD', '5', '50'], CHL: ['CLP', '7000', '70000'], CHN: ['CNY', '40', '400'],
  COL: ['COP', '25000', '250000'], COD: ['USD', '5', '50'], COG: ['USD', '5', '50'], CRI: ['USD', '5', '50'],
  CIV: ['USD', '6', '60'], HRV: ['EUR', '5', '50'], CYP: ['EUR', '5', '50'], CZE: ['CZK', '150', '1500'],
  DNK: ['DKK', '45', '450'], DMA: ['USD', '5', '50'], DOM: ['USD', '5', '50'], ECU: ['USD', '5', '50'],
  EGY: ['EGP', '400', '4000'], SLV: ['USD', '5', '50'], EST: ['EUR', '5', '50'], FJI: ['USD', '5', '50'],
  FIN: ['EUR', '5', '50'], FRA: ['EUR', '5', '50'], GAB: ['USD', '5', '50'], GMB: ['USD', '5', '50'],
  GEO: ['USD', '6', '60'], DEU: 'consent', GHA: ['USD', '6', '60'], GRC: ['EUR', '5', '50'],
  GRD: ['USD', '5', '50'], GTM: ['USD', '5', '50'], GNB: ['USD', '5', '50'], GUY: ['USD', '5', '50'],
  HND: ['USD', '5', '50'], HKG: ['HKD', '40', '400'], HUN: ['HUF', '2500', '25000'], ISL: ['EUR', '5', '50'],
  IND: ['INR', '500', '5000'], IDN: ['IDR', '100000', '1000000'], IRQ: ['USD', '5', '50'], IRL: ['EUR', '5', '50'],
  ISR: ['ILS', '20', '200'], ITA: ['EUR', '5', '50'], JAM: ['USD', '5', '50'], JPN: ['JPY', '800', '8000'],
  JOR: ['USD', '5', '50'], KAZ: ['KZT', '3000', '30000'], KEN: ['USD', '6', '60'], XKS: ['EUR', '5', '50'],
  KWT: ['USD', '5', '50'], KGZ: ['USD', '5', '50'], LAO: ['USD', '5', '50'], LVA: ['EUR', '5', '50'],
  LBN: ['USD', '5', '50'], LBR: ['USD', '5', '50'], LBY: ['USD', '5', '50'], LTU: ['EUR', '5', '50'],
  LUX: ['EUR', '5', '50'], MAC: ['USD', '5', '50'], MDG: ['USD', '5', '50'], MWI: ['USD', '5', '50'],
  MYS: ['MYR', '25', '250'], MDV: ['USD', '5', '50'], MLI: ['USD', '5', '50'], MLT: ['EUR', '5', '50'],
  MRT: ['USD', '5', '50'], MUS: ['USD', '5', '50'], MEX: ['MXN', '150', '1500'], FSM: ['USD', '5', '50'],
  MDA: ['USD', '6', '60'], MNG: ['USD', '5', '50'], MNE: ['EUR', '5', '50'], MSR: ['USD', '5', '50'],
  MAR: ['USD', '5', '50'], MOZ: ['USD', '5', '50'], MMR: ['USD', '5', '50'], NAM: ['USD', '5', '50'],
  NRU: ['USD', '5', '50'], NPL: ['USD', '6', '60'], NLD: ['EUR', '5', '50'], NZL: ['NZD', '10', '100'],
  NIC: ['USD', '5', '50'], NER: ['USD', '5', '50'], NGA: ['NGN', '12000', '120000'], MKD: ['USD', '5', '50'],
  NOR: ['NOK', '60', '600'], OMN: ['USD', '5', '50'], PAK: ['PKR', '1200', '12000'], PLW: ['USD', '5', '50'],
  PAN: ['USD', '5', '50'], PNG: ['USD', '5', '50'], PRY: ['USD', '5', '50'], PER: ['PEN', '25', '250'],
  PHL: ['PHP', '300', '3000'], POL: 'consent', PRT: ['EUR', '5', '50'], QAT: ['QAR', '20', '200'],
  KOR: 'consent', ROU: ['RON', '30', '300'], RUS: ['RUB', '600', '6000'], RWA: ['USD', '5', '50'],
  STP: ['USD', '5', '50'], SAU: ['SAR', '20', '200'], SEN: ['USD', '6', '60'], SRB: ['EUR', '5', '50'],
  SYC: ['USD', '5', '50'], SLE: ['USD', '5', '50'], SGP: ['SGD', '7', '70'], SVK: ['EUR', '5', '50'],
  SVN: ['EUR', '5', '50'], SLB: ['USD', '5', '50'], ZAF: ['ZAR', '100', '1000'], ESP: ['EUR', '5', '50'],
  LKA: ['USD', '5', '50'], KNA: ['USD', '5', '50'], LCA: ['USD', '5', '50'], VCT: ['USD', '5', '50'],
  SUR: ['USD', '5', '50'], SWZ: ['USD', '5', '50'], SWE: ['SEK', '60', '600'], CHE: ['CHF', '5', '50'],
  TWN: ['TWD', '200', '2000'], TJK: ['USD', '6', '60'], TZA: ['TZS', '18000', '180000'], THA: ['THB', '200', '2000'],
  TON: ['USD', '5', '50'], TTO: ['USD', '5', '50'], TUN: ['USD', '5', '50'], TKM: ['USD', '5', '50'],
  TCA: ['USD', '5', '50'], TUR: ['TRY', '300', '3000'], UGA: ['USD', '6', '60'], UKR: ['USD', '6', '60'],
  ARE: ['AED', '20', '200'], GBR: ['GBP', '5', '50'], USA: ['USD', '5', '50'], URY: ['USD', '5', '50'],
  UZB: ['USD', '6', '60'], VUT: ['USD', '5', '50'], VEN: ['USD', '5', '50'], VNM: ['VND', '130000', '1300000'],
  YEM: ['USD', '5', '50'], ZMB: ['USD', '6', '60'], ZWE: ['USD', '6', '60'],
};

export const PRICE_CHANGE_CLASSES = [
  'decrease',
  'unchanged',
  'new-price',
  'increase-to-new-subscribers-only',
  'increase-within-no-consent-threshold',
  'increase-needs-consent',
  'one-time-product',
] as const;
export type PriceChangeClass = (typeof PRICE_CHANGE_CLASSES)[number];

/** Google Play: what moving the legacy price cohort to the new price would need (G2, G3) */
export const PLAY_MIGRATION_CLASSES = ['no-consent', 'opt-out-possible', 'opt-in-required'] as const;
export type PlayMigrationClass = (typeof PLAY_MIGRATION_CLASSES)[number];

export interface ConsentContext {
  /** The subscription's billing period (ISO 8601, e.g. "P1M", "P1Y"). Apple: annual thresholds; Play: the per-day allowance. */
  billingPeriod?: string;
  /** Date of the last price increase existing subscribers saw (YYYY-MM-DD), for all territories or per territory */
  lastIncreaseAt?: string | Record<string, string>;
  /** Units of each currency per US dollar (Play's 17 US cents a day); defaults to the built-in fallback rates */
  exchangeRates?: Record<string, Decimal>;
}

export interface PriceChangeInput {
  platform: Platform;
  productType: 'subscription' | 'inapp';
  territory: string;
  /** What subscribers pay now (the territory's current price) */
  current: PriceValue | null;
  after: PriceValue;
  /** When the new price takes effect (YYYY-MM-DD) */
  effectiveDate: string;
  /** Apple: keep existing subscribers on their price (default true) */
  preserveCurrentPrice?: boolean;
  context?: ConsentContext;
}

export interface PriceChangeClassification {
  classification: PriceChangeClass;
  direction: 'increase' | 'decrease' | 'none' | 'new';
  /** Signed change in percent, 2 decimals ("12.50", "-5.00") */
  percent?: Decimal;
  /** Why, with the rule applied (A1..A4, G1..G3 above) */
  reasons: string[];
  /** Things taken for granted that PricingKit can't check */
  assumptions: string[];
  /** Google Play subscriptions: what migrating the legacy cohort would need */
  ifMigrated?: PlayMigrationClass;
}

const DAY_MS = 86_400_000;

/** Days in an ISO 8601 period, counting 7 a week, 30 a month and 365 a year; undefined if unreadable */
export function periodDays(period: string | undefined): number | undefined {
  const m = period ? /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(period) : null;
  if (!m || period === 'P') return undefined;
  const [, y, mo, w, d] = m.map((v) => (v === undefined ? 0 : Number(v)));
  const days = y * 365 + mo * 30 + w * 7 + d;
  return days > 0 ? days : undefined;
}

function lastIncreaseFor(context: ConsentContext | undefined, territory: string): string | undefined {
  const value = context?.lastIncreaseAt;
  return typeof value === 'string' ? value : value?.[territory];
}

/**
 * When was the last increase, against the effective date? Anything PricingKit
 * can't read, or a date after the effective date (the history given doesn't
 * fit this plan), is treated as if consent were needed: never ignored.
 */
type LastIncrease = 'recent' | 'old' | 'unreadable' | 'after-effective-date';
function lastIncreaseStatus(last: string, effective: string): LastIncrease {
  if (!isCalendarDate(last) || !isCalendarDate(effective.slice(0, 10))) return 'unreadable';
  const a = Date.parse(`${last}T00:00:00Z`);
  const b = Date.parse(`${effective.slice(0, 10)}T00:00:00Z`);
  if (a > b) return 'after-effective-date';
  return b - a < 365 * DAY_MS ? 'recent' : 'old';
}

function usdRate(currency: string, context: ConsentContext | undefined): Decimal | undefined {
  if (currency === 'USD') return '1';
  const given = context?.exchangeRates?.[currency];
  if (given) return given;
  const fallback = FALLBACK_EXCHANGE_RATES[currency];
  return fallback && Number.isFinite(fallback) && fallback > 0 ? decimalFromNumber(fallback, 6) : undefined;
}

/** Classify one territory's price change for existing subscribers. */
export function classifyPriceChange(input: PriceChangeInput): PriceChangeClassification {
  const { platform, territory, current, after, context } = input;
  const reasons: string[] = [];
  const assumptions: string[] = [];
  if (input.productType !== 'subscription') {
    return { classification: 'one-time-product', direction: current ? directionOf(current, after) : 'new', reasons: ['one-time product: no subscribers'], assumptions };
  }
  if (!current) return { classification: 'new-price', direction: 'new', reasons: ['the territory has no current price'], assumptions };
  if (current.currency !== after.currency) {
    return { classification: 'increase-needs-consent', direction: 'increase', reasons: [`currency changes (${current.currency} -> ${after.currency}); treated as needing consent`], assumptions };
  }
  const diff = subtractDecimal(after.amount, current.amount);
  const direction = directionOf(current, after);
  const percent = isZeroDecimal(current.amount) ? undefined : fixed2(divideDecimal(multiplyDecimal(diff, '100'), current.amount, 2));
  const base = { direction, ...(percent !== undefined ? { percent } : {}) };

  if (platform === 'google') {
    // G1: a base plan edit never reaches existing subscribers
    reasons.push('Google Play: existing subscribers stay on their price in a legacy cohort until it is migrated (G1)');
    if (direction === 'none') return { ...base, classification: 'unchanged', reasons, assumptions, ifMigrated: 'no-consent' };
    if (direction === 'decrease') return { ...base, classification: 'decrease', reasons: [...reasons, 'migrating a decrease needs no approval (G2)'], assumptions, ifMigrated: 'no-consent' };
    return { ...base, classification: 'increase-to-new-subscribers-only', reasons, assumptions, ifMigrated: playMigration(input, diff, reasons, assumptions) };
  }

  // App Store
  if (direction === 'none') return { ...base, classification: 'unchanged', reasons: ['same customer price'], assumptions };
  if (direction === 'decrease') {
    reasons.push('App Store: existing subscribers renew at the lower price (A3)');
    if (input.preserveCurrentPrice !== false) assumptions.push('preserveCurrentPrice has no effect on a decrease (App Store Connect UI; not confirmed for the API)');
    return { ...base, classification: 'decrease', reasons, assumptions };
  }
  if (input.preserveCurrentPrice !== false) {
    return { ...base, classification: 'increase-to-new-subscribers-only', reasons: ['preserveCurrentPrice: existing subscribers keep their price (A4)'], assumptions };
  }
  const needs = (why: string) => ({ ...base, classification: 'increase-needs-consent' as const, reasons: [...reasons, why], assumptions });
  const alpha3 = alpha2ToAlpha3(territory) ?? territory;
  const rule = APPLE_PRICE_INCREASE_THRESHOLDS[alpha3];
  if (rule === 'consent') return needs(`${territory} requires consent for any price increase (A2)`);

  const last = lastIncreaseFor(context, territory);
  if (last !== undefined) {
    const status = lastIncreaseStatus(last, input.effectiveDate);
    if (status === 'recent') return needs(`a price increase on ${last} is within 12 months of ${input.effectiveDate} (A1)`);
    if (status === 'unreadable') {
      assumptions.push('consent.lastIncreaseAt is not a real date, so the 12-month rule can\'t be checked: treated as needing consent');
      return needs('the last increase date can\'t be read (A1)');
    }
    if (status === 'after-effective-date') {
      assumptions.push(`consent.lastIncreaseAt (${last}) is after the change takes effect (${input.effectiveDate.slice(0, 10)}): treated as needing consent`);
      return needs('the last increase date is after the effective date (A1)');
    }
  } else {
    assumptions.push('no price increase in the last 12 months (PricingKit can\'t read the price history; set consent.lastIncreaseAt)');
  }

  if (!rule) return needs(`${territory} isn't in Apple's threshold table; treated as needing consent`);
  const [currency, nonAnnual, annual] = rule;
  if (currency !== after.currency) return needs(`Apple's threshold for ${territory} is in ${currency}, the price in ${after.currency}; treated as needing consent`);
  const isAnnual = input.context?.billingPeriod === 'P1Y';
  if (input.context?.billingPeriod === undefined) assumptions.push('billing period unknown: the non-annual (lower) threshold is used; set consent.billingPeriod');
  const threshold = isAnnual ? annual : nonAnnual;
  // A1: consent if more than 50% AND the difference exceeds the threshold
  const overHalf = compareDecimal(multiplyDecimal(diff, '2'), current.amount) > 0;
  const overThreshold = compareDecimal(diff, threshold) > 0;
  const limits = `more than 50%: ${overHalf ? 'yes' : 'no'}; more than ${threshold} ${currency} ${isAnnual ? 'a year' : 'a period'}: ${overThreshold ? 'yes' : 'no'}`;
  if (overHalf && overThreshold) return needs(`the increase is over both limits (${limits}) (A1, A2)`);
  return { ...base, classification: 'increase-within-no-consent-threshold', reasons: [`within Apple's no-consent limits (${limits}); subscribers are notified (A1, A2)`], assumptions };
}

/** Exactly two fraction digits: "100.1" -> "100.10" */
function fixed2(value: Decimal): Decimal {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function directionOf(current: PriceValue, after: PriceValue): PriceChangeClassification['direction'] {
  const c = compareDecimal(after.amount, current.amount);
  return c > 0 ? 'increase' : c < 0 ? 'decrease' : 'none';
}

/** G3: could the legacy cohort be moved with an opt-out (notice only) increase? */
function playMigration(input: PriceChangeInput, diff: Decimal, reasons: string[], assumptions: string[]): PlayMigrationClass {
  const { current, context, territory } = input;
  const last = lastIncreaseFor(context, territory);
  const status = last === undefined ? undefined : lastIncreaseStatus(last, input.effectiveDate);
  if (status === 'recent') {
    reasons.push(`migrating needs opt-in: an increase on ${last} is within 365 days (G3)`);
    return 'opt-in-required';
  }
  if (status === 'unreadable' || status === 'after-effective-date') {
    assumptions.push(`consent.lastIncreaseAt ${status === 'unreadable' ? 'is not a real date' : `(${last}) is after the effective date`}: treated as needing opt-in`);
    reasons.push('migrating needs opt-in: the last increase date can\'t be used (G3)');
    return 'opt-in-required';
  }
  if (last === undefined) assumptions.push('no opt-out increase in the last 365 days (set consent.lastIncreaseAt)');
  assumptions.push('the country allows opt-out increases and the developer is in good standing (not checked)');
  const half = divideDecimal(current!.amount, '2', 8);
  let allowance = half;
  const days = periodDays(context?.billingPeriod);
  const rate = usdRate(current!.currency, context);
  if (days === undefined) assumptions.push('billing period unknown: only the 50% limit is used; set consent.billingPeriod');
  else if (rate === undefined) assumptions.push(`no exchange rate for ${current!.currency}: only the 50% limit is used`);
  else {
    const perDay = multiplyDecimal(multiplyDecimal('0.17', String(days)), rate);
    if (compareDecimal(perDay, allowance) > 0) allowance = perDay;
  }
  if (compareDecimal(diff, allowance) <= 0) {
    reasons.push('migrating could be an opt-out increase: within the greater of 50% and 17 US cents a day (G3)');
    return 'opt-out-possible';
  }
  reasons.push('migrating needs opt-in: the increase is above the greater of 50% and 17 US cents a day (G3)');
  return 'opt-in-required';
}
