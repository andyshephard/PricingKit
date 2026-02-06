import type { AndroidPublisher } from './client';
import type { InAppProduct, Money } from './types';
import type { androidpublisher_v3 } from 'googleapis';

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

// Convert Google's OneTimeProduct to our InAppProduct type
function convertOneTimeProduct(
  product: androidpublisher_v3.Schema$OneTimeProduct
): InAppProduct {
  const prices: Record<string, Money> = {};
  let defaultPrice: Money | undefined;
  let status: InAppProduct['status'] = 'active';

  // Access purchaseOptions to get pricing
  const productAny = product as Record<string, unknown>;
  const purchaseOptions = productAny.purchaseOptions as PurchaseOption[] | undefined;

  if (purchaseOptions && purchaseOptions.length > 0) {
    const firstOption = purchaseOptions[0];

    // Get status from purchase option state
    if (firstOption.state) {
      const stateStr = firstOption.state.toLowerCase();
      if (stateStr === 'active' || stateStr === 'inactive' || stateStr === 'statusUnspecified') {
        status = stateStr as InAppProduct['status'];
      }
    }

    // Extract regional pricing
    const regionalConfigs = firstOption.regionalPricingAndAvailabilityConfigs;
    if (regionalConfigs && Array.isArray(regionalConfigs)) {
      for (const config of regionalConfigs) {
        if (config.regionCode && config.price) {
          prices[config.regionCode] = {
            currencyCode: config.price.currencyCode || 'USD',
            units: config.price.units || '0',
            nanos: config.price.nanos,
          };

          // Use US price as default if available
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

  // If no US price, use the first price as default
  if (!defaultPrice && Object.keys(prices).length > 0) {
    const firstRegion = Object.keys(prices)[0];
    defaultPrice = prices[firstRegion];
  }

  const listings = product.listings ? Object.entries(product.listings).reduce((acc, [lang, listing]) => {
    acc[lang] = {
      title: listing.title || '',
      description: listing.description || '',
    };
    return acc;
  }, {} as Record<string, { title: string; description: string }>) : {};

  return {
    sku: product.productId || '',
    packageName: '', // Will be filled in by the caller
    status,
    purchaseType: 'managedUser',
    defaultPrice: defaultPrice || { currencyCode: 'USD', units: '0' },
    prices,
    listings,
    defaultLanguage: Object.keys(listings)[0] || 'en-US',
  };
}

export async function listInAppProducts(
  client: AndroidPublisher,
  packageName: string
): Promise<InAppProduct[]> {
  const products: InAppProduct[] = [];
  let pageToken: string | undefined;

  do {
    const response = await client.monetization.onetimeproducts.list({
      packageName,
      pageToken,
      pageSize: 100,
    });

    if (response.data.oneTimeProducts) {
      for (const product of response.data.oneTimeProducts) {
        const converted = convertOneTimeProduct(product);
        converted.packageName = packageName;
        products.push(converted);
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return products;
}

export async function getInAppProduct(
  client: AndroidPublisher,
  packageName: string,
  productId: string
): Promise<InAppProduct | null> {
  try {
    const response = await client.monetization.onetimeproducts.get({
      packageName,
      productId,
    });

    const converted = convertOneTimeProduct(response.data);
    converted.packageName = packageName;
    return converted;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
      return null;
    }
    throw error;
  }
}

export async function updateInAppProductPrices(
  client: AndroidPublisher,
  packageName: string,
  productId: string,
  prices: Record<string, Money>,
  defaultPrice?: Money
): Promise<InAppProduct> {
  // For the new API, pricing is managed through purchase options
  // This is a simplified implementation - full implementation would need to handle
  // the purchase options and offers structure

  // First get the current product
  const currentProduct = await client.monetization.onetimeproducts.get({
    packageName,
    productId,
  });

  if (!currentProduct.data) {
    throw new Error(`Product ${productId} not found`);
  }

  // Get existing regional configs to preserve availability settings
  const productData = currentProduct.data as Record<string, unknown>;
  const purchaseOptions = (productData.purchaseOptions as Array<Record<string, unknown>>) || [];

  if (purchaseOptions.length === 0) {
    throw new Error('Product has no purchase options configured');
  }

  const existingConfigs = (purchaseOptions[0].regionalPricingAndAvailabilityConfigs as Array<{
    regionCode?: string;
    availability?: string;
    price?: { currencyCode?: string; units?: string; nanos?: number };
  }>) || [];

  // Create a map of existing configs for quick lookup
  const existingConfigMap = new Map<string, typeof existingConfigs[0]>();
  for (const config of existingConfigs) {
    if (config.regionCode) {
      existingConfigMap.set(config.regionCode, config);
    }
  }

  // Build updated regional pricing configs, preserving existing availability
  const updatedConfigs = Object.entries(prices).map(([regionCode, money]) => {
    const existing = existingConfigMap.get(regionCode);
    return {
      regionCode,
      // Preserve existing availability or default to available for new regions
      availability: existing?.availability || 'AVAILABLE',
      price: {
        currencyCode: money.currencyCode,
        units: money.units,
        nanos: money.nanos,
      },
    };
  });

  // Also include regions that weren't updated (to preserve their current state)
  for (const [regionCode, config] of existingConfigMap) {
    if (!prices[regionCode]) {
      updatedConfigs.push({
        regionCode,
        availability: config.availability || 'AVAILABLE',
        price: config.price ? {
          currencyCode: config.price.currencyCode || 'USD',
          units: config.price.units || '0',
          nanos: config.price.nanos,
        } : { currencyCode: 'USD', units: '0', nanos: undefined },
      });
    }
  }

  // Update the purchase options with new pricing
  purchaseOptions[0].regionalPricingAndAvailabilityConfigs = updatedConfigs;

  // Get the current regionsVersion from the product - required for updates
  // The regionsVersion is typically in the format { version: "2022/02" }
  const regionsVersionObj = productData.regionsVersion as { version: string } | undefined;
  const regionsVersionString = regionsVersionObj?.version || '2022/02';

  const response = await client.monetization.onetimeproducts.patch({
    packageName,
    productId,
    'regionsVersion.version': regionsVersionString,
    updateMask: 'purchaseOptions',
    requestBody: currentProduct.data,
  });

  const converted = convertOneTimeProduct(response.data);
  converted.packageName = packageName;
  return converted;
}

export async function deleteRegionPrice(
  client: AndroidPublisher,
  packageName: string,
  productId: string,
  regionCode: string
): Promise<InAppProduct> {
  // This would need to be implemented based on the new API structure
  // For now, get the product and return it
  const product = await getInAppProduct(client, packageName, productId);
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

  // Ensure non-negative
  newAmount = Math.max(0, newAmount);

  let units = Math.floor(newAmount);
  let nanos = Math.round((newAmount - units) * 1_000_000_000);

  // Clamp nanos to valid range, carrying overflow into units
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
