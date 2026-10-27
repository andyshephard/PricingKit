// Rounding rules for regional prices (charm endings, zero-decimal and CFA
// currencies, tier ladders). Framework-free; part of the pricing core.

export type RoundingMode = 'nearest-tier' | 'nearest-99' | 'round-up' | 'none';

export interface RoundingTier {
  price: number;
}

export type GetTiersForCurrency = (
  currency: string
) => readonly RoundingTier[] | undefined;

// Currencies with no minor unit on the stores (JPY, KRW, etc.)
const NO_DECIMAL_CURRENCIES = [
  'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'PYG', 'HUF', 'COP',
  'UGX', 'TZS', 'KZT', 'MNT', 'IQD',
  'XOF', 'XAF', // CFA Francs (West/Central African)
];

// CFA Francs require rounding to multiples of 100 (Google Play requirement)
const CFA_FRANCS = ['XOF', 'XAF'];

export function isZeroDecimalCurrency(currencyCode: string): boolean {
  return NO_DECIMAL_CURRENCIES.includes(currencyCode);
}

/**
 * Round a price DOWN to the nearest charm price at or below it, so a
 * "round" operation never raises a price. Decimal currencies end in
 * `ending` (12.00 -> 11.99, 12.99 stays 12.99); no-decimal currencies use
 * the same 9/90 endings as applyRounding (1234 JPY -> 1190) and CFA francs
 * round down to a multiple of 100. If rounding down would reach zero or
 * below, the price is returned unchanged.
 */
export function roundDownToPriceEnding(
  price: number,
  currencyCode: string,
  ending: number = 0.99
): number {
  let result: number;
  if (CFA_FRANCS.includes(currencyCode)) {
    result = Math.floor(price / 100) * 100;
  } else if (isZeroDecimalCurrency(currencyCode)) {
    if (price >= 1000) {
      result = Math.floor((price + 10) / 100) * 100 - 10;
    } else if (price >= 100) {
      result = Math.floor((price + 1) / 10) * 10 - 1;
    } else {
      result = Math.floor(price);
    }
  } else {
    // Work in cents to avoid float drift (12.99 - 0.99 etc.)
    const cents = Math.round(price * 100);
    const endingCents = Math.round(ending * 100) % 100;
    result = (Math.floor((cents - endingCents) / 100) * 100 + endingCents) / 100;
  }
  return result > 0 ? result : price;
}

// Apply rounding based on mode. `tiers` (optional) is the list of allowed
// price points for the target currency (used by 'nearest-tier' mode when
// the platform exposes a tier ladder, e.g. Apple App Store Connect).
export function applyRounding(
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
      let closest = tiers[0];
      let minDiff = Math.abs(closest.price - price);
      for (let i = 1; i < tiers.length; i++) {
        const diff = Math.abs(tiers[i].price - price);
        if (diff < minDiff) {
          minDiff = diff;
          closest = tiers[i];
        }
      }
      return closest.price;
    }
    // Fall through: behave as nearest-99 when no tier list available.
  }

  const isNoDecimal = isZeroDecimalCurrency(currencyCode);
  const isCfaFranc = CFA_FRANCS.includes(currencyCode);

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
