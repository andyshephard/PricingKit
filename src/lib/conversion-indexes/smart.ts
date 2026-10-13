/**
 * Smart regional pricing for digital apps.
 *
 * This is intentionally NOT a cost-based index. For software with near-zero
 * marginal cost, the useful objective is revenue / LTV per eligible user, not
 * gross margin per transaction. Raw country PPP is still useful, but it tends
 * to over-discount because paid app users (especially on iOS) are a wealthier
 * subset of the population than the average consumer measured by PPP.
 *
 * The model therefore compresses World Bank PPP and applies broad mobile-app
 * market priors. V3 is intentionally revenue-tuned: mature Western markets,
 * developed East Asia, high-income Asian storefronts, and wealthy Gulf states
 * are kept closer to top-market pricing. It remains a starting prior for
 * markets without enough first-party experiment data; once an app has
 * sufficient volume, country-level RPU/LTV experiments should supersede it.
 *
 * Calibration references (reviewed 2026-09):
 * - RevenueCat, State of Subscription Apps 2026
 *   https://www.revenuecat.com/state-of-subscription-apps
 * - RevenueCat, Ultimate guide to price localization (2025)
 *   https://www.revenuecat.com/blog/growth/price-localization-for-apps
 * - Flo / Dmitry Gurski on regional pricing and optimizing RPU rather than CR
 *   https://subclub.com/episode/how-to-maximize-revenue-with-regional-pricing-dmitry-gurski-flo
 * - Jacob Rushfinn's basket of large apps (Calm, Strava, Duolingo, etc.)
 *   https://www.retention.blog/p/global-pricing-guidance
 */

export type PricingPlatform = 'apple' | 'google';

const WESTERN_EUROPE = new Set([
  'GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'FI', 'BE', 'AT', 'CH',
  'DK', 'IE', 'PT', 'LU', 'LI', 'IS', 'MC', 'MT',
]);

const DEVELOPED_EAST_ASIA = new Set(['JP', 'KR']);
const OCEANIA = new Set(['AU', 'NZ']);
const HIGH_INCOME_ASIA = new Set(['SG', 'HK']);

// High-income Asian storefronts that empirically belong below SG/HK but well
// above broad emerging-Asia pricing.
const SECONDARY_HIGH_INCOME_ASIA: Record<string, number> = {
  TW: 0.84,
  MO: 0.83,
  BN: 0.84,
};

// Central/Eastern Europe benefits from an explicit iOS prior rather than
// falling through generic PPP. These values intentionally sit between
// Western-Europe parity and emerging-market pricing.
const CEE_APPLE_PRIORS: Record<string, number> = {
  BG: 0.68,
  RO: 0.70,
  PL: 0.75,
  HU: 0.76,
  HR: 0.76,
  SK: 0.78,
  CZ: 0.80,
  LV: 0.78,
  LT: 0.78,
  EE: 0.84,
  SI: 0.82,
  GR: 0.79,
  CY: 0.83,
};

// High-income Latin American markets should not inherit the broad LATAM curve.
const HIGH_INCOME_LATAM_APPLE_PRIORS: Record<string, number> = {
  CL: 0.75,
  CR: 0.75,
  PA: 0.75,
  UY: 0.78,
  GY: 0.75,
  TT: 0.80,
};

// Sparse-market corrections discovered in the full 175-territory audit.
// These are deliberately iOS-oriented: paid iPhone users are wealthier than
// population averages, so very poor markets still keep a meaningful floor.
const SPARSE_APPLE_PRIORS: Record<string, number> = {
  AF: 0.45,
  BF: 0.45,
  TD: 0.45,
  CD: 0.45,
  GM: 0.45,
  GW: 0.45,
  MG: 0.45,
  MW: 0.45,
  ML: 0.45,
  MZ: 0.45,
  NE: 0.45,
  RW: 0.45,
  UG: 0.45,
  YE: 0.45,
  SO: 0.45,

  AO: 0.55,
  BJ: 0.55,
  BT: 0.55,
  CG: 0.55,
  SZ: 0.55,
  LB: 0.55,
  MR: 0.55,
  NA: 0.55,
  PG: 0.55,
  SB: 0.55,
  ST: 0.55,
  VU: 0.55,
  ZM: 0.55,

  FM: 0.72,
  TO: 0.72,
  NR: 0.80,
  PW: 0.80,
  SC: 0.80,
};

// Wealthy Gulf storefronts should not inherit the same deep-discount curve as
// lower-income MEA markets. Their paying iOS audience is much closer to
// top-market willingness-to-pay.
const HIGH_INCOME_GULF = new Set(['AE', 'QA', 'KW', 'BH', 'SA', 'OM']);

// RevenueCat's IN/SEA cohort plus nearby lower/middle-income Asian markets that
// show similar app-affordability dynamics. Singapore is handled separately.
const EMERGING_ASIA = new Set([
  'IN', 'ID', 'TH', 'PH', 'VN', 'MY', 'LK', 'PK', 'BD', 'NP', 'KH', 'LA', 'MM',
]);

const LATIN_AMERICA = new Set([
  'BR', 'MX', 'AR', 'CO', 'PE', 'EC', 'BO', 'PY',
  'DO', 'GT', 'HN', 'SV', 'NI',
]);

const MIDDLE_EAST_AFRICA = new Set([
  'ZA', 'EG', 'NG', 'KE', 'TR', 'JO', 'MA', 'TN', 'DZ', 'GH', 'TZ', 'UG',
  'ET', 'CM', 'SN', 'CI',
]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizePpp(
  livePppMultiplier: number,
  staticPppMultiplier?: number
): number {
  let ppp = Number.isFinite(livePppMultiplier) && livePppMultiplier > 0
    ? livePppMultiplier
    : staticPppMultiplier ?? 0.5;

  // Official/parallel FX dislocations in high-inflation markets can temporarily
  // make live PPP imply that a clearly lower-income market is MORE expensive
  // than the US. When the long-run static snapshot strongly disagrees, prefer
  // the conservative snapshot rather than generating a premium price by error.
  if (
    ppp > 1.15 &&
    staticPppMultiplier !== undefined &&
    staticPppMultiplier > 0 &&
    staticPppMultiplier < 0.75
  ) {
    ppp = staticPppMultiplier;
  }

  return clamp(ppp, 0.1, 1.6);
}

/**
 * Convert a raw US-relative PPP multiplier into an app-market multiplier.
 *
 * Why exponents < 1? `x^a` for 0 < x < 1 and a < 1 compresses the discount.
 * That models the selection effect that paying smartphone users are more
 * affluent than the population-wide consumer represented by raw PPP.
 *
 * Emerging-market iOS floors are higher than Android floors because observed
 * App Store payer value/pricing diverges materially from Google Play there.
 */
export function getSmartPricingMultiplier(
  regionCode: string,
  rawPppMultiplier: number,
  platform: PricingPlatform = 'apple',
  staticPppMultiplier?: number
): number {
  const code = regionCode.toUpperCase();
  if (code === 'US') return 1;

  const ppp = sanitizePpp(rawPppMultiplier, staticPppMultiplier);
  let multiplier: number;

  // Basket-of-app evidence puts Canada approximately at US parity.
  if (code === 'CA') {
    multiplier = 1;
  } else if (CEE_APPLE_PRIORS[code] !== undefined) {
    const applePrior = CEE_APPLE_PRIORS[code];
    multiplier = platform === 'apple'
      ? applePrior
      : clamp(applePrior * 0.90, 0.58, 0.78);
  } else if (SECONDARY_HIGH_INCOME_ASIA[code] !== undefined) {
    const applePrior = SECONDARY_HIGH_INCOME_ASIA[code];
    multiplier = platform === 'apple'
      ? applePrior
      : clamp(applePrior * 0.92, 0.72, 0.82);
  } else if (HIGH_INCOME_LATAM_APPLE_PRIORS[code] !== undefined) {
    const applePrior = HIGH_INCOME_LATAM_APPLE_PRIORS[code];
    multiplier = platform === 'apple'
      ? applePrior
      : clamp(applePrior * 0.90, 0.62, 0.75);
  } else if (SPARSE_APPLE_PRIORS[code] !== undefined) {
    const applePrior = SPARSE_APPLE_PRIORS[code];
    multiplier = platform === 'apple'
      ? applePrior
      : clamp(applePrior * 0.82, 0.32, 0.70);
  } else if (WESTERN_EUROPE.has(code)) {
    // RevenueCat 2026: Western Europe subscription pricing is near NA. V3
    // therefore compresses PPP more aggressively and raises the floor so
    // countries such as ES/PT are not discounted like emerging markets.
    multiplier = clamp(
      Math.pow(ppp, 0.25),
      0.90,
      platform === 'apple' ? 1.08 : 1.05
    );
  } else if (DEVELOPED_EAST_ASIA.has(code)) {
    // Japan and Korea have high-value paid-app audiences. V3 moves them closer
    // to top-market pricing while retaining a modest regional discount.
    multiplier = clamp(Math.pow(ppp, 0.30), 0.85, 0.95);
  } else if (OCEANIA.has(code)) {
    // Australia / New Zealand were already close to the desired revenue prior.
    multiplier = clamp(Math.pow(ppp, 0.45), 0.80, 0.95);
  } else if (HIGH_INCOME_ASIA.has(code)) {
    // Singapore / Hong Kong should sit materially above broad SEA pricing.
    multiplier = clamp(Math.pow(ppp, 0.25), 0.90, 1.00);
  } else if (HIGH_INCOME_GULF.has(code)) {
    // Wealthy Gulf states get their own curve instead of the deep-discount MEA
    // bucket. Apple is intentionally stronger because the iOS payer mix is
    // especially affluent; Google retains a modest platform discount.
    multiplier = platform === 'apple'
      ? clamp(Math.pow(ppp, 0.15), 0.88, 1.00)
      : clamp(Math.pow(ppp, 0.20), 0.82, 0.95);
  } else if (EMERGING_ASIA.has(code)) {
    if (platform === 'apple') {
      // RevenueCat: IN/SEA prices ~46-54% of top markets; iOS payer value is
      // materially stronger than Play. Avoid raw PPP floors around 0.20-0.30.
      multiplier = clamp(Math.pow(ppp, 0.62), 0.45, 0.78);
    } else {
      // IN/SEA Play annual median is materially lower than App Store pricing.
      multiplier = clamp(Math.pow(ppp, 0.72), 0.32, 0.68);
    }
  } else if (LATIN_AMERICA.has(code)) {
    // Basket-of-app guidance: BR roughly 40-55%, MX roughly 60-70% of US.
    // This reproduces that range from PPP without hardcoding every country.
    multiplier = platform === 'apple'
      ? clamp(Math.pow(ppp, 0.80), 0.40, 0.70)
      : clamp(Math.pow(ppp, 0.90), 0.35, 0.66);
  } else if (MIDDLE_EAST_AFRICA.has(code)) {
    // RevenueCat shows a pronounced App Store vs Play price gap in MEA.
    multiplier = platform === 'apple'
      ? clamp(Math.pow(ppp, 0.65), 0.40, 0.85)
      : clamp(Math.pow(ppp, 0.75), 0.34, 0.72);
  } else {
    // Sparse-data fallback: compressed PPP with a floor. Deliberately less
    // aggressive than raw PPP because the paid-app audience is usually richer.
    multiplier = platform === 'apple'
      ? clamp(Math.sqrt(ppp), 0.45, 1.08)
      : clamp(Math.pow(ppp, 0.60), 0.38, 1.03);
  }

  return Math.round(multiplier * 10_000) / 10_000;
}
