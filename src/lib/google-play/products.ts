import { googlePlayFetch } from './client';
import type { ServiceAccountCredentials, InAppProduct, Money } from './types';

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
  credentials: ServiceAccountCredentials,
  packageName: string
): Promise<InAppProduct[]> {
  const products: InAppProduct[] = [];
  let pageToken: string | undefined;

  do {
    const response = await googlePlayFetch<OneTimeProductListResponse>(
      credentials,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/oneTimeProducts`,
      {
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
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string
): Promise<InAppProduct | null> {
  try {
    const response = await googlePlayFetch<OneTimeProduct>(
      credentials,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/oneTimeProducts/${encodeURIComponent(productId)}`
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
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string
): Promise<OneTimeProduct> {
  return googlePlayFetch<OneTimeProduct>(
    credentials,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/oneTimeProducts/${encodeURIComponent(productId)}`
  );
}

export async function updateInAppProductPrices(
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string,
  prices: Record<string, Money>,
  _defaultPrice?: Money
): Promise<InAppProduct> {
  // Fetch current product to preserve untouched fields and existing availability.
  const currentProduct = await getInAppProductRaw(credentials, packageName, productId);

  const purchaseOptions = currentProduct.purchaseOptions || [];
  if (purchaseOptions.length === 0) {
    throw new Error('Product has no purchase options configured');
  }

  const existingConfigs = purchaseOptions[0].regionalPricingAndAvailabilityConfigs || [];

  const existingConfigMap = new Map<string, RegionalPricingConfig>();
  for (const config of existingConfigs) {
    if (config.regionCode) {
      existingConfigMap.set(config.regionCode, config);
    }
  }

  const updatedConfigs: RegionalPricingConfig[] = Object.entries(prices).map(([regionCode, money]) => {
    const existing = existingConfigMap.get(regionCode);
    return {
      regionCode,
      availability: existing?.availability || 'AVAILABLE',
      price: {
        currencyCode: money.currencyCode,
        units: money.units,
        nanos: money.nanos,
      },
    };
  });

  for (const [regionCode, config] of existingConfigMap) {
    if (!prices[regionCode]) {
      updatedConfigs.push({
        regionCode,
        availability: config.availability || 'AVAILABLE',
        price: config.price
          ? {
              currencyCode: config.price.currencyCode || 'USD',
              units: config.price.units || '0',
              nanos: config.price.nanos,
            }
          : { currencyCode: 'USD', units: '0', nanos: undefined },
      });
    }
  }

  purchaseOptions[0].regionalPricingAndAvailabilityConfigs = updatedConfigs;

  const regionsVersionString = currentProduct.regionsVersion?.version || '2022/02';

  // Google's discovery doc lists the PATCH path as lowercase `onetimeproducts`,
  // even though every other one-time-product method is camelCase. Don't "fix" this.
  const response = await googlePlayFetch<OneTimeProduct>(
    credentials,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/onetimeproducts/${encodeURIComponent(productId)}`,
    {
      method: 'PATCH',
      query: {
        'regionsVersion.version': regionsVersionString,
        updateMask: 'purchaseOptions',
      },
      body: currentProduct,
    }
  );

  const converted = convertOneTimeProduct(response);
  converted.packageName = packageName;
  return converted;
}

export async function deleteRegionPrice(
  credentials: ServiceAccountCredentials,
  packageName: string,
  productId: string,
  _regionCode: string
): Promise<InAppProduct> {
  // Stub — region delete via the new API would need a full no-op patch with the region removed.
  // For now, return the current product unchanged.
  const product = await getInAppProduct(credentials, packageName, productId);
  if (!product) {
    throw new Error(`Product ${productId} not found`);
  }
  return product;
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
      const roundTo = operation.roundTo ?? 0.99;
      newAmount = Math.floor(currentAmount) + roundTo;
      break;
    default:
      newAmount = currentAmount;
  }

  newAmount = Math.max(0, newAmount);

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
