import { getPriceTiersForCurrency } from './price-tier-data';

const CHARM_PRICE_CURRENCIES = new Set([
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'NZD',
]);

const PRICE_EPSILON = 1e-9;
const MAX_CHARM_DISTANCE_RATIO = 0.01;

function centEnding(price: number): number {
  const cents = Math.round(price * 100);
  return ((cents % 100) + 100) % 100;
}

function findPriceIndex(prices: number[], target: number): number {
  return prices.findIndex(
    (price) => Math.abs(price - target) <= PRICE_EPSILON
  );
}

/**
 * Consumer-oriented Apple tier selection.
 *
 * Starts from the mathematically nearest Apple tier and removes smooth
 * consumer price endings when a psychologically preferable Apple tier is
 * essentially equivalent economically:
 *
 *   xx.00 -> previous .99
 *   xx.10 -> xx.09
 *   xx.20 -> xx.19
 *   xx.30 -> xx.29
 *   xx.40 -> xx.39
 *   xx.50 -> xx.49
 *   xx.60 -> xx.59
 *   xx.70 -> xx.69
 *   xx.80 -> xx.79
 *   xx.90 -> xx.99
 *   xx.95 -> xx.99
 *
 * The alternative must exist as a real Apple tier and remain within 1%
 * of the original V4.1 calculated target.
 */
export function findPreferredTierIndex(
  prices: number[],
  amount: number,
  currencyCode: string
): number | null {
  if (prices.length === 0) {
    return null;
  }

  let closestIndex = 0;
  let minDiff = Math.abs(prices[0] - amount);

  for (let i = 1; i < prices.length; i++) {
    const diff = Math.abs(prices[i] - amount);

    if (diff < minDiff) {
      minDiff = diff;
      closestIndex = i;
    }
  }

  if (!CHARM_PRICE_CURRENCIES.has(currencyCode) || amount <= 0) {
    return closestIndex;
  }

  const closestPrice = prices[closestIndex];
  const ending = centEnding(closestPrice);

  let charmTarget: number | null = null;

  if (ending === 90 || ending === 95) {
    // $31.90 / $31.95 -> $31.99
    charmTarget = Number(
      (Math.floor(closestPrice + PRICE_EPSILON) + 0.99).toFixed(2)
    );
  } else if (ending % 10 === 0) {
    // $18.00 -> $17.99
    // $31.20 -> $31.19
    // $31.50 -> $31.49
    charmTarget = Number((closestPrice - 0.01).toFixed(2));
  }

  if (charmTarget === null) {
    return closestIndex;
  }

  const charmIndex = findPriceIndex(prices, charmTarget);

  if (charmIndex === -1) {
    return closestIndex;
  }

  const charmPrice = prices[charmIndex];
  const distanceRatio =
    Math.abs(charmPrice - amount) /
    Math.max(Math.abs(amount), 0.01);

  if (
    distanceRatio <=
    MAX_CHARM_DISTANCE_RATIO + PRICE_EPSILON
  ) {
    return charmIndex;
  }

  return closestIndex;
}

export function findSmartTierForCurrency(
  amount: number,
  currencyCode: string
): { tier: string; price: number } | null {
  const tiers = getPriceTiersForCurrency(currencyCode);

  const preferredIndex = findPreferredTierIndex(
    tiers.map((tier) => tier.price),
    amount,
    currencyCode
  );

  if (preferredIndex === null) {
    return null;
  }

  const preferred = tiers[preferredIndex];

  return {
    tier: preferred.tier,
    price: preferred.price,
  };
}
