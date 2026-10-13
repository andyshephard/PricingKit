// Currency conversion utilities for bulk pricing
import type { Money } from './types';
import { GOOGLE_PLAY_REGIONS, parseMoney } from './types';
import { getPricingIndexEntry, LOCAL_CURRENCIES } from '../conversion-indexes/ppp';
import { getBigMacMultiplier } from '../conversion-indexes/big-mac';
import { getNetflixMultiplier } from '../conversion-indexes/netflix';
import { FALLBACK_EXCHANGE_RATES } from '../conversion-indexes/exchange-rates';
import { getSmartPricingMultiplier, type PricingPlatform } from '../conversion-indexes/smart';
import { alpha3ToAlpha2 } from '../apple-connect/territories';
import { findPreferredTierIndex } from '../apple-connect/price-tier-selection';

export type PricingStrategy = 'direct' | 'smart' | 'ppp' | 'bigmac' | 'netflix' | 'custom';
export type RoundingMode = 'nearest-tier' | 'nearest-99' | 'round-up' | 'nearest-x9' | 'round-up-x9' | 'none';

export interface RoundingTier {
  price: number;
}

export type GetTiersForCurrency = (
  currency: string
) => readonly RoundingTier[] | undefined;

/**
 * Platform-localized baseline price for a territory.
 *
 * For Apple Smart pricing this comes from App Store Connect equalizations.
 * V4 does NOT use it as the full price base. Instead, PricingKit compares it
 * with the live-FX customer price to infer Apple's tax/local-convention uplift,
 * then caps that uplift before applying the willingness-to-pay multiplier.
 */
export interface RegionalPriceBaseline {
  price: number;
  currency: string;
  proceeds?: number;
  proceedsYear2?: number;
}

/**
 * V4 guardrail for Apple equalization.
 *
 * Apple explicitly equalizes global pricing around FX, taxes and local price
 * conventions, but the resulting matrix can be materially above today's raw
 * FX + tax equivalent. For revenue-oriented consumer pricing we use Apple as a
 * tax/convention signal, not as an unlimited proceeds-equalization anchor.
 *
 * 1.25 roughly covers even high VAT/GST storefronts while preventing a stale
 * or aggressive equalization matrix from dominating the app-market WTP model.
 */
export const APPLE_EQUALIZATION_UPLIFT_CAP = 1.25;

const APPLE_STANDARD_DEVELOPER_SHARE = 0.70;
const APPLE_REDUCED_DEVELOPER_SHARE = 0.85;

// Apple price-point `proceeds` values are useful for developer-share
// estimates, but they do not reliably expose the territory's VAT/tax factor.
// Smart pricing therefore uses Apple's equalized customer price only as a
// bounded local tax/pricing-convention signal.

// Dynamic exchange rates from API (passed to calculation functions)
export interface DynamicExchangeRates {
  rates: Record<string, number>;
  base: string;
  fetchedAt: string;
}


// Convert a region code to alpha-2 format (handles both alpha-2 and alpha-3)
// If it's 3 characters, try to convert from alpha-3 to alpha-2
function toAlpha2(regionCode: string): string {
  if (regionCode.length === 3) {
    const alpha2 = alpha3ToAlpha2(regionCode);
    return alpha2 || regionCode;
  }
  return regionCode;
}

// Get the currency for a region
// If actualCurrencies is provided (from API), use that; otherwise fall back to static data
function getCurrencyForRegion(regionCode: string, actualCurrencies?: Record<string, string>): string {
  // If actualCurrencies is provided (from product/subscription API data or modal), prefer it
  if (actualCurrencies?.[regionCode]) {
    return actualCurrencies[regionCode];
  }

  // Fall back to our static mapping (using alpha-2)
  const alpha2Code = toAlpha2(regionCode);
  const region = GOOGLE_PLAY_REGIONS.find((r) => r.code === alpha2Code);
  return region?.currency || 'USD';
}

// Get exchange rate for a currency (USD to local)
// Prefers dynamic rates from API, falls back to static rates
function getExchangeRate(
  currencyCode: string,
  dynamicRates?: DynamicExchangeRates
): number {
  // Prefer dynamic rates from API
  if (dynamicRates?.rates[currencyCode] !== undefined) {
    return dynamicRates.rates[currencyCode];
  }
  // Fall back to static rates
  const fallbackRate = FALLBACK_EXCHANGE_RATES[currencyCode];
  if (fallbackRate === undefined) {
    console.warn(`[Currency] No exchange rate found for ${currencyCode}, defaulting to 1.0 (USD parity)`);
    return 1.0;
  }
  return fallbackRate;
}


// Get the actual local currency for a region (what World Bank PPP is based on)
function getLocalCurrencyForRegion(regionCode: string): string {
  return LOCAL_CURRENCIES[regionCode] || 'USD';
}

// Apply rounding based on mode. `tiers` (optional) is the list of allowed
// price points for the target currency (used by 'nearest-tier' mode when
// the platform exposes a tier ladder, e.g. Apple App Store Connect).
function applyRounding(
  price: number,
  mode: RoundingMode,
  currencyCode: string,
  tiers?: readonly RoundingTier[]
): number {
  if (mode === 'none') {
    return Math.round(price * 100) / 100;
  }

  // Snap to closest provided tier (e.g. Apple). Falls through to nearest-99
  // when no tier list is supplied (e.g. Google).
  if (mode === 'nearest-tier') {
    if (tiers && tiers.length > 0) {
      const preferredIndex = findPreferredTierIndex(
        tiers.map((tier) => tier.price),
        price,
        currencyCode
      );

      if (preferredIndex !== null) {
        return tiers[preferredIndex].price;
      }
    }
    // Fall through: behave as nearest-99 when no tier list available.
  }

  // For currencies with no decimal places (JPY, KRW, etc.)
  const noDecimalCurrencies = [
    'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'PYG', 'HUF', 'COP',
    'UGX', 'TZS', 'KZT', 'MNT', 'IQD',
    'XOF', 'XAF', // CFA Francs (West/Central African)
  ];
  const isNoDecimal = noDecimalCurrencies.includes(currencyCode);

  // CFA Francs require rounding to multiples of 100 (Google Play requirement)
  const cfaFrancs = ['XOF', 'XAF'];
  const isCfaFranc = cfaFrancs.includes(currencyCode);

  // Round up to next .99 ending (or platform-equivalent for no-decimal currencies).
  if (mode === 'round-up') {
    if (isCfaFranc) {
      return Math.ceil(price / 100) * 100;
    }
    if (isNoDecimal) {
      if (price >= 1000) {
        const next90 = Math.ceil((price + 10) / 100) * 100 - 10;
        return next90 < 90 ? 90 : next90;
      } else if (price >= 100) {
        const next9 = Math.ceil((price + 1) / 10) * 10 - 1;
        return next9 < 9 ? 9 : next9;
      }
      return Math.ceil(price);
    }
    const cents = Math.round(price * 100);
    if (cents % 100 === 99) return cents / 100; // already .99
    const nextWhole = Math.ceil(price);
    const result = nextWhole - 0.01;
    return result < 0.99 ? 0.99 : result;
  }

  // Round up to next .x9 ending (or platform-equivalent for no-decimal currencies).
  if (mode === 'round-up-x9') {
    if (isCfaFranc) {
      return Math.ceil(price / 100) * 100;
    }
    if (isNoDecimal) {
      if (price >= 1000) {
        const next90 = Math.ceil((price + 10) / 100) * 100 - 10;
        return next90 < 90 ? 90 : next90;
      } else if (price >= 100) {
        const next9 = Math.ceil((price + 1) / 10) * 10 - 1;
        return next9 < 9 ? 9 : next9;
      }
      return Math.ceil(price);
    }
    const cents = Math.round(price * 100);
    const lastDigit = cents % 10;
    const diff = (9 - lastDigit + 10) % 10;
    const roundedCents = cents + diff;
    const result = roundedCents / 100;
    return result < 0.09 ? 0.09 : result;
  }

  // 'nearest-x9' (closest .x9 ending by absolute distance).
  if (mode === 'nearest-x9') {
    if (isCfaFranc) {
      return Math.round(price / 100) * 100;
    }
    if (isNoDecimal) {
      if (price >= 1000) {
        const closest90 = Math.round((price + 10) / 100) * 100 - 10;
        return closest90 < 90 ? 90 : closest90;
      } else if (price >= 100) {
        const closest9 = Math.round((price + 1) / 10) * 10 - 1;
        return closest9 < 9 ? 9 : closest9;
      }
      return Math.round(price);
    }
    const cents = Math.round(price * 100);
    const lastDigit = cents % 10;

    const diffUp = (9 - lastDigit + 10) % 10;
    const upCents = cents + diffUp;

    const diffDown = (lastDigit + 1) % 10;
    const downCents = cents - diffDown;

    const roundedCents = (upCents - cents) <= (cents - downCents) ? upCents : downCents;
    const result = roundedCents / 100;
    return result < 0.09 ? 0.09 : result;
  }

  // 'nearest-99' (and the fallthrough from 'nearest-tier' with no tiers).
  if (isCfaFranc) {
    // CFA Francs: round to nearest 100 (.99 not applicable)
    return Math.round(price / 100) * 100;
  }
  if (isNoDecimal) {
    if (price >= 1000) {
      const closest90 = Math.round((price + 10) / 100) * 100 - 10;
      return closest90 < 90 ? 90 : closest90;
    } else if (price >= 100) {
      const closest9 = Math.round((price + 1) / 10) * 10 - 1;
      return closest9 < 9 ? 9 : closest9;
    }
    return Math.round(price);
  }

  const nearestWhole = Math.round(price + 0.01);
  const closest99 = nearestWhole - 0.01;
  return closest99 < 0.99 ? 0.99 : closest99;
}

export interface CalculatedPrice {
  regionCode: string;
  currencyCode: string;
  price: Money;
  rawPrice: number;
  /** The multiplier applied to the base price (before exchange rate) */
  multiplier: number;
  /** Source of the multiplier data */
  multiplierSource?: 'app-market' | 'world-bank' | 'big-mac' | 'netflix' | 'static' | 'custom' | 'direct';
  /** The exchange rate from USD to local currency */
  exchangeRate: number;
  /** The PPP-adjusted price in USD (before currency conversion) */
  adjustedUsdPrice: number;
  appleTaxFactor?: number;
  estimatedAppleProceeds?: number;
  estimatedAppleProceedsYear2?: number;
}

// Dynamic PPP data from World Bank API
export interface DynamicPPPData {
  [regionCode: string]: {
    pppMultiplier: number;
    pppConversionFactor?: number;
    /**
     * Snapshot of the local-currency market exchange rate captured by /api/ppp
     * at the same moment as `pppConversionFactor`. Used as the divisor when
     * computing the real PPP multiplier so the numerator (PPP factor) and
     * denominator come from a single API snapshot. Falls back to live OER rates.
     */
    marketExchangeRate?: number;
    bigMacMultiplier?: number;
    netflixMultiplier?: number;
    minPrice: number;
    suggestedRounding: number;
    source: 'world-bank' | 'static';
  };
}

// Calculate regional price based on strategy
export function calculateRegionalPrice(
  basePrice: number,
  regionCode: string,
  strategy: PricingStrategy,
  rounding: RoundingMode = 'nearest-tier',
  customMultiplier?: number,
  dynamicPPPData?: DynamicPPPData,
  actualCurrencies?: Record<string, string>, // Currencies from API
  dynamicExchangeRates?: DynamicExchangeRates, // Exchange rates from API
  baseCurrency: string = 'USD', // The currency of the basePrice
  baseRegion: string = 'US', // The region the basePrice is defined for
  getTiersForCurrency?: GetTiersForCurrency, // Optional tier ladder per currency (Apple)
  regionalBaselines?: Record<string, RegionalPriceBaseline>, // Apple equalized storefront baselines
  appleSmallBusinessProgram: boolean = false
): CalculatedPrice {
  // Convert to alpha-2 for lookups (handles both alpha-2 and alpha-3 inputs)
  const alpha2Code = toAlpha2(regionCode);
  const alpha2BaseRegion = toAlpha2(baseRegion);

  // Use actual currency from API if available, otherwise fall back to static data
  const currencyCode = getCurrencyForRegion(regionCode, actualCurrencies);
  const exchangeRate = getExchangeRate(currencyCode, dynamicExchangeRates);

  // Normalize basePrice to USD if it's in a different currency
  let baseUsdPrice = basePrice;
  if (baseCurrency !== 'USD') {
    const baseExchangeRate = getExchangeRate(baseCurrency, dynamicExchangeRates);
    if (baseExchangeRate && baseExchangeRate !== 0) {
      baseUsdPrice = basePrice / baseExchangeRate;
    }
  }

  // Free (0) base price: skip all calculations and return 0 for every region
  if (basePrice === 0) {
    return {
      regionCode,
      currencyCode,
      price: parseMoney(0, currencyCode),
      rawPrice: 0,
      multiplier: 1.0,
      multiplierSource: 'direct',
      exchangeRate,
      adjustedUsdPrice: 0,
    };
  }

  // Use dynamic PPP data if available (try both original and alpha-2 codes), otherwise fall back to static
  const dynamicEntry = dynamicPPPData?.[regionCode] ?? dynamicPPPData?.[alpha2Code];
  const staticEntry = getPricingIndexEntry(alpha2Code);
  const pppConversionFactor = dynamicEntry?.pppConversionFactor;
  const pppMultiplier = dynamicEntry?.pppMultiplier ?? staticEntry.pppMultiplier;
  const minPrice = dynamicEntry?.minPrice ?? staticEntry.minPrice;

  // Get base region PPP data for relative normalization
  const baseDynamicEntry = dynamicPPPData?.[baseRegion] ?? dynamicPPPData?.[alpha2BaseRegion];
  const baseStaticEntry = getPricingIndexEntry(alpha2BaseRegion);
  const basePppMultiplier = baseDynamicEntry?.pppMultiplier ?? baseStaticEntry.pppMultiplier;

  let calculatedPrice: number;
  let effectiveMultiplier: number = 1.0;
  let multiplierSource: CalculatedPrice['multiplierSource'] = 'direct';
  let appleTaxFactor: number | undefined;

  // Get Big Mac multiplier (from dynamic data or static, using alpha-2 for lookup)
  const bigMacMultiplier = dynamicEntry?.bigMacMultiplier ?? getBigMacMultiplier(alpha2Code);
  const baseBigMacMultiplier = baseDynamicEntry?.bigMacMultiplier ?? getBigMacMultiplier(alpha2BaseRegion);
  const netflixMultiplier = dynamicEntry?.netflixMultiplier ?? getNetflixMultiplier(alpha2Code);
  const baseNetflixMultiplier = baseDynamicEntry?.netflixMultiplier ?? getNetflixMultiplier(alpha2BaseRegion);

// Apple callers pass a tier ladder; Google callers do not. Keep platform
// inference local so existing call sites remain backwards compatible.
const pricingPlatform: PricingPlatform = getTiersForCurrency ? 'apple' : 'google';
const smartMultiplier = getSmartPricingMultiplier(
  alpha2Code,
  pppMultiplier,
  pricingPlatform,
  staticEntry.pppMultiplier
);
const baseSmartMultiplier = getSmartPricingMultiplier(
  alpha2BaseRegion,
  basePppMultiplier,
  pricingPlatform,
  baseStaticEntry.pppMultiplier
);

switch (strategy) {
    case 'direct':
      // Same USD value everywhere - just convert currency using market exchange rate
      calculatedPrice = baseUsdPrice * exchangeRate;
      effectiveMultiplier = 1.0;
      multiplierSource = 'direct';
      break;
case 'smart': {
  // Final V4.1:
  // base customer price -> live FX -> app-market WTP
  // -> bounded Apple local tax/pricing-convention uplift -> Apple tier.
  effectiveMultiplier = smartMultiplier / baseSmartMultiplier;
  const rawFxPrice = baseUsdPrice * exchangeRate;
  calculatedPrice = rawFxPrice * effectiveMultiplier;

  const localizedBaseline =
    regionalBaselines?.[regionCode] ?? regionalBaselines?.[alpha2Code];

  if (
    pricingPlatform === 'apple' &&
    localizedBaseline &&
    localizedBaseline.currency === currencyCode &&
    Number.isFinite(localizedBaseline.price) &&
    localizedBaseline.price > 0 &&
    rawFxPrice > 0
  ) {
    const equalizationUplift = localizedBaseline.price / rawFxPrice;

    if (Number.isFinite(equalizationUplift) && equalizationUplift > 0) {
      // Apple equalizations contain useful tax + storefront convention
      // information, but are not allowed to dominate the WTP target.
      const boundedUplift = Math.min(
        equalizationUplift,
        APPLE_EQUALIZATION_UPLIFT_CAP
      );

      appleTaxFactor = boundedUplift;
      calculatedPrice *= boundedUplift;
    }
  }

  multiplierSource = 'app-market';
  break;
}
case 'ppp':
      // PPP strategy: adjust prices based on purchasing power parity
      //
      // The World Bank PPP conversion factor is in LOCAL CURRENCY units per international $.
      // For example, Ukraine PPP factor ~9.34 means 9.34 UAH = 1 international $.
      //
      // If billing currency matches local currency:
      //   price = baseUsdPrice × pppFactor
      //
      // If billing currency differs (e.g., Apple bills Ukraine in USD, not UAH):
      //   1. Calculate PPP price in local currency: baseUsdPrice × pppFactor = price in UAH
      //   2. Convert to billing currency: price in UAH / localExchangeRate = price in USD
      //   Formula: price = baseUsdPrice × pppFactor / localExchangeRate × billingExchangeRate
      
      // Get the World Bank's expected local currency for this region. Prefer the
      // snapshot rate from /api/ppp (paired with the PPP factor) so the multiplier's
      // numerator and denominator come from one API call; fall back to live OER.
      const localCurrency = getLocalCurrencyForRegion(alpha2Code);
      const localExchangeRate = dynamicEntry?.marketExchangeRate
        ?? getExchangeRate(localCurrency, dynamicExchangeRates);

      if (pppConversionFactor !== undefined) {
        // If we have dynamic PPP data, we use the real multiplier (PPP_Factor / Market_Rate)
        // BUT we must normalize it relative to the base region's multiplier
        const baseLocalCurrency = getLocalCurrencyForRegion(alpha2BaseRegion);
        const baseLocalExchangeRate = baseDynamicEntry?.marketExchangeRate
          ?? getExchangeRate(baseLocalCurrency, dynamicExchangeRates);
        const basePppConversionFactor = baseDynamicEntry?.pppConversionFactor;

        let baseRealMultiplier = basePppMultiplier;
        if (baseLocalExchangeRate && basePppConversionFactor) {
          baseRealMultiplier = basePppConversionFactor / baseLocalExchangeRate;
        }

        if (currencyCode === localCurrency) {
          // Billing currency matches local currency. Use the snapshot rate for the
          // multiplier denominator; keep the live OER rate for the final output
          // conversion so the displayed price tracks today's market.
          const rawRealMultiplier = pppConversionFactor / localExchangeRate;
          effectiveMultiplier = rawRealMultiplier / baseRealMultiplier;
          calculatedPrice = baseUsdPrice * effectiveMultiplier * exchangeRate;
          multiplierSource = dynamicEntry?.source ?? 'world-bank';
        } else {
          // Billing currency differs from local currency
          const hasExchangeRate = (dynamicExchangeRates?.rates[localCurrency] !== undefined) ||
            (FALLBACK_EXCHANGE_RATES[localCurrency] !== undefined);
          
          if (localCurrency !== 'USD' && !hasExchangeRate) {
            effectiveMultiplier = pppMultiplier / basePppMultiplier;
            calculatedPrice = baseUsdPrice * effectiveMultiplier * exchangeRate;
            multiplierSource = 'static';
          } else {
            const pppPriceInLocal = baseUsdPrice * pppConversionFactor;
            const pppPriceInUsd = pppPriceInLocal / localExchangeRate;
            const rawRealMultiplier = pppPriceInUsd / baseUsdPrice;
            
            effectiveMultiplier = rawRealMultiplier / baseRealMultiplier;

            // For hyperinflation countries where PPP produces HIGHER prices than base,
            // use a low default multiplier to make apps affordable.
            if (effectiveMultiplier > 1.0 && rawRealMultiplier > 1.0) {
              const affordabilityMultiplier = 0.25;
              effectiveMultiplier = affordabilityMultiplier;
              calculatedPrice = baseUsdPrice * effectiveMultiplier * exchangeRate;
              multiplierSource = 'static';
            } else {
              calculatedPrice = baseUsdPrice * effectiveMultiplier * exchangeRate;
              multiplierSource = dynamicEntry?.source ?? 'world-bank';
            }
          }
        }
      } else {
        // No PPP conversion factor available - use static multiplier normalized to base region
        effectiveMultiplier = pppMultiplier / basePppMultiplier;
        calculatedPrice = baseUsdPrice * effectiveMultiplier * exchangeRate;
        multiplierSource = 'static';
      }
      break;
    case 'bigmac':
      // Big Mac Index strategy: use multiplier normalized to base region
      effectiveMultiplier = bigMacMultiplier / baseBigMacMultiplier;
      calculatedPrice = baseUsdPrice * effectiveMultiplier * exchangeRate;
      multiplierSource = 'big-mac';
      break;
    case 'netflix':
      // Netflix Price Index strategy: use multiplier normalized to base region
      effectiveMultiplier = netflixMultiplier / baseNetflixMultiplier;
      calculatedPrice = baseUsdPrice * effectiveMultiplier * exchangeRate;
      multiplierSource = 'netflix';
      break;
    case 'custom':
      // Use provided custom multiplier with exchange rate
      calculatedPrice = baseUsdPrice * (customMultiplier ?? 1.0) * exchangeRate;
      effectiveMultiplier = customMultiplier ?? 1.0;
      multiplierSource = 'custom';
      break;
    default:
      calculatedPrice = baseUsdPrice * exchangeRate;
      effectiveMultiplier = 1.0;
      multiplierSource = 'direct';
  }

  // Apply rounding (with optional tier ladder for nearest-tier mode)
  const tiersForCurrency = getTiersForCurrency?.(currencyCode);
  calculatedPrice = applyRounding(
    calculatedPrice,
    rounding,
    currencyCode,
    tiersForCurrency
  );

  // Enforce minimum price (minPrice is in local currency, convert if billing currency differs)
  // Get the local currency to check if minPrice needs conversion
  const minPriceLocalCurrency = getLocalCurrencyForRegion(alpha2Code);
  let adjustedMinPrice = minPrice;

  if (currencyCode !== minPriceLocalCurrency) {
    // Convert minPrice from local currency to billing currency
    const minPriceLocalRate = getExchangeRate(minPriceLocalCurrency, dynamicExchangeRates);
    // minPrice in local / local rate = minPrice in USD, then * billing rate
    adjustedMinPrice = (minPrice / minPriceLocalRate) * exchangeRate;
  }

  calculatedPrice = Math.max(calculatedPrice, adjustedMinPrice);

  // The PPP-adjusted USD price before currency conversion
  const adjustedUsdPrice = baseUsdPrice * effectiveMultiplier;

  const estimatedAppleProceeds =
    pricingPlatform === 'apple' && appleTaxFactor
      ? (calculatedPrice / appleTaxFactor) *
        (appleSmallBusinessProgram
          ? APPLE_REDUCED_DEVELOPER_SHARE
          : APPLE_STANDARD_DEVELOPER_SHARE)
      : undefined;

  const estimatedAppleProceedsYear2 =
    pricingPlatform === 'apple' && appleTaxFactor
      ? (calculatedPrice / appleTaxFactor) * APPLE_REDUCED_DEVELOPER_SHARE
      : undefined;

  return {
    regionCode,
    currencyCode,
    price: parseMoney(calculatedPrice, currencyCode),
    rawPrice: calculatedPrice,
    multiplier: effectiveMultiplier,
    multiplierSource,
    exchangeRate,
    adjustedUsdPrice,
    appleTaxFactor,
    estimatedAppleProceeds,
    estimatedAppleProceedsYear2,
  };
}

// Calculate prices for multiple regions
export function calculateBulkPrices(
  basePrice: number,
  regionCodes: string[],
  strategy: PricingStrategy,
  rounding: RoundingMode = 'nearest-tier',
  customMultipliers?: Record<string, number>,
  dynamicPPPData?: DynamicPPPData,
  actualCurrencies?: Record<string, string>, // Currencies from Google Play API
  dynamicExchangeRates?: DynamicExchangeRates, // Exchange rates from API
  baseCurrency: string = 'USD', // The currency of the basePrice
  baseRegion: string = 'US', // The region the basePrice is defined for
  getTiersForCurrency?: GetTiersForCurrency, // Optional tier ladder per currency (Apple)
  regionalBaselines?: Record<string, RegionalPriceBaseline>, // Apple equalized storefront baselines
  appleSmallBusinessProgram: boolean = false
): CalculatedPrice[] {
  return regionCodes.map((regionCode) => {
    const customMultiplier = customMultipliers?.[regionCode];
    return calculateRegionalPrice(
      basePrice,
      regionCode,
      strategy,
      rounding,
      customMultiplier,
      dynamicPPPData,
      actualCurrencies,
      dynamicExchangeRates,
      baseCurrency,
      baseRegion,
      getTiersForCurrency,
      regionalBaselines,
      appleSmallBusinessProgram
    );
  });
}

// Get all available region codes
export function getAllRegionCodes(): string[] {
  return GOOGLE_PLAY_REGIONS.map((r) => r.code);
}

// Calculate percentage change between two prices
export function calculatePriceChange(oldPrice: number, newPrice: number): number {
  if (oldPrice === 0) return newPrice > 0 ? 100 : 0;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

// Format price change as string
export function formatPriceChange(change: number): string {
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(0)}%`;
}
