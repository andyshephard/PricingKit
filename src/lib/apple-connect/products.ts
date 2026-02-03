import type {
  AppleConnectCredentials,
  AppleInAppPurchase,
  AppleApiListResponse,
  AppleApiResponse,
  NormalizedAppleProduct,
  AppleProductPrice,
  AppleInAppPurchaseLocalization,
  ApplePricePoint,
  AppleTerritory,
} from './types';
import { appleApiRequest, getAppIdForBundleId } from './client';
import { getTerritoryByAlpha3, UNSUPPORTED_IAP_TERRITORIES } from './territories';
import { findClosestTierForCurrency, hasTierData } from './price-tier-data';

// List all in-app purchases for an app
export async function listInAppPurchases(
  credentials: AppleConnectCredentials
): Promise<NormalizedAppleProduct[]> {
  console.log('[Apple] listInAppPurchases - Starting for bundleId:', credentials.bundleId);

  const appId = await getAppIdForBundleId(credentials);
  if (!appId) {
    console.error('[Apple] listInAppPurchases - No app ID found');
    throw new Error(`App with Bundle ID "${credentials.bundleId}" not found`);
  }

  console.log('[Apple] listInAppPurchases - Got app ID:', appId);

  const allProducts: NormalizedAppleProduct[] = [];
  const allPriceScheduleMap = new Map<string, string>();
  const allBaseTerritoryMap = new Map<string, string>(); // productId → base territory code
  let nextUrl: string | null = `/apps/${appId}/inAppPurchasesV2`;

  // Include related data in the request - including price schedule
  const queryParams = {
    include: 'inAppPurchaseLocalizations,iapPriceSchedule',
    limit: '200',
    'fields[inAppPurchases]':
      'name,productId,inAppPurchaseType,state,reviewNote,familySharable',
    'fields[inAppPurchaseLocalizations]': 'name,description,locale',
    'fields[inAppPurchasePriceSchedules]': 'baseTerritory',
  };

  while (nextUrl) {
    // Handle pagination - if nextUrl contains full URL, extract path
    const currentUrl = nextUrl;
    const endpoint: string = currentUrl.startsWith('http')
      ? new URL(currentUrl).pathname.replace('/v1', '')
      : currentUrl;

    console.log('[Apple] listInAppPurchases - Fetching endpoint:', endpoint);

    const response: AppleApiListResponse<AppleInAppPurchase> = await appleApiRequest<
      AppleApiListResponse<AppleInAppPurchase>
    >(credentials, endpoint, {
      queryParams: currentUrl.includes('?') ? undefined : queryParams,
    });

    console.log('[Apple] listInAppPurchases - Raw response data count:', response.data?.length ?? 0);

    // Build a map of price schedule IDs and base territories from included data
    // Note: Apple's API returns price schedules in `included` but not in product relationships
    // The price schedule ID appears to match the product ID
    const priceScheduleMap = new Map<string, string>();
    const baseTerritoryMap = new Map<string, string>();
    if (response.included) {
      for (const item of response.included) {
        if (item.type === 'inAppPurchasePriceSchedules') {
          // The price schedule ID matches the product ID
          priceScheduleMap.set(item.id, item.id);
          // Extract base territory from the price schedule
          const schedule = item as {
            id: string;
            relationships?: {
              baseTerritory?: { data: { id: string } }
            }
          };
          const baseTerritory = schedule.relationships?.baseTerritory?.data?.id;
          if (baseTerritory) {
            baseTerritoryMap.set(item.id, baseTerritory);
            console.log('[Apple] listInAppPurchases - Found price schedule', item.id, 'with base territory:', baseTerritory);
          } else {
            console.log('[Apple] listInAppPurchases - Found price schedule in included:', item.id, '(no base territory)');
          }
        }
      }
    }

    // Also check product relationships as a fallback
    for (const product of response.data) {
      const priceScheduleRef = product.relationships?.iapPriceSchedule?.data;
      if (priceScheduleRef && !priceScheduleMap.has(product.id)) {
        priceScheduleMap.set(product.id, priceScheduleRef.id);
        console.log('[Apple] listInAppPurchases - Product', product.id, 'has price schedule from relationship:', priceScheduleRef.id);
      }
    }

    // Normalize products
    const products = normalizeProducts(response);
    console.log('[Apple] listInAppPurchases - Normalized products count:', products.length);
    allProducts.push(...products);

    // Merge the price schedule map and base territory map (for products fetched in this page)
    for (const [productId, scheduleId] of priceScheduleMap) {
      if (!allPriceScheduleMap.has(productId)) {
        allPriceScheduleMap.set(productId, scheduleId);
      }
    }
    for (const [productId, baseTerritory] of baseTerritoryMap) {
      if (!allBaseTerritoryMap.has(productId)) {
        allBaseTerritoryMap.set(productId, baseTerritory);
      }
    }

    // Check for next page
    nextUrl = response.links?.next ?? null;
  }

  // Fetch base territory prices for all products in parallel
  if (allProducts.length > 0) {
    console.log('[Apple] listInAppPurchases - Fetching base prices for', allProducts.length, 'products');
    console.log('[Apple] listInAppPurchases - Price schedule map:', Object.fromEntries(allPriceScheduleMap));
    console.log('[Apple] listInAppPurchases - Base territory map:', Object.fromEntries(allBaseTerritoryMap));

    const pricePromises = allProducts.map(async (product) => {
      try {
        // Look up the price schedule ID from our map (built from included data)
        const priceScheduleId = allPriceScheduleMap.get(product.id);
        if (!priceScheduleId) {
          console.log('[Apple] No price schedule found for product', product.id);
          return;
        }
        // Get the base territory for this product (default to USA if not found)
        const baseTerritory = allBaseTerritoryMap.get(product.id) || 'USA';
        console.log('[Apple] Fetching price for product', product.id, 'using schedule', priceScheduleId, 'base territory', baseTerritory);
        const basePrice = await getProductBasePriceBySchedule(credentials, priceScheduleId, baseTerritory);
        if (basePrice) {
          product.prices = { [baseTerritory]: basePrice };
          console.log('[Apple] Got price for product', product.id, ':', basePrice.customerPrice, basePrice.currency);
        }
      } catch (error) {
        console.error('[Apple] Failed to fetch price for product', product.id, error);
      }
    });
    await Promise.all(pricePromises);
  }

  console.log('[Apple] listInAppPurchases - Total products found:', allProducts.length);
  return allProducts;
}

// Get base territory price using the price schedule ID directly
async function getProductBasePriceBySchedule(
  credentials: AppleConnectCredentials,
  priceScheduleId: string,
  territoryCode: string = 'USA'
): Promise<AppleProductPrice | null> {
  try {
    console.log('[Apple] getProductBasePriceBySchedule - Fetching prices for schedule:', priceScheduleId, 'territory:', territoryCode);

    // Get the manual prices for this schedule
    const pricesResponse = await appleApiRequest<
      AppleApiListResponse<{
        id: string;
        type: string;
        attributes: {
          startDate?: string;
        };
        relationships?: {
          inAppPurchasePricePoint?: {
            data: { id: string; type: string };
          };
          territory?: {
            data: { id: string; type: string };
          };
        };
      }>
    >(credentials, `/inAppPurchasePriceSchedules/${priceScheduleId}/manualPrices`, {
      queryParams: {
        include: 'inAppPurchasePricePoint,territory',
        'filter[territory]': territoryCode,
        limit: '1',
        'fields[inAppPurchasePrices]': 'startDate',
        'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds',
        'fields[territories]': 'currency',
      },
    });

    console.log('[Apple] getProductBasePriceBySchedule - Prices response:', JSON.stringify(pricesResponse, null, 2));

    // Find the price point in included data
    if (pricesResponse.data && pricesResponse.data.length > 0) {
      // The price point and territory are in the included array
      // Since we filter by territory and limit=1, we can just find the first price point
      const pricePoint = pricesResponse.included?.find(
        item => item.type === 'inAppPurchasePricePoints'
      );
      const territory = pricesResponse.included?.find(
        item => item.type === 'territories'
      );

      console.log('[Apple] getProductBasePriceBySchedule - Found price point:', pricePoint);
      console.log('[Apple] getProductBasePriceBySchedule - Found territory:', territory);

      if (pricePoint) {
        const attrs = pricePoint.attributes as { customerPrice?: string; proceeds?: string } | undefined;
        const territoryAttrs = territory?.attributes as { currency?: string } | undefined;
        const territoryId = territory?.id || territoryCode;

        return {
          territoryCode: territoryId,
          currency: territoryAttrs?.currency || 'USD',
          customerPrice: attrs?.customerPrice || '0',
          proceeds: attrs?.proceeds || '0',
          pricePointId: pricePoint.id || '',
        };
      }
    }

    return null;
  } catch (error) {
    console.error('[Apple] getProductBasePriceBySchedule error:', error);
    return null;
  }
}

// Get a single in-app purchase
export async function getInAppPurchase(
  credentials: AppleConnectCredentials,
  productId: string
): Promise<NormalizedAppleProduct | null> {
  try {
    // First, we need to find the product by its productId (SKU)
    const appId = await getAppIdForBundleId(credentials);
    if (!appId) {
      return null;
    }

    const response = await appleApiRequest<
      AppleApiListResponse<AppleInAppPurchase>
    >(credentials, `/apps/${appId}/inAppPurchasesV2`, {
      queryParams: {
        'filter[productId]': productId,
        include: 'inAppPurchaseLocalizations,iapPriceSchedule',
        'fields[inAppPurchases]':
          'name,productId,inAppPurchaseType,state,reviewNote,familySharable',
        'fields[inAppPurchaseLocalizations]': 'name,description,locale',
      },
    });

    if (!response.data || response.data.length === 0) {
      return null;
    }

    const products = normalizeProducts(response);
    return products[0] ?? null;
  } catch {
    return null;
  }
}

// Helper to decode Apple's base64-encoded price ID
function decodePriceId(encodedId: string): { sourceId?: string; territoryCode?: string; pricePointRef?: string } | null {
  try {
    const decoded = Buffer.from(encodedId, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    return {
      sourceId: parsed.s,       // "s" is source ID (app ID or similar)
      territoryCode: parsed.t,  // "t" is territory code (e.g., "USA")
      pricePointRef: parsed.p,  // "p" is price point reference (tier)
    };
  } catch {
    return null;
  }
}

// Helper to encode a price point ID
function encodePricePointId(sourceId: string, territoryCode: string, priceTier: string): string {
  const data = { s: sourceId, t: territoryCode, p: priceTier };
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

// Get prices for an in-app purchase using price schedules
// Fetches both manual prices (base territory) and automatic prices (calculated for other territories)
export async function getInAppPurchasePrices(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string
): Promise<Record<string, AppleProductPrice>> {
  try {
    console.log('[Apple] getInAppPurchasePrices - Fetching prices for product:', inAppPurchaseId);

    const prices: Record<string, AppleProductPrice> = {};

    // Fetch both manual and automatic prices in parallel
    const [manualResponse, automaticResponse] = await Promise.all([
      // Manual prices - explicitly set prices (usually base territory like USA)
      appleApiRequest<
        AppleApiListResponse<{
          id: string;
          type: string;
          attributes: { startDate?: string };
        }>
      >(credentials, `/inAppPurchasePriceSchedules/${inAppPurchaseId}/manualPrices`, {
        queryParams: {
          include: 'inAppPurchasePricePoint,territory',
          limit: '200',
          'fields[inAppPurchasePrices]': 'startDate',
          'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds',
          'fields[territories]': 'currency',
        },
      }),
      // Automatic prices - calculated prices for other territories
      appleApiRequest<
        AppleApiListResponse<{
          id: string;
          type: string;
          attributes: { startDate?: string };
        }>
      >(credentials, `/inAppPurchasePriceSchedules/${inAppPurchaseId}/automaticPrices`, {
        queryParams: {
          include: 'inAppPurchasePricePoint,territory',
          limit: '200',
          'fields[inAppPurchasePrices]': 'startDate',
          'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds',
          'fields[territories]': 'currency',
        },
      }),
    ]);

    console.log('[Apple] getInAppPurchasePrices - Got', manualResponse.data?.length ?? 0, 'manual prices and', automaticResponse.data?.length ?? 0, 'automatic prices');

    // Process both responses
    for (const response of [manualResponse, automaticResponse]) {
      // Build lookups from included data
      const pricePoints = new Map<string, { customerPrice: string; proceeds: string }>();
      const territories = new Map<string, { currency: string }>();

      if (response.included) {
        for (const item of response.included) {
          if (item.type === 'inAppPurchasePricePoints') {
            const pp = item as { id: string; attributes: { customerPrice: string; proceeds: string } };
            pricePoints.set(pp.id, {
              customerPrice: pp.attributes.customerPrice,
              proceeds: pp.attributes.proceeds,
            });
          } else if (item.type === 'territories') {
            const territory = item as AppleTerritory;
            territories.set(territory.id, {
              currency: territory.attributes.currency,
            });
          }
        }
      }

      // Process each price entry - decode the ID to get territory and price point
      for (const priceEntry of response.data) {
        const decoded = decodePriceId(priceEntry.id);
        if (!decoded?.territoryCode) continue;

        const territoryCode = decoded.territoryCode;

        // Skip if we already have this territory (manual prices take precedence)
        if (prices[territoryCode]) continue;

        const territory = territories.get(territoryCode);

        // Find the matching price point by territory
        let matchingPricePoint: { id: string; customerPrice: string; proceeds: string } | null = null;
        for (const [ppId, ppData] of pricePoints) {
          const ppDecoded = decodePriceId(ppId);
          if (ppDecoded?.territoryCode === territoryCode) {
            matchingPricePoint = { id: ppId, ...ppData };
            break;
          }
        }

        if (matchingPricePoint) {
          prices[territoryCode] = {
            territoryCode,
            currency: territory?.currency ?? 'USD',
            customerPrice: matchingPricePoint.customerPrice,
            proceeds: matchingPricePoint.proceeds,
            pricePointId: matchingPricePoint.id,
          };
        }
      }
    }

    console.log('[Apple] getInAppPurchasePrices - Found prices for', Object.keys(prices).length, 'territories');
    return prices;
  } catch (error) {
    console.error('[Apple] getInAppPurchasePrices error:', error);
    return {};
  }
}

// Normalize Apple API response to our internal format
function normalizeProducts(
  response: AppleApiListResponse<AppleInAppPurchase>
): NormalizedAppleProduct[] {
  // Build lookup maps for included data
  const localizations = new Map<
    string,
    { name: string; description?: string; locale: string }
  >();

  if (response.included) {
    for (const item of response.included) {
      if (item.type === 'inAppPurchaseLocalizations') {
        const loc = item as AppleInAppPurchaseLocalization;
        localizations.set(loc.id, {
          name: loc.attributes.name,
          description: loc.attributes.description,
          locale: loc.attributes.locale,
        });
      }
    }
  }

  return response.data.map((product) => {
    // Get localizations for this product
    const productLocalizations: Record<
      string,
      { name: string; description?: string }
    > = {};
    const locIds =
      product.relationships?.inAppPurchaseLocalizations?.data ?? [];
    for (const locRef of locIds) {
      const loc = localizations.get(locRef.id);
      if (loc) {
        productLocalizations[loc.locale] = {
          name: loc.name,
          description: loc.description,
        };
      }
    }

    return {
      id: product.id,
      productId: product.attributes.productId,
      name: product.attributes.name,
      type: product.attributes.inAppPurchaseType,
      state: product.attributes.state,
      prices: {}, // Prices need to be fetched separately
      localizations: productLocalizations,
    };
  });
}

// Get available price points for in-app purchases
export async function getAvailablePricePoints(
  credentials: AppleConnectCredentials,
  territoryCode: string = 'USA'
): Promise<
  Array<{
    id: string;
    customerPrice: string;
    proceeds: string;
  }>
> {
  try {
    const appId = await getAppIdForBundleId(credentials);
    if (!appId) {
      return [];
    }

    const response = await appleApiRequest<
      AppleApiListResponse<ApplePricePoint>
    >(credentials, `/apps/${appId}/appPricePoints`, {
      queryParams: {
        'filter[territory]': territoryCode,
        limit: '200',
        'fields[appPricePoints]': 'customerPrice,proceeds',
      },
    });

    return response.data.map((pp) => ({
      id: pp.id,
      customerPrice: pp.attributes.customerPrice,
      proceeds: pp.attributes.proceeds,
    }));
  } catch {
    return [];
  }
}

// Update in-app purchase price schedule (single territory - kept for backwards compatibility)
export async function updateInAppPurchasePrice(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  pricePointId: string,
  territoryCode: string,
  startDate?: string
): Promise<void> {
  // Create or update price for a specific territory
  await appleApiRequest(
    credentials,
    `/inAppPurchasePriceSchedules`,
    {
      method: 'POST',
      body: {
        data: {
          type: 'inAppPurchasePriceSchedules',
          relationships: {
            inAppPurchase: {
              data: {
                id: inAppPurchaseId,
                type: 'inAppPurchases',
              },
            },
            manualPrices: {
              data: [
                {
                  id: '${price}', // Placeholder, will be created
                  type: 'inAppPurchasePrices',
                },
              ],
            },
            baseTerritory: {
              data: {
                id: territoryCode,
                type: 'territories',
              },
            },
          },
        },
        included: [
          {
            id: '${price}',
            type: 'inAppPurchasePrices',
            attributes: {
              startDate: startDate ?? null,
            },
            relationships: {
              inAppPurchasePricePoint: {
                data: {
                  id: pricePointId,
                  type: 'inAppPurchasePricePoints',
                },
              },
            },
          },
        ],
      },
    }
  );
}

// Update in-app purchase prices for multiple territories at once
export async function updateInAppPurchasePrices(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  manualPrices: Array<{ territoryId: string; pricePointId: string }>,
  baseTerritoryId: string = 'USA'
): Promise<void> {
  // Filter out unsupported territories that cause 500 errors
  const supportedPrices = manualPrices.filter(p => !UNSUPPORTED_IAP_TERRITORIES.includes(p.territoryId));
  const skippedCount = manualPrices.length - supportedPrices.length;

  if (skippedCount > 0) {
    const skippedTerritories = manualPrices
      .filter(p => UNSUPPORTED_IAP_TERRITORIES.includes(p.territoryId))
      .map(p => p.territoryId);
    console.log(`[Apple] Skipping ${skippedCount} unsupported territories: ${skippedTerritories.join(', ')}`);
  }

  // Find base territory price (required by Apple)
  const basePrice = supportedPrices.find(p => p.territoryId === baseTerritoryId);

  if (!basePrice) {
    console.error(`[Apple] Base territory ${baseTerritoryId} not found in prices`);
    return;
  }

  console.log(`[Apple] updateInAppPurchasePrices - Updating ${supportedPrices.length} prices for ${inAppPurchaseId}`);

  // Log Australia price point for debugging
  const ausPrice = supportedPrices.find(p => p.territoryId === 'AUS');
  if (ausPrice) {
    console.log(`[Apple] AUSTRALIA - Sending to Apple API: territoryId=${ausPrice.territoryId}, pricePointId=${ausPrice.pricePointId}`);
  }

  // Build included array with all price entries
  const included = supportedPrices.map((price, index) => ({
    id: `\${price-${index}}`,
    type: 'inAppPurchasePrices',
    attributes: {
      startDate: null,
    },
    relationships: {
      inAppPurchasePricePoint: {
        data: {
          id: price.pricePointId,
          type: 'inAppPurchasePricePoints',
        },
      },
    },
  }));

  await appleApiRequest(
    credentials,
    `/inAppPurchasePriceSchedules`,
    {
      method: 'POST',
      body: {
        data: {
          type: 'inAppPurchasePriceSchedules',
          relationships: {
            inAppPurchase: {
              data: {
                id: inAppPurchaseId,
                type: 'inAppPurchases',
              },
            },
            manualPrices: {
              data: supportedPrices.map((_, index) => ({
                id: `\${price-${index}}`,
                type: 'inAppPurchasePrices',
              })),
            },
            baseTerritory: {
              data: {
                id: baseTerritoryId,
                type: 'territories',
              },
            },
          },
        },
        included,
      },
    }
  );

  console.log(`[Apple] updateInAppPurchasePrices - Successfully updated ${supportedPrices.length} prices`);
}

// Result type for resolvePPPPricesToPricePoints
export interface PPPResolutionResult {
  resolved: Array<{ territoryId: string; pricePointId: string }>;
  skipped: string[];
}

// Get the sourceId for an IAP by fetching just one price point
// This is much more efficient than fetching all price points
async function getSourceIdForIAP(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string
): Promise<string> {
  console.log(`[Apple] getSourceIdForIAP - Fetching sourceId for ${inAppPurchaseId}`);

  type PricePointResponse = AppleApiListResponse<{
    id: string;
    type: string;
    attributes: { customerPrice: string; proceeds: string };
  }>;

  // Fetch just 1 price point (limit=1) to get the sourceId
  const response: PricePointResponse = await appleApiRequest<PricePointResponse>(
    credentials,
    `/inAppPurchases/${inAppPurchaseId}/pricePoints`,
    {
      queryParams: {
        'filter[territory]': 'USA',
        limit: '1',
      },
      apiVersion: 'v2',
    }
  );

  if (!response.data || response.data.length === 0) {
    throw new Error(`No price points found for IAP ${inAppPurchaseId}`);
  }

  const pricePointId = response.data[0].id;
  const decoded = decodePriceId(pricePointId);

  if (!decoded?.sourceId) {
    throw new Error(`Could not decode sourceId from price point ID: ${pricePointId}`);
  }

  console.log(`[Apple] getSourceIdForIAP - Got sourceId: ${decoded.sourceId}`);
  return decoded.sourceId;
}

// Resolve PPP prices to price points for multiple territories
// Uses cached tier data when available, otherwise falls back to fetching from Apple
export async function resolvePPPPricesToPricePoints(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  prices: Record<string, { currencyCode: string; units: string; nanos?: number }>
): Promise<PPPResolutionResult> {
  const territories = Object.entries(prices);
  console.log(`[Apple] resolvePPPPricesToPricePoints - Processing ${territories.length} territories`);

  // Check if we have cached tier data
  if (hasTierData()) {
    console.log(`[Apple] Using cached tier data`);
    return resolvePPPPricesWithCache(credentials, inAppPurchaseId, prices);
  }

  // Fall back to fetching from Apple's API
  console.log(`[Apple] No cached tier data - fetching from Apple API`);
  return resolvePPPPricesFromAPI(credentials, inAppPurchaseId, prices);
}

// Resolve prices using cached tier data (fast path - 1 API call)
async function resolvePPPPricesWithCache(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  prices: Record<string, { currencyCode: string; units: string; nanos?: number }>
): Promise<PPPResolutionResult> {
  const territories = Object.entries(prices);

  // Step 1: Get sourceId for this IAP (single API call)
  const sourceId = await getSourceIdForIAP(credentials, inAppPurchaseId);

  // Step 2: For each territory, find the closest tier using cached data
  const manualPrices: Array<{ territoryId: string; pricePointId: string }> = [];
  const skippedTerritories: string[] = [];

  for (const [territoryCode, price] of territories) {
    const currency = price.currencyCode;
    const localAmount = parseFloat(price.units) + (price.nanos ? price.nanos / 1_000_000_000 : 0);

    // Find closest tier using cached tier data for this currency
    const closestTier = findClosestTierForCurrency(localAmount, currency);

    if (!closestTier) {
      skippedTerritories.push(`${territoryCode}: no cached tier data for ${currency}`);
      continue;
    }

    // Log for debugging
    if (territoryCode === 'AUS' || territoryCode === 'USA') {
      console.log(`[Apple] ${territoryCode} - Requested: ${currency} ${localAmount.toFixed(2)}, Closest tier: ${closestTier.tier} (${currency} ${closestTier.price})`);
    }

    // Construct the price point ID for this territory using the matched tier
    const pricePointId = encodePricePointId(sourceId, territoryCode, closestTier.tier);
    manualPrices.push({ territoryId: territoryCode, pricePointId });
  }

  console.log(`[Apple] resolvePPPPricesToPricePoints - Resolved ${manualPrices.length} price points (1 API call for sourceId)`);
  if (skippedTerritories.length > 0) {
    console.warn(`[Apple] resolvePPPPricesToPricePoints - Skipped ${skippedTerritories.length} territories:`, skippedTerritories);
  }

  return {
    resolved: manualPrices,
    skipped: skippedTerritories,
  };
}

// Resolve prices by fetching from Apple's API (slow path - ~140 API calls)
async function resolvePPPPricesFromAPI(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  prices: Record<string, { currencyCode: string; units: string; nanos?: number }>
): Promise<PPPResolutionResult> {
  const territories = Object.entries(prices);

  // Step 1: Group territories by currency to minimize API calls
  const currencyToTerritories = new Map<string, string[]>();
  for (const [territoryCode, price] of territories) {
    const currency = price.currencyCode;
    if (!currencyToTerritories.has(currency)) {
      currencyToTerritories.set(currency, []);
    }
    currencyToTerritories.get(currency)!.push(territoryCode);
  }

  console.log(`[Apple] resolvePPPPricesFromAPI - Found ${currencyToTerritories.size} unique currencies`);

  // Step 2: Fetch price points for each unique currency (using first territory as representative)
  const currencyPricePoints = new Map<string, Array<{ id: string; customerPrice: string }>>();
  const currencyTierMaps = new Map<string, Map<string, string>>(); // currency → (price → tier)

  for (const [currency, territoryList] of currencyToTerritories) {
    const representativeTerritory = territoryList[0];
    console.log(`[Apple] Fetching price points for ${currency} using territory ${representativeTerritory}`);

    const pricePoints = await getInAppPurchasePricePointsForTerritory(
      credentials,
      inAppPurchaseId,
      representativeTerritory
    );
    currencyPricePoints.set(currency, pricePoints);

    // Build price → tier map for this currency
    const tierMap = new Map<string, string>();
    for (const pp of pricePoints) {
      const ppDecoded = decodePriceId(pp.id);
      if (ppDecoded?.pricePointRef) {
        tierMap.set(pp.customerPrice, ppDecoded.pricePointRef);
      }
    }
    currencyTierMaps.set(currency, tierMap);
    console.log(`[Apple] Found ${pricePoints.length} price points for ${currency}`);
  }

  // Step 3: Extract sourceId from any price point
  const anyPricePoints = currencyPricePoints.values().next().value;
  if (!anyPricePoints || anyPricePoints.length === 0) {
    throw new Error('No price points found - cannot resolve PPP prices');
  }
  const decoded = decodePriceId(anyPricePoints[0].id);
  if (!decoded?.sourceId) {
    throw new Error('Could not decode source ID from price point - invalid price point format');
  }
  const sourceId = decoded.sourceId;

  // Step 4: For each territory, match against LOCAL currency price points
  const manualPrices: Array<{ territoryId: string; pricePointId: string }> = [];
  const skippedTerritories: string[] = [];

  for (const [territoryCode, price] of territories) {
    const localAmount = parseFloat(price.units) + (price.nanos ? price.nanos / 1_000_000_000 : 0);
    const currency = price.currencyCode;

    // Get price points for THIS currency
    const localPricePoints = currencyPricePoints.get(currency);
    const localTierMap = currencyTierMaps.get(currency);

    if (!localPricePoints || localPricePoints.length === 0 || !localTierMap) {
      skippedTerritories.push(`${territoryCode}: no price points for ${currency}`);
      continue;
    }

    // Find closest price point in LOCAL currency (not USD!)
    const closest = findClosestPricePoint(localAmount, localPricePoints);
    if (!closest) {
      skippedTerritories.push(`${territoryCode}: no matching price point for ${currency} ${localAmount}`);
      continue;
    }

    const tier = localTierMap.get(closest.customerPrice);
    if (!tier) {
      skippedTerritories.push(`${territoryCode}: no tier for ${currency} ${closest.customerPrice}`);
      continue;
    }

    // Log Australia specifically for debugging
    if (territoryCode === 'AUS') {
      console.log(`[Apple] AUSTRALIA - Requested: ${currency} ${localAmount}, Closest tier: ${currency} ${closest.customerPrice}, Tier: ${tier}`);
    }

    // Construct the price point ID for this territory using the matched tier
    const pricePointId = encodePricePointId(sourceId, territoryCode, tier);
    manualPrices.push({ territoryId: territoryCode, pricePointId });
  }

  console.log(`[Apple] resolvePPPPricesFromAPI - Resolved ${manualPrices.length} price points (${currencyToTerritories.size} currencies fetched)`);
  if (skippedTerritories.length > 0) {
    console.warn(`[Apple] resolvePPPPricesFromAPI - Skipped ${skippedTerritories.length} territories:`, skippedTerritories);
  }

  return {
    resolved: manualPrices,
    skipped: skippedTerritories,
  };
}

// Find the closest price point to a target amount
export function findClosestPricePoint(
  targetAmount: number,
  pricePoints: Array<{ id: string; customerPrice: string }>
): { id: string; customerPrice: string } | null {
  if (pricePoints.length === 0) return null;

  let closest = pricePoints[0];
  let minDiff = Math.abs(parseFloat(closest.customerPrice) - targetAmount);

  for (const pp of pricePoints) {
    const diff = Math.abs(parseFloat(pp.customerPrice) - targetAmount);
    if (diff < minDiff) {
      minDiff = diff;
      closest = pp;
    }
  }

  return closest;
}

// Get available price points for an in-app purchase in a specific territory
// Fetches actual IAP price points from Apple's API via the IAP's pricePoints relationship
export async function getInAppPurchasePricePointsForTerritory(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  territoryCode: string
): Promise<Array<{ id: string; customerPrice: string }>> {
  try {
    console.log(`[Apple] Fetching IAP price points for ${inAppPurchaseId} in ${territoryCode}`);

    // Fetch price points for this specific IAP filtered by territory
    // The endpoint is /inAppPurchases/{id}/pricePoints (similar to subscriptions)
    const allPricePoints: Array<{ id: string; customerPrice: string }> = [];
    let nextUrl: string | null = `/inAppPurchases/${inAppPurchaseId}/pricePoints`;
    const queryParams = {
      'filter[territory]': territoryCode,
      'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds',
      limit: '200',
    };

    while (nextUrl) {
      const currentUrl = nextUrl;
      const endpoint: string = currentUrl.startsWith('http')
        ? (() => {
            const url = new URL(currentUrl);
            return url.pathname.replace(/^\/v[12]/, '') + url.search;
          })()
        : currentUrl;

      const useQueryParams = !currentUrl.includes('?');
      console.log(`[Apple IAP Pagination Debug]`, {
        currentUrl,
        endpoint,
        useQueryParams,
      });

      type IAPPricePointResponse = AppleApiListResponse<{
        id: string;
        type: string;
        attributes: { customerPrice: string; proceeds: string };
      }>;

      const response: IAPPricePointResponse = await appleApiRequest<IAPPricePointResponse>(
        credentials,
        endpoint,
        {
          queryParams: useQueryParams ? queryParams : undefined,
          apiVersion: 'v2',
        }
      );

      console.log(`[Apple IAP Pagination Debug] Response:`, {
        dataCount: response.data.length,
        hasNextLink: !!response.links?.next,
        nextLink: response.links?.next ?? 'none',
      });

      for (const pp of response.data) {
        allPricePoints.push({
          id: pp.id,
          customerPrice: pp.attributes.customerPrice,
        });
      }

      nextUrl = response.links?.next ?? null;
    }

    console.log(`[Apple] Found ${allPricePoints.length} IAP price points for ${territoryCode}`);
    return allPricePoints;
  } catch (error) {
    console.error(`[Apple] Failed to get IAP price points for territory ${territoryCode}:`, error);
    throw new Error(`Failed to fetch price points for ${territoryCode}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
