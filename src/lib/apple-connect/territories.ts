// Apple App Store territories with ISO 3166-1 alpha-3 codes
// Apple uses alpha-3 codes (USA) while Google uses alpha-2 codes (US)

import { getAvailableCurrencies } from './price-tier-data';

// Territories that are NOT supported by Apple's IAP pricing API
// These cause 500 errors when included in price schedule updates
// See: https://developer.apple.com/help/app-store-connect/reference/app-store-pricing-and-availability-start-times-by-country-or-region/
export const UNSUPPORTED_IAP_TERRITORIES = [
  'BGD', // Bangladesh - not in Apple's pricing list
  'MCO', // Monaco - not in Apple's pricing list
  'WSM', // Samoa - not in Apple's pricing list
];

export interface AppleTerritoryInfo {
  alpha3: string; // ISO 3166-1 alpha-3 code (Apple uses this)
  alpha2: string; // ISO 3166-1 alpha-2 code (for conversion from Google)
  name: string;
  currency: string;
}

// Complete list of Apple App Store territories
export const APPLE_TERRITORIES: AppleTerritoryInfo[] = [
  { alpha3: 'AFG', alpha2: 'AF', name: 'Afghanistan', currency: 'USD' },
  { alpha3: 'ALB', alpha2: 'AL', name: 'Albania', currency: 'ALL' },
  { alpha3: 'DZA', alpha2: 'DZ', name: 'Algeria', currency: 'DZD' },
  { alpha3: 'AGO', alpha2: 'AO', name: 'Angola', currency: 'AOA' },
  { alpha3: 'AIA', alpha2: 'AI', name: 'Anguilla', currency: 'USD' },
  { alpha3: 'ATG', alpha2: 'AG', name: 'Antigua and Barbuda', currency: 'USD' },
  { alpha3: 'ARG', alpha2: 'AR', name: 'Argentina', currency: 'ARS' },
  { alpha3: 'ARM', alpha2: 'AM', name: 'Armenia', currency: 'AMD' },
  { alpha3: 'AUS', alpha2: 'AU', name: 'Australia', currency: 'AUD' },
  { alpha3: 'AUT', alpha2: 'AT', name: 'Austria', currency: 'EUR' },
  { alpha3: 'AZE', alpha2: 'AZ', name: 'Azerbaijan', currency: 'AZN' },
  { alpha3: 'BHS', alpha2: 'BS', name: 'Bahamas', currency: 'USD' },
  { alpha3: 'BHR', alpha2: 'BH', name: 'Bahrain', currency: 'BHD' },
  { alpha3: 'BGD', alpha2: 'BD', name: 'Bangladesh', currency: 'BDT' },
  { alpha3: 'BRB', alpha2: 'BB', name: 'Barbados', currency: 'BBD' },
  { alpha3: 'BLR', alpha2: 'BY', name: 'Belarus', currency: 'BYN' },
  { alpha3: 'BEL', alpha2: 'BE', name: 'Belgium', currency: 'EUR' },
  { alpha3: 'BLZ', alpha2: 'BZ', name: 'Belize', currency: 'BZD' },
  { alpha3: 'BEN', alpha2: 'BJ', name: 'Benin', currency: 'XOF' },
  { alpha3: 'BMU', alpha2: 'BM', name: 'Bermuda', currency: 'USD' },
  { alpha3: 'BTN', alpha2: 'BT', name: 'Bhutan', currency: 'BTN' },
  { alpha3: 'BOL', alpha2: 'BO', name: 'Bolivia', currency: 'BOB' },
  { alpha3: 'BIH', alpha2: 'BA', name: 'Bosnia and Herzegovina', currency: 'BAM' },
  { alpha3: 'BWA', alpha2: 'BW', name: 'Botswana', currency: 'BWP' },
  { alpha3: 'BRA', alpha2: 'BR', name: 'Brazil', currency: 'BRL' },
  { alpha3: 'VGB', alpha2: 'VG', name: 'British Virgin Islands', currency: 'USD' },
  { alpha3: 'BRN', alpha2: 'BN', name: 'Brunei', currency: 'BND' },
  { alpha3: 'BGR', alpha2: 'BG', name: 'Bulgaria', currency: 'BGN' },
  { alpha3: 'BFA', alpha2: 'BF', name: 'Burkina Faso', currency: 'XOF' },
  { alpha3: 'KHM', alpha2: 'KH', name: 'Cambodia', currency: 'KHR' },
  { alpha3: 'CMR', alpha2: 'CM', name: 'Cameroon', currency: 'XAF' },
  { alpha3: 'CAN', alpha2: 'CA', name: 'Canada', currency: 'CAD' },
  { alpha3: 'CPV', alpha2: 'CV', name: 'Cape Verde', currency: 'CVE' },
  { alpha3: 'CYM', alpha2: 'KY', name: 'Cayman Islands', currency: 'KYD' },
  { alpha3: 'TCD', alpha2: 'TD', name: 'Chad', currency: 'XAF' },
  { alpha3: 'CHL', alpha2: 'CL', name: 'Chile', currency: 'CLP' },
  { alpha3: 'CHN', alpha2: 'CN', name: 'China mainland', currency: 'CNY' },
  { alpha3: 'COL', alpha2: 'CO', name: 'Colombia', currency: 'COP' },
  { alpha3: 'COG', alpha2: 'CG', name: 'Congo (Republic)', currency: 'XAF' },
  { alpha3: 'COD', alpha2: 'CD', name: 'Congo (DRC)', currency: 'CDF' },
  { alpha3: 'CRI', alpha2: 'CR', name: 'Costa Rica', currency: 'CRC' },
  { alpha3: 'CIV', alpha2: 'CI', name: "Côte d'Ivoire", currency: 'XOF' },
  { alpha3: 'HRV', alpha2: 'HR', name: 'Croatia', currency: 'EUR' },
  { alpha3: 'CYP', alpha2: 'CY', name: 'Cyprus', currency: 'EUR' },
  { alpha3: 'CZE', alpha2: 'CZ', name: 'Czech Republic', currency: 'CZK' },
  { alpha3: 'DNK', alpha2: 'DK', name: 'Denmark', currency: 'DKK' },
  { alpha3: 'DMA', alpha2: 'DM', name: 'Dominica', currency: 'XCD' },
  { alpha3: 'DOM', alpha2: 'DO', name: 'Dominican Republic', currency: 'DOP' },
  { alpha3: 'ECU', alpha2: 'EC', name: 'Ecuador', currency: 'USD' },
  { alpha3: 'EGY', alpha2: 'EG', name: 'Egypt', currency: 'EGP' },
  { alpha3: 'SLV', alpha2: 'SV', name: 'El Salvador', currency: 'USD' },
  { alpha3: 'EST', alpha2: 'EE', name: 'Estonia', currency: 'EUR' },
  { alpha3: 'SWZ', alpha2: 'SZ', name: 'Eswatini', currency: 'SZL' },
  { alpha3: 'FJI', alpha2: 'FJ', name: 'Fiji', currency: 'FJD' },
  { alpha3: 'FIN', alpha2: 'FI', name: 'Finland', currency: 'EUR' },
  { alpha3: 'FRA', alpha2: 'FR', name: 'France', currency: 'EUR' },
  { alpha3: 'GAB', alpha2: 'GA', name: 'Gabon', currency: 'XAF' },
  { alpha3: 'GMB', alpha2: 'GM', name: 'Gambia', currency: 'GMD' },
  { alpha3: 'GEO', alpha2: 'GE', name: 'Georgia', currency: 'GEL' },
  { alpha3: 'DEU', alpha2: 'DE', name: 'Germany', currency: 'EUR' },
  { alpha3: 'GHA', alpha2: 'GH', name: 'Ghana', currency: 'GHS' },
  { alpha3: 'GRC', alpha2: 'GR', name: 'Greece', currency: 'EUR' },
  { alpha3: 'GRD', alpha2: 'GD', name: 'Grenada', currency: 'XCD' },
  { alpha3: 'GTM', alpha2: 'GT', name: 'Guatemala', currency: 'GTQ' },
  { alpha3: 'GNB', alpha2: 'GW', name: 'Guinea-Bissau', currency: 'XOF' },
  { alpha3: 'GUY', alpha2: 'GY', name: 'Guyana', currency: 'GYD' },
  { alpha3: 'HND', alpha2: 'HN', name: 'Honduras', currency: 'HNL' },
  { alpha3: 'HKG', alpha2: 'HK', name: 'Hong Kong', currency: 'HKD' },
  { alpha3: 'HUN', alpha2: 'HU', name: 'Hungary', currency: 'HUF' },
  { alpha3: 'ISL', alpha2: 'IS', name: 'Iceland', currency: 'ISK' },
  { alpha3: 'IND', alpha2: 'IN', name: 'India', currency: 'INR' },
  { alpha3: 'IDN', alpha2: 'ID', name: 'Indonesia', currency: 'IDR' },
  { alpha3: 'IRQ', alpha2: 'IQ', name: 'Iraq', currency: 'IQD' },
  { alpha3: 'IRL', alpha2: 'IE', name: 'Ireland', currency: 'EUR' },
  { alpha3: 'ISR', alpha2: 'IL', name: 'Israel', currency: 'ILS' },
  { alpha3: 'ITA', alpha2: 'IT', name: 'Italy', currency: 'EUR' },
  { alpha3: 'JAM', alpha2: 'JM', name: 'Jamaica', currency: 'JMD' },
  { alpha3: 'JPN', alpha2: 'JP', name: 'Japan', currency: 'JPY' },
  { alpha3: 'JOR', alpha2: 'JO', name: 'Jordan', currency: 'JOD' },
  { alpha3: 'KAZ', alpha2: 'KZ', name: 'Kazakhstan', currency: 'KZT' },
  { alpha3: 'KEN', alpha2: 'KE', name: 'Kenya', currency: 'KES' },
  { alpha3: 'KOR', alpha2: 'KR', name: 'South Korea', currency: 'KRW' },
  { alpha3: 'XKS', alpha2: 'XK', name: 'Kosovo', currency: 'EUR' },
  { alpha3: 'KWT', alpha2: 'KW', name: 'Kuwait', currency: 'KWD' },
  { alpha3: 'KGZ', alpha2: 'KG', name: 'Kyrgyzstan', currency: 'KGS' },
  { alpha3: 'LAO', alpha2: 'LA', name: 'Laos', currency: 'LAK' },
  { alpha3: 'LVA', alpha2: 'LV', name: 'Latvia', currency: 'EUR' },
  { alpha3: 'LBN', alpha2: 'LB', name: 'Lebanon', currency: 'LBP' },
  { alpha3: 'LBR', alpha2: 'LR', name: 'Liberia', currency: 'LRD' },
  { alpha3: 'LBY', alpha2: 'LY', name: 'Libya', currency: 'LYD' },
  { alpha3: 'LTU', alpha2: 'LT', name: 'Lithuania', currency: 'EUR' },
  { alpha3: 'LUX', alpha2: 'LU', name: 'Luxembourg', currency: 'EUR' },
  { alpha3: 'MAC', alpha2: 'MO', name: 'Macao', currency: 'MOP' },
  { alpha3: 'MKD', alpha2: 'MK', name: 'North Macedonia', currency: 'MKD' },
  { alpha3: 'MDG', alpha2: 'MG', name: 'Madagascar', currency: 'MGA' },
  { alpha3: 'MWI', alpha2: 'MW', name: 'Malawi', currency: 'MWK' },
  { alpha3: 'MYS', alpha2: 'MY', name: 'Malaysia', currency: 'MYR' },
  { alpha3: 'MDV', alpha2: 'MV', name: 'Maldives', currency: 'MVR' },
  { alpha3: 'MLI', alpha2: 'ML', name: 'Mali', currency: 'XOF' },
  { alpha3: 'MLT', alpha2: 'MT', name: 'Malta', currency: 'EUR' },
  { alpha3: 'MRT', alpha2: 'MR', name: 'Mauritania', currency: 'MRU' },
  { alpha3: 'MUS', alpha2: 'MU', name: 'Mauritius', currency: 'MUR' },
  { alpha3: 'MEX', alpha2: 'MX', name: 'Mexico', currency: 'MXN' },
  { alpha3: 'FSM', alpha2: 'FM', name: 'Micronesia', currency: 'USD' },
  { alpha3: 'MDA', alpha2: 'MD', name: 'Moldova', currency: 'MDL' },
  { alpha3: 'MCO', alpha2: 'MC', name: 'Monaco', currency: 'EUR' },
  { alpha3: 'MNG', alpha2: 'MN', name: 'Mongolia', currency: 'MNT' },
  { alpha3: 'MNE', alpha2: 'ME', name: 'Montenegro', currency: 'EUR' },
  { alpha3: 'MSR', alpha2: 'MS', name: 'Montserrat', currency: 'USD' },
  { alpha3: 'MAR', alpha2: 'MA', name: 'Morocco', currency: 'MAD' },
  { alpha3: 'MOZ', alpha2: 'MZ', name: 'Mozambique', currency: 'MZN' },
  { alpha3: 'MMR', alpha2: 'MM', name: 'Myanmar', currency: 'MMK' },
  { alpha3: 'NAM', alpha2: 'NA', name: 'Namibia', currency: 'NAD' },
  { alpha3: 'NRU', alpha2: 'NR', name: 'Nauru', currency: 'USD' },
  { alpha3: 'NPL', alpha2: 'NP', name: 'Nepal', currency: 'NPR' },
  { alpha3: 'NLD', alpha2: 'NL', name: 'Netherlands', currency: 'EUR' },
  { alpha3: 'NZL', alpha2: 'NZ', name: 'New Zealand', currency: 'NZD' },
  { alpha3: 'NIC', alpha2: 'NI', name: 'Nicaragua', currency: 'NIO' },
  { alpha3: 'NER', alpha2: 'NE', name: 'Niger', currency: 'XOF' },
  { alpha3: 'NGA', alpha2: 'NG', name: 'Nigeria', currency: 'NGN' },
  { alpha3: 'NOR', alpha2: 'NO', name: 'Norway', currency: 'NOK' },
  { alpha3: 'OMN', alpha2: 'OM', name: 'Oman', currency: 'OMR' },
  { alpha3: 'PAK', alpha2: 'PK', name: 'Pakistan', currency: 'PKR' },
  { alpha3: 'PLW', alpha2: 'PW', name: 'Palau', currency: 'USD' },
  { alpha3: 'PAN', alpha2: 'PA', name: 'Panama', currency: 'PAB' },
  { alpha3: 'PNG', alpha2: 'PG', name: 'Papua New Guinea', currency: 'PGK' },
  { alpha3: 'PRY', alpha2: 'PY', name: 'Paraguay', currency: 'PYG' },
  { alpha3: 'PER', alpha2: 'PE', name: 'Peru', currency: 'PEN' },
  { alpha3: 'PHL', alpha2: 'PH', name: 'Philippines', currency: 'PHP' },
  { alpha3: 'POL', alpha2: 'PL', name: 'Poland', currency: 'PLN' },
  { alpha3: 'PRT', alpha2: 'PT', name: 'Portugal', currency: 'EUR' },
  { alpha3: 'QAT', alpha2: 'QA', name: 'Qatar', currency: 'QAR' },
  { alpha3: 'ROU', alpha2: 'RO', name: 'Romania', currency: 'RON' },
  { alpha3: 'RUS', alpha2: 'RU', name: 'Russia', currency: 'RUB' },
  { alpha3: 'RWA', alpha2: 'RW', name: 'Rwanda', currency: 'RWF' },
  { alpha3: 'KNA', alpha2: 'KN', name: 'Saint Kitts and Nevis', currency: 'XCD' },
  { alpha3: 'LCA', alpha2: 'LC', name: 'Saint Lucia', currency: 'XCD' },
  { alpha3: 'VCT', alpha2: 'VC', name: 'Saint Vincent and the Grenadines', currency: 'XCD' },
  { alpha3: 'WSM', alpha2: 'WS', name: 'Samoa', currency: 'WST' },
  { alpha3: 'STP', alpha2: 'ST', name: 'São Tomé and Príncipe', currency: 'STN' },
  { alpha3: 'SAU', alpha2: 'SA', name: 'Saudi Arabia', currency: 'SAR' },
  { alpha3: 'SEN', alpha2: 'SN', name: 'Senegal', currency: 'XOF' },
  { alpha3: 'SRB', alpha2: 'RS', name: 'Serbia', currency: 'RSD' },
  { alpha3: 'SYC', alpha2: 'SC', name: 'Seychelles', currency: 'SCR' },
  { alpha3: 'SLE', alpha2: 'SL', name: 'Sierra Leone', currency: 'SLL' },
  { alpha3: 'SGP', alpha2: 'SG', name: 'Singapore', currency: 'SGD' },
  { alpha3: 'SVK', alpha2: 'SK', name: 'Slovakia', currency: 'EUR' },
  { alpha3: 'SVN', alpha2: 'SI', name: 'Slovenia', currency: 'EUR' },
  { alpha3: 'SLB', alpha2: 'SB', name: 'Solomon Islands', currency: 'SBD' },
  { alpha3: 'ZAF', alpha2: 'ZA', name: 'South Africa', currency: 'ZAR' },
  { alpha3: 'ESP', alpha2: 'ES', name: 'Spain', currency: 'EUR' },
  { alpha3: 'LKA', alpha2: 'LK', name: 'Sri Lanka', currency: 'LKR' },
  { alpha3: 'SUR', alpha2: 'SR', name: 'Suriname', currency: 'SRD' },
  { alpha3: 'SWE', alpha2: 'SE', name: 'Sweden', currency: 'SEK' },
  { alpha3: 'CHE', alpha2: 'CH', name: 'Switzerland', currency: 'CHF' },
  { alpha3: 'TWN', alpha2: 'TW', name: 'Taiwan', currency: 'TWD' },
  { alpha3: 'TJK', alpha2: 'TJ', name: 'Tajikistan', currency: 'TJS' },
  { alpha3: 'TZA', alpha2: 'TZ', name: 'Tanzania', currency: 'TZS' },
  { alpha3: 'THA', alpha2: 'TH', name: 'Thailand', currency: 'THB' },
  { alpha3: 'TON', alpha2: 'TO', name: 'Tonga', currency: 'TOP' },
  { alpha3: 'TTO', alpha2: 'TT', name: 'Trinidad and Tobago', currency: 'TTD' },
  { alpha3: 'TUN', alpha2: 'TN', name: 'Tunisia', currency: 'TND' },
  { alpha3: 'TUR', alpha2: 'TR', name: 'Turkey', currency: 'TRY' },
  { alpha3: 'TKM', alpha2: 'TM', name: 'Turkmenistan', currency: 'TMT' },
  { alpha3: 'TCA', alpha2: 'TC', name: 'Turks and Caicos Islands', currency: 'USD' },
  { alpha3: 'UGA', alpha2: 'UG', name: 'Uganda', currency: 'UGX' },
  { alpha3: 'UKR', alpha2: 'UA', name: 'Ukraine', currency: 'UAH' },
  { alpha3: 'ARE', alpha2: 'AE', name: 'United Arab Emirates', currency: 'AED' },
  { alpha3: 'GBR', alpha2: 'GB', name: 'United Kingdom', currency: 'GBP' },
  { alpha3: 'USA', alpha2: 'US', name: 'United States', currency: 'USD' },
  { alpha3: 'URY', alpha2: 'UY', name: 'Uruguay', currency: 'UYU' },
  { alpha3: 'UZB', alpha2: 'UZ', name: 'Uzbekistan', currency: 'UZS' },
  { alpha3: 'VUT', alpha2: 'VU', name: 'Vanuatu', currency: 'VUV' },
  { alpha3: 'VEN', alpha2: 'VE', name: 'Venezuela', currency: 'USD' },
  { alpha3: 'VNM', alpha2: 'VN', name: 'Vietnam', currency: 'VND' },
  { alpha3: 'YEM', alpha2: 'YE', name: 'Yemen', currency: 'YER' },
  { alpha3: 'ZMB', alpha2: 'ZM', name: 'Zambia', currency: 'ZMW' },
  { alpha3: 'ZWE', alpha2: 'ZW', name: 'Zimbabwe', currency: 'USD' },
];

// Create lookup maps for quick access
const alpha2ToTerritoryMap = new Map<string, AppleTerritoryInfo>();
const alpha3ToTerritoryMap = new Map<string, AppleTerritoryInfo>();

for (const territory of APPLE_TERRITORIES) {
  alpha2ToTerritoryMap.set(territory.alpha2, territory);
  alpha3ToTerritoryMap.set(territory.alpha3, territory);
}

// Convert Google Play region code (alpha-2) to Apple territory code (alpha-3)
export function alpha2ToAlpha3(alpha2: string): string | null {
  const territory = alpha2ToTerritoryMap.get(alpha2.toUpperCase());
  return territory?.alpha3 ?? null;
}

// Convert Apple territory code (alpha-3) to Google Play region code (alpha-2)
export function alpha3ToAlpha2(alpha3: string): string | null {
  const territory = alpha3ToTerritoryMap.get(alpha3.toUpperCase());
  return territory?.alpha2 ?? null;
}

// Get territory info by alpha-2 code
export function getTerritoryByAlpha2(
  alpha2: string
): AppleTerritoryInfo | null {
  return alpha2ToTerritoryMap.get(alpha2.toUpperCase()) ?? null;
}

// Get territory info by alpha-3 code
export function getTerritoryByAlpha3(
  alpha3: string
): AppleTerritoryInfo | null {
  return alpha3ToTerritoryMap.get(alpha3.toUpperCase()) ?? null;
}

// Get currency for a territory
export function getCurrencyForTerritory(territoryCode: string): string | null {
  // Try alpha-3 first, then alpha-2
  const territory =
    alpha3ToTerritoryMap.get(territoryCode.toUpperCase()) ??
    alpha2ToTerritoryMap.get(territoryCode.toUpperCase());
  return territory?.currency ?? null;
}

// Get all territories as a simple list
export function getAllTerritories(): AppleTerritoryInfo[] {
  return [...APPLE_TERRITORIES];
}

// Get territories sorted by name
export function getTerritoriesSortedByName(): AppleTerritoryInfo[] {
  return [...APPLE_TERRITORIES].sort((a, b) => a.name.localeCompare(b.name));
}

// Get territories for a specific currency
export function getTerritoriesForCurrency(
  currency: string
): AppleTerritoryInfo[] {
  return APPLE_TERRITORIES.filter(
    (t) => t.currency.toUpperCase() === currency.toUpperCase()
  );
}

// Get only territories that have valid Apple price tier data
// Filters out territories whose currencies are not in our cached tier data
export function getSupportedAppleTerritories(): AppleTerritoryInfo[] {
  const supportedCurrencies = new Set(getAvailableCurrencies());
  return APPLE_TERRITORIES.filter(
    (t) =>
      supportedCurrencies.has(t.currency) &&
      !UNSUPPORTED_IAP_TERRITORIES.includes(t.alpha3)
  );
}
