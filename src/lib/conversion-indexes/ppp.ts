// PPP (Purchasing Power Parity) data for regional pricing
// PPP multipliers synced from World Bank API on 2026-02-01
// Source: PA.NUS.PPP indicator (PPP conversion factor, GDP)
// Formula: pppMultiplier = PPP Conversion Factor / Market Exchange Rate

export interface PricingIndexEntry {
  regionCode: string;
  pppMultiplier: number;      // PPP adjustment (0.1 - 2.0)
  minPrice: number;           // Minimum price in local currency
  suggestedRounding: number;  // e.g., 0.99, 0.00, 9.00
}

// PPP multipliers adjust prices based on purchasing power
// US = 1.0 (base reference)
// Lower values = lower prices for lower purchasing power regions
// Higher values = similar or premium pricing for high purchasing power regions
export const PRICING_INDEX: Record<string, PricingIndexEntry> = {
  // North America
  US: { regionCode: 'US', pppMultiplier: 1.0, minPrice: 0.99, suggestedRounding: 0.99 },
  CA: { regionCode: 'CA', pppMultiplier: 0.85, minPrice: 0.99, suggestedRounding: 0.99 },
  MX: { regionCode: 'MX', pppMultiplier: 0.57, minPrice: 10, suggestedRounding: 0 },

  // Western Europe
  GB: { regionCode: 'GB', pppMultiplier: 0.91, minPrice: 0.79, suggestedRounding: 0.99 },
  DE: { regionCode: 'DE', pppMultiplier: 0.83, minPrice: 0.99, suggestedRounding: 0.99 },
  FR: { regionCode: 'FR', pppMultiplier: 0.81, minPrice: 0.99, suggestedRounding: 0.99 },
  IT: { regionCode: 'IT', pppMultiplier: 0.71, minPrice: 0.99, suggestedRounding: 0.99 },
  ES: { regionCode: 'ES', pppMultiplier: 0.67, minPrice: 0.99, suggestedRounding: 0.99 },
  NL: { regionCode: 'NL', pppMultiplier: 0.87, minPrice: 0.99, suggestedRounding: 0.99 },
  BE: { regionCode: 'BE', pppMultiplier: 0.84, minPrice: 0.99, suggestedRounding: 0.99 },
  AT: { regionCode: 'AT', pppMultiplier: 0.84, minPrice: 0.99, suggestedRounding: 0.99 },
  CH: { regionCode: 'CH', pppMultiplier: 1.23, minPrice: 0.99, suggestedRounding: 0.00 },
  IE: { regionCode: 'IE', pppMultiplier: 0.88, minPrice: 0.99, suggestedRounding: 0.99 },
  PT: { regionCode: 'PT', pppMultiplier: 0.61, minPrice: 0.99, suggestedRounding: 0.99 },
  LU: { regionCode: 'LU', pppMultiplier: 0.97, minPrice: 0.99, suggestedRounding: 0.99 },
  MC: { regionCode: 'MC', pppMultiplier: 0.81, minPrice: 0.99, suggestedRounding: 0.99 },
  SM: { regionCode: 'SM', pppMultiplier: 0.84, minPrice: 0.99, suggestedRounding: 0.99 },
  VA: { regionCode: 'VA', pppMultiplier: 0.81, minPrice: 0.99, suggestedRounding: 0.99 },
  LI: { regionCode: 'LI', pppMultiplier: 1.23, minPrice: 0.99, suggestedRounding: 0.00 },

  // Northern Europe
  SE: { regionCode: 'SE', pppMultiplier: 0.96, minPrice: 9, suggestedRounding: 0 },
  NO: { regionCode: 'NO', pppMultiplier: 0.95, minPrice: 9, suggestedRounding: 0 },
  DK: { regionCode: 'DK', pppMultiplier: 0.96, minPrice: 6, suggestedRounding: 0 },
  FI: { regionCode: 'FI', pppMultiplier: 0.90, minPrice: 0.99, suggestedRounding: 0.99 },
  IS: { regionCode: 'IS', pppMultiplier: 1.16, minPrice: 0.99, suggestedRounding: 0.99 },

  // Eastern Europe
  PL: { regionCode: 'PL', pppMultiplier: 0.55, minPrice: 2, suggestedRounding: 0.99 },
  CZ: { regionCode: 'CZ', pppMultiplier: 0.63, minPrice: 19, suggestedRounding: 0 },
  HU: { regionCode: 'HU', pppMultiplier: 0.55, minPrice: 299, suggestedRounding: 0 },
  RO: { regionCode: 'RO', pppMultiplier: 0.44, minPrice: 4, suggestedRounding: 0.99 },
  BG: { regionCode: 'BG', pppMultiplier: 0.46, minPrice: 0.99, suggestedRounding: 0.99 },
  SK: { regionCode: 'SK', pppMultiplier: 0.60, minPrice: 0.99, suggestedRounding: 0.99 },
  SI: { regionCode: 'SI', pppMultiplier: 0.65, minPrice: 0.99, suggestedRounding: 0.99 },
  HR: { regionCode: 'HR', pppMultiplier: 0.53, minPrice: 0.99, suggestedRounding: 0.99 },
  RS: { regionCode: 'RS', pppMultiplier: 0.46, minPrice: 99, suggestedRounding: 0 },
  BA: { regionCode: 'BA', pppMultiplier: 0.44, minPrice: 0.99, suggestedRounding: 0.99 },
  MK: { regionCode: 'MK', pppMultiplier: 0.38, minPrice: 0.99, suggestedRounding: 0.99 },
  AL: { regionCode: 'AL', pppMultiplier: 0.48, minPrice: 0.99, suggestedRounding: 0.99 },
  MD: { regionCode: 'MD', pppMultiplier: 0.43, minPrice: 0.99, suggestedRounding: 0.99 },

  // Baltic States
  EE: { regionCode: 'EE', pppMultiplier: 0.69, minPrice: 0.99, suggestedRounding: 0.99 },
  LV: { regionCode: 'LV', pppMultiplier: 0.59, minPrice: 0.99, suggestedRounding: 0.99 },
  LT: { regionCode: 'LT', pppMultiplier: 0.58, minPrice: 0.99, suggestedRounding: 0.99 },

  // CIS & Eastern
  RU: { regionCode: 'RU', pppMultiplier: 0.38, minPrice: 59, suggestedRounding: 0 },
  UA: { regionCode: 'UA', pppMultiplier: 0.27, minPrice: 19, suggestedRounding: 0 },
  BY: { regionCode: 'BY', pppMultiplier: 0.29, minPrice: 0.99, suggestedRounding: 0.99 },
  KZ: { regionCode: 'KZ', pppMultiplier: 0.32, minPrice: 399, suggestedRounding: 0 },
  UZ: { regionCode: 'UZ', pppMultiplier: 0.28, minPrice: 0.99, suggestedRounding: 0.99 },
  KG: { regionCode: 'KG', pppMultiplier: 0.30, minPrice: 0.99, suggestedRounding: 0.99 },
  TJ: { regionCode: 'TJ', pppMultiplier: 0.29, minPrice: 0.99, suggestedRounding: 0.99 },
  TM: { regionCode: 'TM', pppMultiplier: 0.43, minPrice: 0.99, suggestedRounding: 0.99 },
  AM: { regionCode: 'AM', pppMultiplier: 0.39, minPrice: 0.99, suggestedRounding: 0.99 },
  AZ: { regionCode: 'AZ', pppMultiplier: 0.29, minPrice: 0.99, suggestedRounding: 0.99 },
  GE: { regionCode: 'GE', pppMultiplier: 0.33, minPrice: 2, suggestedRounding: 0.99 },

  // Middle East
  IL: { regionCode: 'IL', pppMultiplier: 1.13, minPrice: 3, suggestedRounding: 0.90 },
  AE: { regionCode: 'AE', pppMultiplier: 0.63, minPrice: 3, suggestedRounding: 0.99 },
  SA: { regionCode: 'SA', pppMultiplier: 0.49, minPrice: 3, suggestedRounding: 0.99 },
  QA: { regionCode: 'QA', pppMultiplier: 0.61, minPrice: 3, suggestedRounding: 0.99 },
  KW: { regionCode: 'KW', pppMultiplier: 0.63, minPrice: 0.99, suggestedRounding: 0.99 },
  BH: { regionCode: 'BH', pppMultiplier: 0.44, minPrice: 0.99, suggestedRounding: 0.99 },
  OM: { regionCode: 'OM', pppMultiplier: 0.49, minPrice: 0.99, suggestedRounding: 0.99 },
  JO: { regionCode: 'JO', pppMultiplier: 0.43, minPrice: 0.50, suggestedRounding: 0.99 },
  LB: { regionCode: 'LB', pppMultiplier: 0.27, minPrice: 0.99, suggestedRounding: 0.99 },
  IQ: { regionCode: 'IQ', pppMultiplier: 0.42, minPrice: 999, suggestedRounding: 0 },
  YE: { regionCode: 'YE', pppMultiplier: 0.39, minPrice: 0.99, suggestedRounding: 0.99 },

  // Asia Pacific - Developed
  JP: { regionCode: 'JP', pppMultiplier: 0.61, minPrice: 100, suggestedRounding: 0 },
  KR: { regionCode: 'KR', pppMultiplier: 0.56, minPrice: 1000, suggestedRounding: 0 },
  AU: { regionCode: 'AU', pppMultiplier: 0.96, minPrice: 0.99, suggestedRounding: 0.99 },
  NZ: { regionCode: 'NZ', pppMultiplier: 0.88, minPrice: 0.99, suggestedRounding: 0.99 },
  SG: { regionCode: 'SG', pppMultiplier: 0.63, minPrice: 0.98, suggestedRounding: 0.98 },
  HK: { regionCode: 'HK', pppMultiplier: 0.72, minPrice: 8, suggestedRounding: 0 },
  TW: { regionCode: 'TW', pppMultiplier: 0.60, minPrice: 30, suggestedRounding: 0 },
  MO: { regionCode: 'MO', pppMultiplier: 0.57, minPrice: 8, suggestedRounding: 0 },

  // Asia Pacific - Emerging
  IN: { regionCode: 'IN', pppMultiplier: 0.22, minPrice: 10, suggestedRounding: 0 },
  ID: { regionCode: 'ID', pppMultiplier: 0.28, minPrice: 10000, suggestedRounding: 0 },
  MY: { regionCode: 'MY', pppMultiplier: 0.36, minPrice: 3, suggestedRounding: 0.90 },
  TH: { regionCode: 'TH', pppMultiplier: 0.33, minPrice: 29, suggestedRounding: 0 },
  VN: { regionCode: 'VN', pppMultiplier: 0.27, minPrice: 20000, suggestedRounding: 0 },
  PH: { regionCode: 'PH', pppMultiplier: 0.33, minPrice: 49, suggestedRounding: 0 },
  PK: { regionCode: 'PK', pppMultiplier: 0.24, minPrice: 150, suggestedRounding: 0 },
  BD: { regionCode: 'BD', pppMultiplier: 0.24, minPrice: 80, suggestedRounding: 0 },
  LK: { regionCode: 'LK', pppMultiplier: 0.28, minPrice: 199, suggestedRounding: 0 },
  NP: { regionCode: 'NP', pppMultiplier: 0.23, minPrice: 0.99, suggestedRounding: 0.99 },
  MM: { regionCode: 'MM', pppMultiplier: 0.23, minPrice: 1000, suggestedRounding: 0 },
  KH: { regionCode: 'KH', pppMultiplier: 0.33, minPrice: 0.99, suggestedRounding: 0.99 },
  LA: { regionCode: 'LA', pppMultiplier: 0.20, minPrice: 0.99, suggestedRounding: 0.99 },
  MN: { regionCode: 'MN', pppMultiplier: 0.34, minPrice: 2500, suggestedRounding: 0 },
  MV: { regionCode: 'MV', pppMultiplier: 0.51, minPrice: 0.99, suggestedRounding: 0.99 },

  // Latin America
  BR: { regionCode: 'BR', pppMultiplier: 0.48, minPrice: 4, suggestedRounding: 0.90 },
  AR: { regionCode: 'AR', pppMultiplier: 0.29, minPrice: 0.99, suggestedRounding: 0.99 }, // Uses USD
  CL: { regionCode: 'CL', pppMultiplier: 0.51, minPrice: 500, suggestedRounding: 0 },
  CO: { regionCode: 'CO', pppMultiplier: 0.39, minPrice: 2900, suggestedRounding: 0 },
  PE: { regionCode: 'PE', pppMultiplier: 0.53, minPrice: 3, suggestedRounding: 0.90 },
  EC: { regionCode: 'EC', pppMultiplier: 0.43, minPrice: 0.99, suggestedRounding: 0.99 },
  VE: { regionCode: 'VE', pppMultiplier: 0.10, minPrice: 0.99, suggestedRounding: 0.99 },
  BO: { regionCode: 'BO', pppMultiplier: 0.34, minPrice: 6, suggestedRounding: 0.90 },
  PY: { regionCode: 'PY', pppMultiplier: 0.39, minPrice: 5000, suggestedRounding: 0 },
  UY: { regionCode: 'UY', pppMultiplier: 0.70, minPrice: 0.99, suggestedRounding: 0.99 },

  // Central America & Caribbean
  GT: { regionCode: 'GT', pppMultiplier: 0.43, minPrice: 0.99, suggestedRounding: 0.99 },
  CR: { regionCode: 'CR', pppMultiplier: 0.62, minPrice: 500, suggestedRounding: 0 },
  PA: { regionCode: 'PA', pppMultiplier: 0.46, minPrice: 0.99, suggestedRounding: 0.99 },
  SV: { regionCode: 'SV', pppMultiplier: 0.42, minPrice: 0.99, suggestedRounding: 0.99 },
  HN: { regionCode: 'HN', pppMultiplier: 0.43, minPrice: 0.99, suggestedRounding: 0.99 },
  NI: { regionCode: 'NI', pppMultiplier: 0.33, minPrice: 0.99, suggestedRounding: 0.99 },
  BZ: { regionCode: 'BZ', pppMultiplier: 0.54, minPrice: 0.99, suggestedRounding: 0.99 },
  DO: { regionCode: 'DO', pppMultiplier: 0.37, minPrice: 0.99, suggestedRounding: 0.99 },
  JM: { regionCode: 'JM', pppMultiplier: 0.60, minPrice: 0.99, suggestedRounding: 0.99 },
  TT: { regionCode: 'TT', pppMultiplier: 0.52, minPrice: 0.99, suggestedRounding: 0.99 },
  HT: { regionCode: 'HT', pppMultiplier: 0.68, minPrice: 0.99, suggestedRounding: 0.99 },
  BS: { regionCode: 'BS', pppMultiplier: 0.96, minPrice: 0.99, suggestedRounding: 0.99 },
  BB: { regionCode: 'BB', pppMultiplier: 1.07, minPrice: 0.99, suggestedRounding: 0.99 },
  AG: { regionCode: 'AG', pppMultiplier: 0.71, minPrice: 0.99, suggestedRounding: 0.99 },
  DM: { regionCode: 'DM', pppMultiplier: 0.49, minPrice: 0.99, suggestedRounding: 0.99 },
  GD: { regionCode: 'GD', pppMultiplier: 0.58, minPrice: 0.99, suggestedRounding: 0.99 },
  KN: { regionCode: 'KN', pppMultiplier: 0.69, minPrice: 0.99, suggestedRounding: 0.99 },
  LC: { regionCode: 'LC', pppMultiplier: 0.51, minPrice: 0.99, suggestedRounding: 0.99 },
  AW: { regionCode: 'AW', pppMultiplier: 0.78, minPrice: 0.99, suggestedRounding: 0.99 },
  KY: { regionCode: 'KY', pppMultiplier: 1.12, minPrice: 0.99, suggestedRounding: 0.99 },
  VG: { regionCode: 'VG', pppMultiplier: 1.02, minPrice: 0.99, suggestedRounding: 0.99 },
  TC: { regionCode: 'TC', pppMultiplier: 0.99, minPrice: 0.99, suggestedRounding: 0.99 },
  BM: { regionCode: 'BM', pppMultiplier: 1.15, minPrice: 0.99, suggestedRounding: 0.99 },
  SR: { regionCode: 'SR', pppMultiplier: 0.28, minPrice: 0.99, suggestedRounding: 0.99 },

  // Africa - North
  EG: { regionCode: 'EG', pppMultiplier: 0.13, minPrice: 19, suggestedRounding: 0.99 },
  MA: { regionCode: 'MA', pppMultiplier: 0.44, minPrice: 9, suggestedRounding: 0.00 },
  DZ: { regionCode: 'DZ', pppMultiplier: 0.34, minPrice: 99, suggestedRounding: 0 },
  TN: { regionCode: 'TN', pppMultiplier: 0.32, minPrice: 0.99, suggestedRounding: 0.99 },
  LY: { regionCode: 'LY', pppMultiplier: 0.35, minPrice: 0.99, suggestedRounding: 0.99 },

  // Africa - Sub-Saharan
  ZA: { regionCode: 'ZA', pppMultiplier: 0.46, minPrice: 9, suggestedRounding: 0.99 },
  NG: { regionCode: 'NG', pppMultiplier: 0.13, minPrice: 200, suggestedRounding: 0 },
  KE: { regionCode: 'KE', pppMultiplier: 0.34, minPrice: 99, suggestedRounding: 0 },
  GH: { regionCode: 'GH', pppMultiplier: 0.39, minPrice: 5, suggestedRounding: 0.99 },
  TZ: { regionCode: 'TZ', pppMultiplier: 0.29, minPrice: 2000, suggestedRounding: 0 },
  UG: { regionCode: 'UG', pppMultiplier: 0.35, minPrice: 0.99, suggestedRounding: 0.99 },
  RW: { regionCode: 'RW', pppMultiplier: 0.24, minPrice: 0.99, suggestedRounding: 0.99 },
  ET: { regionCode: 'ET', pppMultiplier: 0.18, minPrice: 0.99, suggestedRounding: 0.99 },
  SN: { regionCode: 'SN', pppMultiplier: 0.38, minPrice: 500, suggestedRounding: 0 },
  CI: { regionCode: 'CI', pppMultiplier: 0.39, minPrice: 500, suggestedRounding: 0 },
  CM: { regionCode: 'CM', pppMultiplier: 0.36, minPrice: 500, suggestedRounding: 0 },
  AO: { regionCode: 'AO', pppMultiplier: 0.29, minPrice: 0.99, suggestedRounding: 0.99 },
  MZ: { regionCode: 'MZ', pppMultiplier: 0.39, minPrice: 0.99, suggestedRounding: 0.99 },
  ZM: { regionCode: 'ZM', pppMultiplier: 0.37, minPrice: 0.99, suggestedRounding: 0.99 },
  ZW: { regionCode: 'ZW', pppMultiplier: 0.33, minPrice: 0.99, suggestedRounding: 0.99 },
  BW: { regionCode: 'BW', pppMultiplier: 0.37, minPrice: 0.99, suggestedRounding: 0.99 },
  NA: { regionCode: 'NA', pppMultiplier: 0.43, minPrice: 0.99, suggestedRounding: 0.99 },
  MU: { regionCode: 'MU', pppMultiplier: 0.39, minPrice: 0.99, suggestedRounding: 0.99 },
  SC: { regionCode: 'SC', pppMultiplier: 0.53, minPrice: 0.99, suggestedRounding: 0.99 },
  ML: { regionCode: 'ML', pppMultiplier: 0.36, minPrice: 0.99, suggestedRounding: 0.99 },
  BF: { regionCode: 'BF', pppMultiplier: 0.37, minPrice: 0.99, suggestedRounding: 0.99 },
  NE: { regionCode: 'NE', pppMultiplier: 0.39, minPrice: 0.99, suggestedRounding: 0.99 },
  TD: { regionCode: 'TD', pppMultiplier: 0.39, minPrice: 0.99, suggestedRounding: 0.99 },
  CF: { regionCode: 'CF', pppMultiplier: 0.45, minPrice: 0.99, suggestedRounding: 0.99 },
  CD: { regionCode: 'CD', pppMultiplier: 0.45, minPrice: 0.99, suggestedRounding: 0.99 },
  CG: { regionCode: 'CG', pppMultiplier: 0.39, minPrice: 0.99, suggestedRounding: 0.99 },
  GA: { regionCode: 'GA', pppMultiplier: 0.42, minPrice: 0.99, suggestedRounding: 0.99 },
  BJ: { regionCode: 'BJ', pppMultiplier: 0.37, minPrice: 0.99, suggestedRounding: 0.99 },
  TG: { regionCode: 'TG', pppMultiplier: 0.37, minPrice: 0.99, suggestedRounding: 0.99 },
  GN: { regionCode: 'GN', pppMultiplier: 0.36, minPrice: 0.99, suggestedRounding: 0.99 },
  GW: { regionCode: 'GW', pppMultiplier: 0.36, minPrice: 0.99, suggestedRounding: 0.99 },
  SL: { regionCode: 'SL', pppMultiplier: 0.10, minPrice: 0.99, suggestedRounding: 0.99 },
  LR: { regionCode: 'LR', pppMultiplier: 0.10, minPrice: 0.99, suggestedRounding: 0.99 },
  GM: { regionCode: 'GM', pppMultiplier: 0.23, minPrice: 0.99, suggestedRounding: 0.99 },
  CV: { regionCode: 'CV', pppMultiplier: 0.51, minPrice: 0.99, suggestedRounding: 0.99 },
  ER: { regionCode: 'ER', pppMultiplier: 0.33, minPrice: 0.99, suggestedRounding: 0.99 },
  DJ: { regionCode: 'DJ', pppMultiplier: 0.45, minPrice: 0.99, suggestedRounding: 0.99 },
  SO: { regionCode: 'SO', pppMultiplier: 2.00, minPrice: 0.99, suggestedRounding: 0.99 },
  KM: { regionCode: 'KM', pppMultiplier: 0.46, minPrice: 0.99, suggestedRounding: 0.99 },

  // Oceania & Pacific
  FJ: { regionCode: 'FJ', pppMultiplier: 0.43, minPrice: 0.99, suggestedRounding: 0.99 },
  PG: { regionCode: 'PG', pppMultiplier: 0.56, minPrice: 0.99, suggestedRounding: 0.99 },
  WS: { regionCode: 'WS', pppMultiplier: 0.63, minPrice: 0.99, suggestedRounding: 0.99 },
  TO: { regionCode: 'TO', pppMultiplier: 0.72, minPrice: 0.99, suggestedRounding: 0.99 },
  VU: { regionCode: 'VU', pppMultiplier: 0.95, minPrice: 0.99, suggestedRounding: 0.99 },
  SB: { regionCode: 'SB', pppMultiplier: 0.73, minPrice: 0.99, suggestedRounding: 0.99 },
  FM: { regionCode: 'FM', pppMultiplier: 0.96, minPrice: 0.99, suggestedRounding: 0.99 },

  // Turkey
  TR: { regionCode: 'TR', pppMultiplier: 0.26, minPrice: 19, suggestedRounding: 0.99 },

  // Mediterranean Islands
  CY: { regionCode: 'CY', pppMultiplier: 0.68, minPrice: 0.99, suggestedRounding: 0.99 },
  MT: { regionCode: 'MT', pppMultiplier: 0.68, minPrice: 0.99, suggestedRounding: 0.99 },
  GI: { regionCode: 'GI', pppMultiplier: 0.91, minPrice: 0.99, suggestedRounding: 0.99 },
  GR: { regionCode: 'GR', pppMultiplier: 0.61, minPrice: 0.99, suggestedRounding: 0.99 },
};

// Default entry for regions not in the index
export const DEFAULT_PRICING_INDEX_ENTRY: PricingIndexEntry = {
  regionCode: 'DEFAULT',
  pppMultiplier: 0.5,
  minPrice: 0.99,
  suggestedRounding: 0.99,
};

export function getPricingIndexEntry(regionCode: string): PricingIndexEntry {
  return PRICING_INDEX[regionCode] || { ...DEFAULT_PRICING_INDEX_ENTRY, regionCode };
}

// Map of region codes to their actual local currencies (what World Bank PPP data is based on)
// This may differ from what Apple/Google uses for billing
export const LOCAL_CURRENCIES: Record<string, string> = {
  // Americas
  US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN',
  VE: 'VES', EC: 'USD', UY: 'UYU', PY: 'PYG', BO: 'BOB', CR: 'CRC', PA: 'USD', GT: 'GTQ',
  HN: 'HNL', SV: 'USD', NI: 'NIO', DO: 'DOP', JM: 'JMD', TT: 'TTD', BS: 'BSD', BB: 'BBD',
  BZ: 'BZD', GY: 'GYD', SR: 'SRD', HT: 'HTG',
  // Caribbean (East Caribbean Dollar countries)
  AG: 'XCD', DM: 'XCD', GD: 'XCD', KN: 'XCD', LC: 'XCD', VC: 'XCD',
  // Caribbean/Atlantic (other)
  VG: 'USD', KY: 'KYD', TC: 'USD', AW: 'AWG', BM: 'BMD',
  // Europe
  GB: 'GBP', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR',
  CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', FI: 'EUR', PL: 'PLN', CZ: 'CZK', HU: 'HUF',
  RO: 'RON', BG: 'BGN', HR: 'EUR', SK: 'EUR', SI: 'EUR', LT: 'EUR', LV: 'EUR', EE: 'EUR',
  IE: 'EUR', PT: 'EUR', GR: 'EUR', LU: 'EUR', MT: 'EUR', CY: 'EUR', IS: 'ISK',
  RS: 'RSD', BA: 'BAM', MK: 'MKD', AL: 'ALL', ME: 'EUR', XK: 'EUR', MD: 'MDL',
  UA: 'UAH', BY: 'BYN', RU: 'RUB',
  // European microstates
  MC: 'EUR', LI: 'CHF', SM: 'EUR', VA: 'EUR', GI: 'GIP',
  // Middle East
  IL: 'ILS', AE: 'AED', SA: 'SAR', QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR',
  JO: 'JOD', LB: 'LBP', IQ: 'IQD', YE: 'YER', TR: 'TRY',
  // Asia
  JP: 'JPY', KR: 'KRW', CN: 'CNY', HK: 'HKD', TW: 'TWD', SG: 'SGD', MY: 'MYR',
  TH: 'THB', ID: 'IDR', PH: 'PHP', VN: 'VND', IN: 'INR', PK: 'PKR', BD: 'BDT',
  LK: 'LKR', NP: 'NPR', MM: 'MMK', KH: 'KHR', LA: 'LAK', MN: 'MNT', KZ: 'KZT',
  UZ: 'UZS', TM: 'TMT', KG: 'KGS', TJ: 'TJS', AZ: 'AZN', GE: 'GEL', AM: 'AMD',
  MO: 'MOP', BN: 'BND', BT: 'BTN', MV: 'MVR', AF: 'AFN',
  // Oceania
  AU: 'AUD', NZ: 'NZD', FJ: 'FJD', PG: 'PGK', SB: 'SBD', VU: 'VUV', WS: 'WST',
  TO: 'TOP', PW: 'USD', FM: 'USD',
  // Africa
  ZA: 'ZAR', EG: 'EGP', NG: 'NGN', KE: 'KES', GH: 'GHS', TZ: 'TZS', UG: 'UGX',
  ET: 'ETB', MA: 'MAD', DZ: 'DZD', TN: 'TND', LY: 'LYD', SD: 'SDG', AO: 'AOA',
  MZ: 'MZN', ZM: 'ZMW', ZW: 'ZWL', BW: 'BWP', NA: 'NAD', SZ: 'SZL', LS: 'LSL',
  MW: 'MWK', RW: 'RWF', BI: 'BIF', MG: 'MGA', MU: 'MUR', SC: 'SCR', CM: 'XAF',
  CI: 'XOF', SN: 'XOF', GN: 'GNF', ML: 'XOF', BF: 'XOF', NE: 'XOF', TG: 'XOF',
  BJ: 'XOF', GA: 'XAF', CG: 'XAF', CD: 'CDF', TD: 'XAF', CF: 'XAF', GQ: 'XAF',
  GM: 'GMD', GW: 'XOF', LR: 'LRD', SL: 'SLL', CV: 'CVE', ST: 'STN', MR: 'MRU',
  DJ: 'DJF', ER: 'ERN', SO: 'SOS', SS: 'SSP', KM: 'KMF',
};
