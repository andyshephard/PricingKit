// Google Play Developer API Type Definitions

export interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

export interface Money {
  currencyCode: string;
  units: string;
  nanos?: number;
}

export interface RegionalPrice {
  regionCode: string;
  price: Money;
}

export interface ConvertedPrice {
  regionCode: string;
  price: Money;
  taxInclusivePrice?: Money;
}

// In-App Product Types
export interface InAppProduct {
  packageName: string;
  sku: string;
  status: 'statusUnspecified' | 'active' | 'inactive';
  purchaseType: 'purchaseType' | 'managedUser' | 'subscription';
  defaultPrice: Money;
  prices: Record<string, Money>;
  listings: Record<string, InAppProductListing>;
  defaultLanguage: string;
  subscriptionPeriod?: string;
  trialPeriod?: string;
  gracePeriod?: string;
  managedProductTaxesAndComplianceSettings?: ManagedProductTaxAndComplianceSettings;
}

export interface InAppProductListing {
  title: string;
  description?: string;
  benefits?: string[];
}

export interface ManagedProductTaxAndComplianceSettings {
  eeaWithdrawalRightType?: 'withdrawalRightTypeUnspecified' | 'withdrawalRightDigitalContent' | 'withdrawalRightService';
  taxRateInfoByRegionCode?: Record<string, TaxRateInfo>;
  isTokenizedDigitalAsset?: boolean;
}

export interface TaxRateInfo {
  taxTier?: 'taxTierUnspecified' | 'taxTierBooks1' | 'taxTierNews1' | 'taxTierNews2' | 'taxTierMusic' | 'taxTierLive' | 'taxTierDefault';
  streamingTaxType?: 'streamingTaxTypeUnspecified' | 'streamingTaxIncluded' | 'streamingTaxNotIncluded';
}

// Regions Version - returned by Google Play API for currency/region support
export interface RegionsVersion {
  version: string;
}

// Subscription Types
export interface Subscription {
  packageName: string;
  productId: string;
  basePlans: BasePlan[];
  listings: SubscriptionListing[];
  archived?: boolean;
  taxAndComplianceSettings?: SubscriptionTaxAndComplianceSettings;
  regionsVersion?: RegionsVersion;
}

export interface BasePlan {
  basePlanId: string;
  state: 'stateUnspecified' | 'draft' | 'active' | 'inactive';
  regionalConfigs: RegionalBasePlanConfig[];
  autoRenewingBasePlanType?: AutoRenewingBasePlanType;
  prepaidBasePlanType?: PrepaidBasePlanType;
  offerTags?: OfferTag[];
  otherRegionsConfig?: OtherRegionsBasePlanConfig;
}

export interface RegionalBasePlanConfig {
  regionCode: string;
  newSubscriberAvailability?: boolean;
  price: Money;
}

export interface AutoRenewingBasePlanType {
  billingPeriodDuration: string;
  gracePeriodDuration?: string;
  accountHoldDuration?: string;
  resubscribeState?: 'resubscribeStateUnspecified' | 'resubscribeStateActive' | 'resubscribeStateInactive';
  prorationMode?: 'subscriptionProrationModeUnspecified' | 'subscriptionProrationModeChargeOnNextBillingDate' | 'subscriptionProrationModeChargeFullPriceImmediately';
  legacyCompatible?: boolean;
  legacyCompatibleSubscriptionOfferId?: string;
}

export interface PrepaidBasePlanType {
  billingPeriodDuration: string;
  timeExtension?: 'timeExtensionUnspecified' | 'timeExtensionActive' | 'timeExtensionInactive';
}

export interface OfferTag {
  tag: string;
}

export interface OtherRegionsBasePlanConfig {
  usdPrice: Money;
  eurPrice: Money;
  newSubscriberAvailability?: boolean;
}

export interface SubscriptionListing {
  languageCode: string;
  title: string;
  description?: string;
  benefits?: string[];
}

export interface SubscriptionTaxAndComplianceSettings {
  eeaWithdrawalRightType?: 'withdrawalRightTypeUnspecified' | 'withdrawalRightDigitalContent' | 'withdrawalRightService';
  taxRateInfoByRegionCode?: Record<string, TaxRateInfo>;
  isTokenizedDigitalAsset?: boolean;
}

// API Response Types
export interface InAppProductsListResponse {
  inappproduct: InAppProduct[];
  pageInfo?: PageInfo;
  tokenPagination?: TokenPagination;
}

export interface SubscriptionsListResponse {
  subscriptions: Subscription[];
  nextPageToken?: string;
}

export interface PageInfo {
  totalResults: number;
  resultPerPage: number;
  startIndex: number;
}

export interface TokenPagination {
  nextPageToken?: string;
  previousPageToken?: string;
}

// Update Request Types
export interface InAppProductPriceUpdate {
  sku: string;
  prices: Record<string, Money>;
  defaultPrice?: Money;
}

export interface BasePlanPriceUpdate {
  productId: string;
  basePlanId: string;
  regionalConfigs: RegionalBasePlanConfig[];
}

// Bulk Operation Types
export interface BulkPriceOperation {
  type: 'fixed' | 'percentage' | 'round';
  value?: number;
  roundTo?: number;
  targetRegions: string[];
}

export interface BulkUpdateRequest {
  items: Array<{
    type: 'product' | 'subscription';
    id: string;
    basePlanId?: string;
  }>;
  operation: BulkPriceOperation;
}

export interface BulkUpdateProgress {
  total: number;
  completed: number;
  failed: number;
  results: Array<{
    id: string;
    success: boolean;
    error?: string;
  }>;
}

// Complete list of Google Play supported regions with country names and currencies
export const GOOGLE_PLAY_REGIONS = [
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED' },
  { code: 'AG', name: 'Antigua and Barbuda', currency: 'USD' },
  { code: 'AL', name: 'Albania', currency: 'USD' },
  { code: 'AM', name: 'Armenia', currency: 'USD' },
  { code: 'AO', name: 'Angola', currency: 'USD' },
  { code: 'AR', name: 'Argentina', currency: 'USD' },
  { code: 'AT', name: 'Austria', currency: 'EUR' },
  { code: 'AU', name: 'Australia', currency: 'AUD' },
  { code: 'AW', name: 'Aruba', currency: 'USD' },
  { code: 'AZ', name: 'Azerbaijan', currency: 'USD' },
  { code: 'BA', name: 'Bosnia and Herzegovina', currency: 'USD' },
  { code: 'BD', name: 'Bangladesh', currency: 'BDT' },
  { code: 'BE', name: 'Belgium', currency: 'EUR' },
  { code: 'BF', name: 'Burkina Faso', currency: 'EUR' },
  { code: 'BG', name: 'Bulgaria', currency: 'EUR' },
  { code: 'BH', name: 'Bahrain', currency: 'USD' },
  { code: 'BJ', name: 'Benin', currency: 'EUR' },
  { code: 'BM', name: 'Bermuda', currency: 'USD' },
  { code: 'BO', name: 'Bolivia', currency: 'BOB' },
  { code: 'BR', name: 'Brazil', currency: 'BRL' },
  { code: 'BS', name: 'Bahamas', currency: 'USD' },
  { code: 'BW', name: 'Botswana', currency: 'USD' },
  { code: 'BY', name: 'Belarus', currency: 'USD' },
  { code: 'BZ', name: 'Belize', currency: 'USD' },
  { code: 'CA', name: 'Canada', currency: 'CAD' },
  { code: 'CD', name: 'Congo (DRC)', currency: 'USD' },
  { code: 'CF', name: 'Central African Republic', currency: 'EUR' },
  { code: 'CG', name: 'Congo (Republic)', currency: 'USD' },
  { code: 'CH', name: 'Switzerland', currency: 'CHF' },
  { code: 'CI', name: 'Côte d\'Ivoire', currency: 'XOF' },
  { code: 'CL', name: 'Chile', currency: 'CLP' },
  { code: 'CM', name: 'Cameroon', currency: 'XAF' },
  { code: 'CO', name: 'Colombia', currency: 'COP' },
  { code: 'CR', name: 'Costa Rica', currency: 'CRC' },
  { code: 'CV', name: 'Cabo Verde', currency: 'USD' },
  { code: 'CY', name: 'Cyprus', currency: 'EUR' },
  { code: 'CZ', name: 'Czech Republic', currency: 'CZK' },
  { code: 'DE', name: 'Germany', currency: 'EUR' },
  { code: 'DJ', name: 'Djibouti', currency: 'USD' },
  { code: 'DK', name: 'Denmark', currency: 'DKK' },
  { code: 'DM', name: 'Dominica', currency: 'USD' },
  { code: 'DO', name: 'Dominican Republic', currency: 'USD' },
  { code: 'DZ', name: 'Algeria', currency: 'DZD' },
  { code: 'EC', name: 'Ecuador', currency: 'USD' },
  { code: 'EE', name: 'Estonia', currency: 'EUR' },
  { code: 'EG', name: 'Egypt', currency: 'EGP' },
  { code: 'ER', name: 'Eritrea', currency: 'USD' },
  { code: 'ES', name: 'Spain', currency: 'EUR' },
  { code: 'FI', name: 'Finland', currency: 'EUR' },
  { code: 'FJ', name: 'Fiji', currency: 'USD' },
  { code: 'FM', name: 'Micronesia', currency: 'USD' },
  { code: 'FR', name: 'France', currency: 'EUR' },
  { code: 'GA', name: 'Gabon', currency: 'EUR' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP' },
  { code: 'GD', name: 'Grenada', currency: 'USD' },
  { code: 'GE', name: 'Georgia', currency: 'GEL' },
  { code: 'GH', name: 'Ghana', currency: 'GHS' },
  { code: 'GI', name: 'Gibraltar', currency: 'GBP' },
  { code: 'GM', name: 'Gambia', currency: 'USD' },
  { code: 'GN', name: 'Guinea', currency: 'USD' },
  { code: 'GR', name: 'Greece', currency: 'EUR' },
  { code: 'GT', name: 'Guatemala', currency: 'USD' },
  { code: 'GW', name: 'Guinea-Bissau', currency: 'EUR' },
  { code: 'HK', name: 'Hong Kong', currency: 'HKD' },
  { code: 'HN', name: 'Honduras', currency: 'USD' },
  { code: 'HR', name: 'Croatia', currency: 'EUR' },
  { code: 'HT', name: 'Haiti', currency: 'USD' },
  { code: 'HU', name: 'Hungary', currency: 'HUF' },
  { code: 'ID', name: 'Indonesia', currency: 'IDR' },
  { code: 'IE', name: 'Ireland', currency: 'EUR' },
  { code: 'IL', name: 'Israel', currency: 'ILS' },
  { code: 'IN', name: 'India', currency: 'INR' },
  { code: 'IQ', name: 'Iraq', currency: 'IQD' },
  { code: 'IS', name: 'Iceland', currency: 'EUR' },
  { code: 'IT', name: 'Italy', currency: 'EUR' },
  { code: 'JM', name: 'Jamaica', currency: 'USD' },
  { code: 'JO', name: 'Jordan', currency: 'JOD' },
  { code: 'JP', name: 'Japan', currency: 'JPY' },
  { code: 'KE', name: 'Kenya', currency: 'KES' },
  { code: 'KG', name: 'Kyrgyzstan', currency: 'USD' },
  { code: 'KH', name: 'Cambodia', currency: 'USD' },
  { code: 'KM', name: 'Comoros', currency: 'USD' },
  { code: 'KN', name: 'Saint Kitts and Nevis', currency: 'USD' },
  { code: 'KR', name: 'South Korea', currency: 'KRW' },
  { code: 'KW', name: 'Kuwait', currency: 'USD' },
  { code: 'KY', name: 'Cayman Islands', currency: 'USD' },
  { code: 'KZ', name: 'Kazakhstan', currency: 'KZT' },
  { code: 'LA', name: 'Laos', currency: 'USD' },
  { code: 'LB', name: 'Lebanon', currency: 'USD' },
  { code: 'LC', name: 'Saint Lucia', currency: 'USD' },
  { code: 'LI', name: 'Liechtenstein', currency: 'CHF' },
  { code: 'LK', name: 'Sri Lanka', currency: 'LKR' },
  { code: 'LR', name: 'Liberia', currency: 'USD' },
  { code: 'LT', name: 'Lithuania', currency: 'EUR' },
  { code: 'LU', name: 'Luxembourg', currency: 'EUR' },
  { code: 'LV', name: 'Latvia', currency: 'EUR' },
  { code: 'LY', name: 'Libya', currency: 'USD' },
  { code: 'MA', name: 'Morocco', currency: 'MAD' },
  { code: 'MC', name: 'Monaco', currency: 'EUR' },
  { code: 'MD', name: 'Moldova', currency: 'USD' },
  { code: 'MK', name: 'North Macedonia', currency: 'USD' },
  { code: 'ML', name: 'Mali', currency: 'EUR' },
  { code: 'MM', name: 'Myanmar', currency: 'MMK' },
  { code: 'MN', name: 'Mongolia', currency: 'MNT' },
  { code: 'MO', name: 'Macau', currency: 'MOP' },
  { code: 'MT', name: 'Malta', currency: 'EUR' },
  { code: 'MU', name: 'Mauritius', currency: 'USD' },
  { code: 'MV', name: 'Maldives', currency: 'USD' },
  { code: 'MX', name: 'Mexico', currency: 'MXN' },
  { code: 'MY', name: 'Malaysia', currency: 'MYR' },
  { code: 'MZ', name: 'Mozambique', currency: 'USD' },
  { code: 'NA', name: 'Namibia', currency: 'USD' },
  { code: 'NE', name: 'Niger', currency: 'EUR' },
  { code: 'NG', name: 'Nigeria', currency: 'NGN' },
  { code: 'NI', name: 'Nicaragua', currency: 'USD' },
  { code: 'NL', name: 'Netherlands', currency: 'EUR' },
  { code: 'NO', name: 'Norway', currency: 'NOK' },
  { code: 'NP', name: 'Nepal', currency: 'USD' },
  { code: 'NZ', name: 'New Zealand', currency: 'NZD' },
  { code: 'OM', name: 'Oman', currency: 'USD' },
  { code: 'PA', name: 'Panama', currency: 'USD' },
  { code: 'PE', name: 'Peru', currency: 'PEN' },
  { code: 'PG', name: 'Papua New Guinea', currency: 'USD' },
  { code: 'PH', name: 'Philippines', currency: 'PHP' },
  { code: 'PK', name: 'Pakistan', currency: 'PKR' },
  { code: 'PL', name: 'Poland', currency: 'PLN' },
  { code: 'PT', name: 'Portugal', currency: 'EUR' },
  { code: 'PY', name: 'Paraguay', currency: 'PYG' },
  { code: 'QA', name: 'Qatar', currency: 'QAR' },
  { code: 'RO', name: 'Romania', currency: 'RON' },
  { code: 'RS', name: 'Serbia', currency: 'RSD' },
  { code: 'RU', name: 'Russia', currency: 'RUB' },
  { code: 'RW', name: 'Rwanda', currency: 'USD' },
  { code: 'SA', name: 'Saudi Arabia', currency: 'SAR' },
  { code: 'SB', name: 'Solomon Islands', currency: 'USD' },
  { code: 'SC', name: 'Seychelles', currency: 'USD' },
  { code: 'SE', name: 'Sweden', currency: 'SEK' },
  { code: 'SG', name: 'Singapore', currency: 'SGD' },
  { code: 'SI', name: 'Slovenia', currency: 'EUR' },
  { code: 'SK', name: 'Slovakia', currency: 'EUR' },
  { code: 'SL', name: 'Sierra Leone', currency: 'USD' },
  { code: 'SM', name: 'San Marino', currency: 'EUR' },
  { code: 'SN', name: 'Senegal', currency: 'XOF' },
  { code: 'SO', name: 'Somalia', currency: 'USD' },
  { code: 'SR', name: 'Suriname', currency: 'USD' },
  { code: 'SV', name: 'El Salvador', currency: 'USD' },
  { code: 'TC', name: 'Turks and Caicos Islands', currency: 'USD' },
  { code: 'TD', name: 'Chad', currency: 'USD' },
  { code: 'TG', name: 'Togo', currency: 'EUR' },
  { code: 'TH', name: 'Thailand', currency: 'THB' },
  { code: 'TJ', name: 'Tajikistan', currency: 'USD' },
  { code: 'TM', name: 'Turkmenistan', currency: 'USD' },
  { code: 'TN', name: 'Tunisia', currency: 'USD' },
  { code: 'TO', name: 'Tonga', currency: 'USD' },
  { code: 'TR', name: 'Turkey', currency: 'TRY' },
  { code: 'TT', name: 'Trinidad and Tobago', currency: 'USD' },
  { code: 'TW', name: 'Taiwan', currency: 'TWD' },
  { code: 'TZ', name: 'Tanzania', currency: 'TZS' },
  { code: 'UA', name: 'Ukraine', currency: 'UAH' },
  { code: 'UG', name: 'Uganda', currency: 'USD' },
  { code: 'US', name: 'United States', currency: 'USD' },
  { code: 'UY', name: 'Uruguay', currency: 'USD' },
  { code: 'UZ', name: 'Uzbekistan', currency: 'USD' },
  { code: 'VA', name: 'Vatican City', currency: 'EUR' },
  { code: 'VE', name: 'Venezuela', currency: 'USD' },
  { code: 'VG', name: 'British Virgin Islands', currency: 'USD' },
  { code: 'VN', name: 'Vietnam', currency: 'VND' },
  { code: 'VU', name: 'Vanuatu', currency: 'USD' },
  { code: 'WS', name: 'Samoa', currency: 'USD' },
  { code: 'YE', name: 'Yemen', currency: 'USD' },
  { code: 'ZA', name: 'South Africa', currency: 'ZAR' },
  { code: 'ZM', name: 'Zambia', currency: 'USD' },
  { code: 'ZW', name: 'Zimbabwe', currency: 'USD' },
] as const;

export type RegionCode = typeof GOOGLE_PLAY_REGIONS[number]['code'];

// Helper function to format Money to display string
export function formatMoney(money: Money): string {
  const amount = parseFloat(money.units) + (money.nanos ? money.nanos / 1_000_000_000 : 0);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: money.currencyCode,
  }).format(amount);
}

// Helper function to parse string to Money
export function parseMoney(amount: number, currencyCode: string): Money {
  // Round to 2 decimal places first to avoid floating point precision issues
  // Google Play requires prices to be in valid currency increments
  const roundedAmount = Math.round(amount * 100) / 100;
  const units = Math.floor(roundedAmount);
  // nanos must be multiples of 10,000,000 (representing cents for 2-decimal currencies)
  const cents = Math.round((roundedAmount - units) * 100);
  const nanos = cents * 10_000_000;
  return {
    currencyCode,
    units: units.toString(),
    nanos: nanos > 0 ? nanos : undefined,
  };
}

// Helper function to get Money as number
export function moneyToNumber(money: Money): number {
  return parseFloat(money.units) + (money.nanos ? money.nanos / 1_000_000_000 : 0);
}
