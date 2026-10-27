import { googlePlayFetch } from './client';
import type { RequestContext } from '../utils/request-budget';
import type { InAppProduct, Money } from './types';
import type { TokenSource } from '../token-source';
import { isZeroDecimalCurrency, roundDownToPriceEnding } from '../pricing/rounding';
import { assertExpectedPrices } from './expected-prices';

// Type for regional pricing config
interface RegionalPricingConfig {
  regionCode?: string;
  price?: {
    currencyCode?: string;
    units?: string;
    nanos?: number;
  };
  availability?: string;
}

// Type for purchase option
interface PurchaseOption {
  purchaseOptionId?: string;
  state?: string;
  regionalPricingAndAvailabilityConfigs?: RegionalPricingConfig[];
}

interface OneTimeProductListing {
  title?: string;
  description?: string;
  languageCode?: string;
}

interface OneTimeProduct {
  productId?: string;
  packageName?: string;
  listings?: Record<string, OneTimeProductListing> | OneTimeProductListing[];
  purchaseOptions?: PurchaseOption[];
  regionsVersion?: { version?: string };
}

interface OneTimeProductListResponse {
  oneTimeProducts?: OneTimeProduct[];
  nextPageToken?: string;
}

/**
 * Fallback regions version, used ONLY when the fetched product has no
 * `regionsVersion` of its own. We always prefer the product's own version so
 * a price edit never silently migrates it onto a newer region set.
 */
export const FALLBACK_PRODUCT_REGIONS_VERSION = '2022/02';

function resolveRegionsVersion(product: OneTimeProduct, productId: string): string {
  if (product.regionsVersion?.version) {
    return product.regionsVersion.version;
  }
  console.warn(
    `Product ${productId} has no regionsVersion; falling back to ${FALLBACK_PRODUCT_REGIONS_VERSION}`
  );
  return FALLBACK_PRODUCT_REGIONS_VERSION;
}

// Convert Google's OneTimeProduct to our InAppProduct type
function convertOneTimeProduct(product: OneTimeProduct): InAppProduct {
  const prices: Record<string, Money> = {};
  let defaultPrice: Money | undefined;
  let status: InAppProduct['status'] = 'active';

  const purchaseOptions = product.purchaseOptions;

  if (purchaseOptions && purchaseOptions.length > 0) {
    const firstOption = purchaseOptions[0];

    if (firstOption.state) {
      const stateStr = firstOption.state.toLowerCase();
      if (stateStr === 'active' || stateStr === 'inactive' || stateStr === 'statusUnspecified') {
        status = stateStr as InAppProduct['status'];
      }
    }

    const regionalConfigs = firstOption.regionalPricingAndAvailabilityConfigs;
    if (regionalConfigs && Array.isArray(regionalConfigs)) {
      for (const config of regionalConfigs) {
        if (config.regionCode && config.price) {
          prices[config.regionCode] = {
            currencyCode: config.price.currencyCode || 'USD',
            units: config.price.units || '0',
            nanos: config.price.nanos,
          };

          if (config.regionCode === 'US' && !defaultPrice) {
            defaultPrice = {
              currencyCode: config.price.currencyCode || 'USD',
              units: config.price.units || '0',
              nanos: config.price.nanos,
            };
          }
        }
      }
    }
  }

  if (!defaultPrice && Object.keys(prices).length > 0) {
    const firstRegion = Object.keys(prices)[0];
    defaultPrice = prices[firstRegion];
  }

  // listings can come back as a map (legacy) or array (new API). Normalise to a map.
  const rawListings = product.listings;
  const listings: Record<string, { title: string; description: string }> = {};
  if (rawListings) {
    if (Array.isArray(rawListings)) {
      for (const entry of rawListings) {
        const lang = entry.languageCode || 'en-US';
        listings[lang] = {
          title: entry.title || '',
          description: entry.description || '',
        };
      }
    } else {
      for (const [lang, listing] of Object.entries(rawListings)) {
        listings[lang] = {
          title: listing.title || '',
          description: listing.description || '',
        };
      }
    }
  }

  return {
    sku: product.productId || '',
    packageName: '',
    status,
    purchaseType: 'managedUser',
    defaultPrice: defaultPrice || { currencyCode: 'USD', units: '0' },
    prices,
    listings,
    defaultLanguage: Object.keys(listings)[0] || 'en-US',
  };
}

export async function listInAppProducts(
  tokens: TokenSource,
  packageName: string,
  ctx: RequestContext = {}
): Promise<InAppProduct[]> {
  const products: InAppProduct[] = [];
  let pageToken: string | undefined;

  do {
    const response = await googlePlayFetch<OneTimeProductListResponse>(
      tokens,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/oneTimeProducts`,
      {
        budget: ctx.budget,
        query: {
          pageSize: 100,
          pageToken,
        },
      }
    );

    if (response.oneTimeProducts) {
      for (const product of response.oneTimeProducts) {
        const converted = convertOneTimeProduct(product);
        converted.packageName = packageName;
        products.push(converted);
      }
    }

    pageToken = response.nextPageToken ?? undefined;
  } while (pageToken);

  return products;
}

export async function getInAppProduct(
  tokens: TokenSource,
  packageName: string,
  productId: string,
  ctx: RequestContext = {}
): Promise<InAppProduct | null> {
  try {
    const response = await googlePlayFetch<OneTimeProduct>(
      tokens,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/oneTimeProducts/${encodeURIComponent(productId)}`,
      { budget: ctx.budget }
    );

    const converted = convertOneTimeProduct(response);
    converted.packageName = packageName;
    return converted;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
      return null;
    }
    throw error;
  }
}

export async function getInAppProductRaw(
  tokens: TokenSource,
  packageName: string,
  productId: string,
  ctx: RequestContext = {}
): Promise<OneTimeProduct> {
  return googlePlayFetch<OneTimeProduct>(
    tokens,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/oneTimeProducts/${encodeURIComponent(productId)}`,
    { budget: ctx.budget }
  );
}

export async function updateInAppProductPrices(
  tokens: TokenSource,
  packageName: string,
  productId: string,
  prices: Record<string, Money>,
  _defaultPrice?: Money,
  ctx: RequestContext = {},
  options: { expected?: Record<string, Money> } = {}
): Promise<InAppProduct> {
  // Fetch current product to preserve untouched fields and existing availability.
  const currentProduct = await getInAppProductRaw(tokens, packageName, productId, ctx);

  const purchaseOptions = currentProduct.purchaseOptions || [];
  if (purchaseOptions.length === 0) {
    throw new Error('Product has no purchase options configured');
  }

  const existingConfigs = purchaseOptions[0].regionalPricingAndAvailabilityConfigs || [];
  // With `expected`: nothing is written unless every one of those regions still has that price
  assertExpectedPrices(Object.fromEntries(existingConfigs.filter((c) => c.regionCode).map((c) => [c.regionCode!, c.price as Money | undefined])), options.expected);

  // Only regions present in `prices` change. Every other region is re-sent
  // exactly as fetched (same object, same order). In particular a region that
  // came back without a price (or with a partial price) is never "repaired"
  // into USD 0: proto3 JSON omits zero/default fields, so the fetched shape is
  // already what Google considers valid, and inventing a USD price would either
  // be rejected (wrong currency for the region) or silently make it free.
  const remaining = new Map(Object.entries(prices));
  const updatedConfigs: RegionalPricingConfig[] = existingConfigs.map(existing => {
    const money = existing.regionCode ? remaining.get(existing.regionCode) : undefined;
    if (!existing.regionCode || !money) {
      return existing;
    }
    remaining.delete(existing.regionCode);
    return {
      ...existing,
      price: {
        currencyCode: money.currencyCode,
        units: money.units,
        nanos: money.nanos,
      },
    };
  });

  for (const [regionCode, money] of remaining) {
    updatedConfigs.push({
      regionCode,
      availability: 'AVAILABLE',
      price: {
        currencyCode: money.currencyCode,
        units: money.units,
        nanos: money.nanos,
      },
    });
  }

  purchaseOptions[0].regionalPricingAndAvailabilityConfigs = updatedConfigs;

  return patchPurchaseOptions(tokens, packageName, productId, currentProduct, ctx);
}

/**
 * Remove one region from the product's first purchase option.
 *
 * The region is filtered out of `regionalPricingAndAvailabilityConfigs` and the
 * rest of the product is PATCHed back exactly as fetched. If Google refuses to
 * drop the region (for example because it would leave the purchase option
 * without any priced region), its error is propagated unchanged so the caller
 * can show Google's reason.
 */
export async function deleteRegionPrice(
  tokens: TokenSource,
  packageName: string,
  productId: string,
  regionCode: string,
  ctx: RequestContext = {}
): Promise<InAppProduct> {
  const currentProduct = await getInAppProductRaw(tokens, packageName, productId, ctx);

  const purchaseOptions = currentProduct.purchaseOptions || [];
  if (purchaseOptions.length === 0) {
    throw new Error('Product has no purchase options configured');
  }

  const existingConfigs = purchaseOptions[0].regionalPricingAndAvailabilityConfigs || [];
  if (!existingConfigs.some(config => config.regionCode === regionCode)) {
    throw Object.assign(
      new Error(`Region ${regionCode} is not configured on product ${productId}`),
      { code: 404 }
    );
  }

  purchaseOptions[0].regionalPricingAndAvailabilityConfigs = existingConfigs.filter(
    config => config.regionCode !== regionCode
  );

  return patchPurchaseOptions(tokens, packageName, productId, currentProduct, ctx);
}

async function patchPurchaseOptions(
  tokens: TokenSource,
  packageName: string,
  productId: string,
  product: OneTimeProduct,
  ctx: RequestContext = {}
): Promise<InAppProduct> {
  // Google's discovery doc lists the PATCH path as lowercase `onetimeproducts`,
  // even though every other one-time-product method is camelCase. Don't "fix" this.
  const response = await googlePlayFetch<OneTimeProduct>(
    tokens,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/onetimeproducts/${encodeURIComponent(productId)}`,
    {
      budget: ctx.budget,
      method: 'PATCH',
      query: {
        'regionsVersion.version': resolveRegionsVersion(product, productId),
        updateMask: 'purchaseOptions',
      },
      body: product,
    }
  );

  const converted = convertOneTimeProduct(response);
  converted.packageName = packageName;
  return converted;
}

export function calculateNewPrice(
  currentPrice: Money,
  operation: { type: 'fixed' | 'percentage' | 'round'; value?: number; roundTo?: number }
): Money {
  const parsedUnits = parseFloat(currentPrice.units);
  if (isNaN(parsedUnits) || !Number.isFinite(parsedUnits)) {
    throw new Error(`Invalid price units value: "${currentPrice.units}"`);
  }
  const currentAmount = parsedUnits + (currentPrice.nanos ? currentPrice.nanos / 1_000_000_000 : 0);

  let newAmount: number;

  switch (operation.type) {
    case 'fixed':
      newAmount = operation.value ?? currentAmount;
      break;
    case 'percentage':
      newAmount = currentAmount * (1 + (operation.value ?? 0) / 100);
      break;
    case 'round':
      // Rounds DOWN to the nearest x.<roundTo> at or below the current price
      // (12.00 -> 11.99, 12.34 -> 11.99, 12.99 stays), so it never raises a
      // price. No-decimal currencies ignore roundTo and use 9/90 endings.
      newAmount = roundDownToPriceEnding(
        currentAmount,
        currentPrice.currencyCode,
        operation.roundTo ?? 0.99
      );
      break;
    default:
      newAmount = currentAmount;
  }

  newAmount = Math.max(0, newAmount);

  // No fractional amounts for JPY, KRW, etc.
  if (isZeroDecimalCurrency(currentPrice.currencyCode)) {
    newAmount = Math.round(newAmount);
  }

  let units = Math.floor(newAmount);
  let nanos = Math.round((newAmount - units) * 1_000_000_000);

  if (nanos > 999_999_999) {
    units += Math.floor(nanos / 1_000_000_000);
    nanos = nanos % 1_000_000_000;
  }

  return {
    currencyCode: currentPrice.currencyCode,
    units: units.toString(),
    nanos: nanos > 0 ? nanos : undefined,
  };
}
