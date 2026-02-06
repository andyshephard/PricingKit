// Currency conversion utilities for bulk pricing
import type { Money } from './types';
import { GOOGLE_PLAY_REGIONS, parseMoney } from './types';
import { getPricingIndexEntry, LOCAL_CURRENCIES } from '../conversion-indexes/ppp';
import { getBigMacMultiplier } from '../conversion-indexes/big-mac';
import { FALLBACK_EXCHANGE_RATES } from '../conversion-indexes/exchange-rates';
import { alpha3ToAlpha2 } from '../apple-connect/territories';

export type PricingStrategy = 'direct' | 'ppp' | 'bigmac' | 'custom';
export type RoundingMode = 'charm' | 'whole' | 'none';

// Dynamic exchange rates from API (passed to calculation functions)
export interface DynamicExchangeRates {
  rates: Record<string, number>;
  base: string;
  fetchedAt: string;
}


// Convert a region code to alpha-2 format (handles both alpha-2 and alpha-3)
function toAlpha2(regionCode: string): string {
  // If it's 3 characters, try to convert from alpha-3 to alpha-2
  if (regionCode.length === 3) {
    const alpha2 = alpha3ToAlpha2(regionCode);
    return alpha2 || regionCode;
  }
  return regionCode;
}

// Get the currency for a region
// If actualCurrencies is provided (from API), use that; otherwise fall back to static data
function getCurrencyForRegion(regionCode: string, actualCurrencies?: Record<string, string>): string {
  // Prefer actual currency from API if available (supports both alpha-2 and alpha-3)
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

// Apply rounding based on mode
function applyRounding(price: number, mode: RoundingMode, currencyCode: string): number {
  if (mode === 'none') {
    return Math.round(price * 100) / 100;
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

  if (mode === 'whole') {
    if (isCfaFranc) {
      // CFA Francs: always round to nearest 100
      return Math.round(price / 100) * 100;
    }
    if (isNoDecimal) {
      // Round to nearest 10 or 100 depending on magnitude
      if (price >= 1000) {
        return Math.round(price / 100) * 100;
      } else if (price >= 100) {
        return Math.round(price / 10) * 10;
      }
      return Math.round(price);
    }
    return Math.round(price);
  }

  // Charm pricing (.99 endings)
  if (mode === 'charm') {
    if (isCfaFranc) {
      // CFA Francs: round to nearest 100 (charm pricing not applicable)
      return Math.round(price / 100) * 100;
    }
    if (isNoDecimal) {
      // For no-decimal currencies, use closest X9 or X90 endings
      if (price >= 1000) {
        const closest90 = Math.round((price + 10) / 100) * 100 - 10;
        return closest90 < 90 ? 90 : closest90;
      } else if (price >= 100) {
        const closest9 = Math.round((price + 1) / 10) * 10 - 1;
        return closest9 < 9 ? 9 : closest9;
      }
      return Math.round(price);
    }

    // Standard charm pricing for decimal currencies - closest .99
    const nearestWhole = Math.round(price + 0.01);
    const closest99 = nearestWhole - 0.01;
    return closest99 < 0.99 ? 0.99 : closest99;
  }

  return price;
}

export interface CalculatedPrice {
  regionCode: string;
  currencyCode: string;
  price: Money;
  rawPrice: number;
  /** The multiplier applied to the base price (before exchange rate) */
  multiplier: number;
  /** Source of the multiplier data */
  multiplierSource?: 'world-bank' | 'big-mac' | 'static' | 'custom' | 'direct';
  /** The exchange rate from USD to local currency */
  exchangeRate: number;
  /** The PPP-adjusted price in USD (before currency conversion) */
  adjustedUsdPrice: number;
}

// Dynamic PPP data from World Bank API
export interface DynamicPPPData {
  [regionCode: string]: {
    pppMultiplier: number;
    pppConversionFactor?: number;
    bigMacMultiplier?: number;
    minPrice: number;
    suggestedRounding: number;
    source: 'world-bank' | 'static';
  };
}

// Calculate regional price based on strategy
export function calculateRegionalPrice(
  baseUsdPrice: number,
  regionCode: string,
  strategy: PricingStrategy,
  rounding: RoundingMode = 'charm',
  customMultiplier?: number,
  dynamicPPPData?: DynamicPPPData,
  actualCurrencies?: Record<string, string>, // Currencies from API
  dynamicExchangeRates?: DynamicExchangeRates // Exchange rates from API
): CalculatedPrice {
  // Convert to alpha-2 for lookups (handles both alpha-2 and alpha-3 inputs)
  const alpha2Code = toAlpha2(regionCode);

  // Use actual currency from API if available, otherwise fall back to static data
  const currencyCode = getCurrencyForRegion(regionCode, actualCurrencies);
  const exchangeRate = getExchangeRate(currencyCode, dynamicExchangeRates);

  // Use dynamic PPP data if available (try both original and alpha-2 codes), otherwise fall back to static
  const dynamicEntry = dynamicPPPData?.[regionCode] ?? dynamicPPPData?.[alpha2Code];
  const staticEntry = getPricingIndexEntry(alpha2Code);
  const pppConversionFactor = dynamicEntry?.pppConversionFactor;
  const pppMultiplier = dynamicEntry?.pppMultiplier ?? staticEntry.pppMultiplier;
  const minPrice = dynamicEntry?.minPrice ?? staticEntry.minPrice;

  let calculatedPrice: number;
  let effectiveMultiplier: number = 1.0;
  let multiplierSource: CalculatedPrice['multiplierSource'] = 'direct';

  // Get Big Mac multiplier (from dynamic data or static, using alpha-2 for lookup)
  const bigMacMultiplier = dynamicEntry?.bigMacMultiplier ?? getBigMacMultiplier(alpha2Code);

  switch (strategy) {
    case 'direct':
      // Same USD value everywhere - just convert currency using market exchange rate
      calculatedPrice = baseUsdPrice * exchangeRate;
      effectiveMultiplier = 1.0;
      multiplierSource = 'direct';
      break;
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
      //
      // Example for Ukraine (billed in USD, local currency UAH):
      //   - PPP factor: 9.34 UAH per int'l $
      //   - UAH exchange rate: 37.5 UAH per USD
      //   - $49.99 × 9.34 / 37.5 = $12.45 USD

      // Get the World Bank's expected local currency for this region
      const localCurrency = getLocalCurrencyForRegion(alpha2Code);
      const localExchangeRate = getExchangeRate(localCurrency, dynamicExchangeRates);

      if (pppConversionFactor !== undefined) {
        if (currencyCode === localCurrency) {
          // Billing currency matches local currency - use PPP factor directly
          calculatedPrice = baseUsdPrice * pppConversionFactor;
          // The effective multiplier in terms of USD equivalent
          effectiveMultiplier = pppConversionFactor / exchangeRate;
          multiplierSource = dynamicEntry?.source ?? 'world-bank';
        } else {
          // Billing currency differs from local currency
          // Convert PPP price to billing currency
          //
          // Safety check: if the local currency isn't found in any exchange rate data,
          // the lookup failed. Fall back to static multiplier.
          // Note: we check for existence rather than rate === 1.0, because USD-pegged
          // currencies (BSD, PAB, etc.) legitimately have a rate of 1.0.
          const hasExchangeRate = (dynamicExchangeRates?.rates[localCurrency] !== undefined) ||
            (FALLBACK_EXCHANGE_RATES[localCurrency] !== undefined);
          if (localCurrency !== 'USD' && !hasExchangeRate) {
            console.warn(`Missing exchange rate for ${localCurrency} (${alpha2Code}), using static multiplier`);
            calculatedPrice = baseUsdPrice * pppMultiplier * exchangeRate;
            effectiveMultiplier = pppMultiplier;
            multiplierSource = 'static';
          } else {
            const pppPriceInLocal = baseUsdPrice * pppConversionFactor;
            const pppPriceInUsd = pppPriceInLocal / localExchangeRate;

            // For hyperinflation countries where PPP produces HIGHER prices than base,
            // use a low default multiplier to make apps affordable.
            // High PPP/market ratio indicates economic distress, not prosperity.
            if (pppPriceInUsd > baseUsdPrice) {
              const affordabilityMultiplier = 0.25; // ~$12.50 for $49.99 base
              calculatedPrice = baseUsdPrice * affordabilityMultiplier * exchangeRate;
              effectiveMultiplier = affordabilityMultiplier;
              multiplierSource = 'static'; // Using hardcoded affordability fallback
            } else {
              calculatedPrice = pppPriceInUsd * exchangeRate;
              effectiveMultiplier = pppPriceInUsd / baseUsdPrice;
              multiplierSource = dynamicEntry?.source ?? 'world-bank';
            }
          }
        }
      } else {
        // No PPP conversion factor available - use static multiplier
        calculatedPrice = baseUsdPrice * pppMultiplier * exchangeRate;
        effectiveMultiplier = pppMultiplier;
        multiplierSource = 'static';
      }
      break;
    case 'bigmac':
      // Big Mac Index strategy: use multiplier based on Big Mac price comparison
      // Lower multiplier = lower prices in that region (relative to US)
      calculatedPrice = baseUsdPrice * bigMacMultiplier * exchangeRate;
      effectiveMultiplier = bigMacMultiplier;
      multiplierSource = 'big-mac';
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

  // Apply rounding
  calculatedPrice = applyRounding(calculatedPrice, rounding, currencyCode);

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

  return {
    regionCode,
    currencyCode,
    price: parseMoney(calculatedPrice, currencyCode),
    rawPrice: calculatedPrice,
    multiplier: effectiveMultiplier,
    multiplierSource,
    exchangeRate,
    adjustedUsdPrice,
  };
}

// Calculate prices for multiple regions
export function calculateBulkPrices(
  baseUsdPrice: number,
  regionCodes: string[],
  strategy: PricingStrategy,
  rounding: RoundingMode = 'charm',
  customMultipliers?: Record<string, number>,
  dynamicPPPData?: DynamicPPPData,
  actualCurrencies?: Record<string, string>, // Currencies from Google Play API
  dynamicExchangeRates?: DynamicExchangeRates // Exchange rates from API
): CalculatedPrice[] {
  return regionCodes.map((regionCode) => {
    const customMultiplier = customMultipliers?.[regionCode];
    return calculateRegionalPrice(
      baseUsdPrice,
      regionCode,
      strategy,
      rounding,
      customMultiplier,
      dynamicPPPData,
      actualCurrencies,
      dynamicExchangeRates
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
