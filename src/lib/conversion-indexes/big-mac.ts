// Big Mac Index data for regional pricing
// Source: https://worldpopulationreview.com/country-rankings/big-mac-index-by-country
// The Economist's Big Mac Index - updated 2025

// Big Mac Index multipliers relative to US (US = 1.0)
// Calculated from percentage difference from US Big Mac price
// Example: India at -54.79% means multiplier = 1 - 0.5479 = 0.4521
export const BIG_MAC_INDEX: Record<string, number> = {
  // Higher than US
  CH: 1.38,   // Switzerland +38.04%
  AR: 1.20,   // Argentina +20.08%
  UY: 1.19,   // Uruguay +19.35%
  NO: 1.15,   // Norway +15.28%
  CR: 1.02,   // Costa Rica +1.93%

  // US baseline
  US: 1.00,   // United States

  // Lower than US
  GB: 0.99,   // United Kingdom -1.11%
  SE: 0.98,   // Sweden -2.09%
  DK: 0.95,   // Denmark -5.23%
  CA: 0.94,   // Canada -6.23%
  LB: 0.93,   // Lebanon -7.42%
  TR: 0.92,   // Turkey -8.18%
  PL: 0.90,   // Poland -10.01%
  CO: 0.89,   // Colombia -10.63%
  SG: 0.89,   // Singapore -10.72%
  SA: 0.87,   // Saudi Arabia -12.51%
  AE: 0.85,   // UAE -15.36%
  AU: 0.84,   // Australia -15.88%
  NZ: 0.82,   // New Zealand -17.55%
  IL: 0.81,   // Israel -18.57%
  MX: 0.79,   // Mexico -20.53%
  CZ: 0.79,   // Czechia -21.21%
  CL: 0.79,   // Chile -21.45%
  KW: 0.78,   // Kuwait -21.52%
  PE: 0.78,   // Peru -21.78%
  BH: 0.78,   // Bahrain -22.12%
  NI: 0.77,   // Nicaragua -22.66%
  VE: 0.77,   // Venezuela -23.08%
  HN: 0.71,   // Honduras -28.78%
  QA: 0.71,   // Qatar -28.85%
  BR: 0.70,   // Brazil -30.47%
  TH: 0.69,   // Thailand -30.8%
  GT: 0.69,   // Guatemala -30.66%
  OM: 0.69,   // Oman -31.36%
  KR: 0.66,   // South Korea -33.63%
  PK: 0.65,   // Pakistan -34.97%
  AZ: 0.63,   // Azerbaijan -36.61%
  HU: 0.63,   // Hungary -37.02%
  JO: 0.61,   // Jordan -39.1%
  CN: 0.61,   // China -39.24%
  MD: 0.61,   // Moldova -39.15%
  RO: 0.59,   // Romania -40.77%
  JP: 0.54,   // Japan -46.29%
  HK: 0.53,   // Hong Kong -46.77%
  VN: 0.52,   // Vietnam -47.66%
  MY: 0.52,   // Malaysia -48.13%
  PH: 0.50,   // Philippines -50.05%
  UA: 0.49,   // Ukraine -50.65%
  ZA: 0.48,   // South Africa -52.04%
  EG: 0.46,   // Egypt -53.6%
  IN: 0.45,   // India -54.79%
  ID: 0.44,   // Indonesia -56.22%
  TW: 0.41,   // Taiwan -58.84%
};

// Default multiplier for countries not in the index
export const DEFAULT_BIG_MAC_MULTIPLIER = 0.70;

// Get Big Mac Index multiplier for a region
export function getBigMacMultiplier(regionCode: string): number {
  return BIG_MAC_INDEX[regionCode] ?? DEFAULT_BIG_MAC_MULTIPLIER;
}

// Get all Big Mac Index data
export function getAllBigMacData(): Record<string, { multiplier: number; source: 'big-mac-index' | 'default' }> {
  const result: Record<string, { multiplier: number; source: 'big-mac-index' | 'default' }> = {};

  // Add all known countries
  for (const [regionCode, multiplier] of Object.entries(BIG_MAC_INDEX)) {
    result[regionCode] = { multiplier, source: 'big-mac-index' };
  }

  return result;
}
