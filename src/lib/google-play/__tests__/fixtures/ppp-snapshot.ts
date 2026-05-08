// Synthetic but realistic PPP / exchange-rate fixtures for currency-engine tests.
// Numbers are picked to exercise interesting branches; not meant to mirror real markets.
import type { DynamicPPPData, DynamicExchangeRates } from '../../currency';

/**
 * PPP factor (LCU per int'l $) and ppp-vs-market multiplier for each region.
 * pppMultiplier in the new semantics = PPP_Factor / Market_Rate (clamped 0.1..2.0).
 */
export const TEST_PPP_DATA: DynamicPPPData = {
  US: {
    pppMultiplier: 1.0,
    pppConversionFactor: 1.0,
    minPrice: 0.99,
    suggestedRounding: 0.99,
    source: 'world-bank',
  },
  DE: {
    pppMultiplier: 0.7053 / 0.851,
    pppConversionFactor: 0.7053,
    minPrice: 0.99,
    suggestedRounding: 0.99,
    source: 'world-bank',
  },
  GB: {
    pppMultiplier: 0.6698 / 0.735,
    pppConversionFactor: 0.6698,
    minPrice: 0.79,
    suggestedRounding: 0.99,
    source: 'world-bank',
  },
  TR: {
    pppMultiplier: 15.1551 / 45.2557,
    pppConversionFactor: 15.1551,
    minPrice: 0.99,
    suggestedRounding: 0.99,
    source: 'world-bank',
  },
  IN: {
    pppMultiplier: 20.4220 / 94.668,
    pppConversionFactor: 20.4220,
    minPrice: 0.99,
    suggestedRounding: 0.99,
    source: 'world-bank',
  },
  AR: {
    // Synthetic: PPP factor much larger than market rate to trigger hyperinflation branch
    // when billing in USD (pppPriceInUsd > baseUsdPrice).
    pppMultiplier: 0.5,
    pppConversionFactor: 400,
    minPrice: 0.99,
    suggestedRounding: 0.99,
    source: 'world-bank',
  },
  JP: {
    pppMultiplier: 95.0 / 156.31,
    pppConversionFactor: 95.0,
    minPrice: 99,
    suggestedRounding: 0,
    source: 'world-bank',
  },
};

export const TEST_EXCHANGE_RATES: DynamicExchangeRates = {
  base: 'USD',
  fetchedAt: '2026-05-01T00:00:00Z',
  rates: {
    USD: 1,
    EUR: 0.851,
    GBP: 0.735,
    TRY: 45.2557,
    INR: 94.668,
    ARS: 100, // synthetic: lower than PPP factor 400 → hyperinflation override path
    JPY: 156.31,
    BRL: 4.917,
  },
};

/**
 * Apple-style billing currency overrides — make Argentina bill in USD so we
 * trigger the mixed-currency branch in calculateRegionalPrice.
 */
export const APPLE_BILLED_IN_USD = {
  AR: 'USD',
};
