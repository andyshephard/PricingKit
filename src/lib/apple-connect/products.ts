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
import { appleListAll, appleListPages } from './pagination';
import type { RequestContext } from '../utils/request-budget';
import { mapWithConcurrency } from '../pricing/concurrency';
import { alpha2ToAlpha3, alpha3ToAlpha2, UNSUPPORTED_IAP_TERRITORIES } from './territories';
import { findClosestTierForCurrency, hasTierData } from './price-tier-data';
import { ApiError, getErrorStatus, toApiError } from '../utils/api-error';

// Most parallel reads one helper sends to App Store Connect at once
export const APPLE_READ_CONCURRENCY = 4;

// The bundle ID doesn't resolve to an app in this App Store Connect account
function appNotFoundError(credentials: AppleConnectCredentials): ApiError {
  return new ApiError(`App with Bundle ID "${credentials.bundleId}" not found`, {
    status: 404,
    code: 'APP_NOT_FOUND',
    platform: 'apple',
  });
}

// List all in-app purchases for an app
export async function listInAppPurchases(
  credentials: AppleConnectCredentials,
  ctx: RequestContext = {}
): Promise<NormalizedAppleProduct[]> {
  // console.log('[Apple] listInAppPurchases - Starting for bundleId:', credentials.bundleId);

  const appId = await getAppIdForBundleId(credentials, ctx);
  if (!appId) {
    console.error('[Apple] listInAppPurchases - No app ID found');
    throw appNotFoundError(credentials);
  }

  // console.log('[Apple] listInAppPurchases - Got app ID:', appId);

  const allProducts: NormalizedAppleProduct[] = [];
  const allPriceScheduleMap = new Map<string, string>();
  const allBaseTerritoryMap = new Map<string, string>(); // productId → base territory code
  // Include related data in the request - including price schedule
  const queryParams = {
    include: 'inAppPurchaseLocalizations,iapPriceSchedule',
    limit: '200',
    'fields[inAppPurchases]':
      'name,productId,inAppPurchaseType,state,reviewNote,familySharable',
    'fields[inAppPurchaseLocalizations]': 'name,description,locale',
    'fields[inAppPurchasePriceSchedules]': 'baseTerritory',
  };

  for await (const response of appleListPages<AppleInAppPurchase>(
    credentials,
    `/apps/${encodeURIComponent(appId)}/inAppPurchasesV2`,
    { queryParams, budget: ctx.budget }
  )) {
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
            // console.log('[Apple] listInAppPurchases - Found price schedule', item.id, 'with base territory:', baseTerritory);
          } else {
            // console.log('[Apple] listInAppPurchases - Found price schedule in included:', item.id, '(no base territory)');
          }
        }
      }
    }

    // Also check product relationships as a fallback
    for (const product of response.data) {
      const priceScheduleRef = product.relationships?.iapPriceSchedule?.data;
      if (priceScheduleRef && !priceScheduleMap.has(product.id)) {
        priceScheduleMap.set(product.id, priceScheduleRef.id);
        // console.log('[Apple] listInAppPurchases - Product', product.id, 'has price schedule from relationship:', priceScheduleRef.id);
      }
    }

    // Normalize products
    const products = normalizeProducts(response);
    // console.log('[Apple] listInAppPurchases - Normalized products count:', products.length);
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
  }

  // Fetch base territory prices for all products in parallel
  if (allProducts.length > 0) {
    // console.log('[Apple] listInAppPurchases - Fetching base prices for', allProducts.length, 'products');
    // console.log('[Apple] listInAppPurchases - Price schedule map:', Object.fromEntries(allPriceScheduleMap));
    // console.log('[Apple] listInAppPurchases - Base territory map:', Object.fromEntries(allBaseTerritoryMap));

    // A failed price read fails the whole list (as ApiError) rather than
    // showing the product as if it had no price
    await mapWithConcurrency(allProducts, APPLE_READ_CONCURRENCY, async (product) => {
      // Look up the price schedule ID from our map (built from included data)
      const priceScheduleId = allPriceScheduleMap.get(product.id);
      if (!priceScheduleId) {
        // console.log('[Apple] No price schedule found for product', product.id);
        return;
      }
      // Never guess a base territory: reading another territory's price would
      // show it as the product's price. Flag the product and skip the read.
      const baseTerritory = allBaseTerritoryMap.get(product.id);
      if (!baseTerritory) {
        product.priceUnavailableReason = 'BASE_TERRITORY_UNKNOWN';
        return;
      }
      // console.log('[Apple] Fetching price for product', product.id, 'using schedule', priceScheduleId, 'base territory', baseTerritory);
      const basePrice = await getProductBasePriceBySchedule(credentials, priceScheduleId, baseTerritory, ctx);
      if (basePrice) {
        product.prices = { [baseTerritory]: basePrice };
        product.baseTerritory = baseTerritory;
        // console.log('[Apple] Got price for product', product.id, ':', basePrice.customerPrice, basePrice.currency);
      }
    });
  }

  // console.log('[Apple] listInAppPurchases - Total products found:', allProducts.length);
  return allProducts;
}

// Get base territory price using the price schedule ID directly.
// Returns null when there is no price (404 / no data); API failures are
// thrown as ApiError.
async function getProductBasePriceBySchedule(
  credentials: AppleConnectCredentials,
  priceScheduleId: string,
  territoryCode: string = 'USA',
  ctx: RequestContext = {}
): Promise<AppleProductPrice | null> {
  try {
    // console.log('[Apple] getProductBasePriceBySchedule - Fetching prices for schedule:', priceScheduleId, 'territory:', territoryCode);

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
    >(credentials, `/inAppPurchasePriceSchedules/${encodeURIComponent(priceScheduleId)}/manualPrices`, {
      budget: ctx.budget,
      queryParams: {
        include: 'inAppPurchasePricePoint,territory',
        'filter[territory]': territoryCode,
        limit: '1',
        'fields[inAppPurchasePrices]': 'startDate',
        'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds',
        'fields[territories]': 'currency',
      },
    });

    // console.log('[Apple] getProductBasePriceBySchedule - Prices response:', JSON.stringify(pricesResponse, null, 2));

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

      // console.log('[Apple] getProductBasePriceBySchedule - Found price point:', pricePoint);
      // console.log('[Apple] getProductBasePriceBySchedule - Found territory:', territory);

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
    if (getErrorStatus(error) === 404) {
      return null;
    }
    console.error('[Apple] getProductBasePriceBySchedule error:', error);
    throw toApiError(error, 'apple');
  }
}

// Get a single in-app purchase.
// Returns null only when the product genuinely doesn't exist; API failures
// (auth, rate limit, 5xx, network, unknown app) are thrown as ApiError.
export async function getInAppPurchase(
  credentials: AppleConnectCredentials,
  productId: string,
  ctx: RequestContext = {}
): Promise<NormalizedAppleProduct | null> {
  // First, we need to find the product by its productId (SKU)
  const appId = await getAppIdForBundleId(credentials, ctx);
  if (!appId) {
    throw appNotFoundError(credentials);
  }

  try {

    const response = await appleApiRequest<
      AppleApiListResponse<AppleInAppPurchase>
    >(credentials, `/apps/${encodeURIComponent(appId)}/inAppPurchasesV2`, {
      budget: ctx.budget,
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
    // filter[productId] should give exactly this product; never pick one of several
    if (response.data.length !== 1) {
      throw new ApiError(`App Store Connect returned ${response.data.length} in-app purchases for product ID ${productId}; expected one`, {
        status: 502,
        code: 'AMBIGUOUS_PRODUCT',
        platform: 'apple',
        retryable: false,
      });
    }
    const [product] = normalizeProducts(response);
    return product && product.productId === productId ? product : null;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AMBIGUOUS_PRODUCT') throw error;
    if (getErrorStatus(error) === 404) {
      return null;
    }
    throw toApiError(error, 'apple');
  }
}

// Get the base territory for a product using Apple's dedicated endpoint.
// Returns null when the product has no price schedule yet (404 / no data);
// API failures are thrown as ApiError, never guessed as 'USA'.
export async function getBaseTerritoryForProduct(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  ctx: RequestContext = {}
): Promise<string | null> {
  try {
    const response = await appleApiRequest<AppleApiResponse<AppleTerritory>>(
      credentials,
      `/inAppPurchasePriceSchedules/${encodeURIComponent(inAppPurchaseId)}/baseTerritory`,
      { queryParams: { 'fields[territories]': 'currency' }, budget: ctx.budget }
    );
    return response.data?.id || null;
  } catch (error) {
    if (getErrorStatus(error) === 404) {
      return null;
    }
    throw toApiError(error, 'apple');
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
// A 404 (no price schedule yet) returns {}; other failures are thrown as ApiError
export async function getInAppPurchasePrices(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  ctx: RequestContext = {}
): Promise<Record<string, AppleProductPrice>> {
  try {
    // console.log('[Apple] getInAppPurchasePrices - Fetching prices for product:', inAppPurchaseId);

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
      >(credentials, `/inAppPurchasePriceSchedules/${encodeURIComponent(inAppPurchaseId)}/manualPrices`, {
        budget: ctx.budget,
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
      >(credentials, `/inAppPurchasePriceSchedules/${encodeURIComponent(inAppPurchaseId)}/automaticPrices`, {
        budget: ctx.budget,
        queryParams: {
          include: 'inAppPurchasePricePoint,territory',
          limit: '200',
          'fields[inAppPurchasePrices]': 'startDate',
          'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds',
          'fields[territories]': 'currency',
        },
      }),
    ]);

    // console.log('[Apple] getInAppPurchasePrices - Got', manualResponse.data?.length ?? 0, 'manual prices and', automaticResponse.data?.length ?? 0, 'automatic prices');

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
        // Territory codes from decodePriceId are alpha-3 (e.g. "USA"), so normalize both sides
        let matchingPricePoint: { id: string; customerPrice: string; proceeds: string } | null = null;
        for (const [ppId, ppData] of pricePoints) {
          const ppDecoded = decodePriceId(ppId);
          if (!ppDecoded?.territoryCode) continue;
          // Compare in both formats to handle alpha-2/alpha-3 mismatches
          if (
            ppDecoded.territoryCode === territoryCode ||
            alpha3ToAlpha2(ppDecoded.territoryCode) === territoryCode ||
            alpha3ToAlpha2(territoryCode) === ppDecoded.territoryCode
          ) {
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

    // console.log('[Apple] getInAppPurchasePrices - Found prices for', Object.keys(prices).length, 'territories');
    return prices;
  } catch (error) {
    if (getErrorStatus(error) === 404) {
      return {};
    }
    console.error('[Apple] getInAppPurchasePrices error:', error);
    throw toApiError(error, 'apple');
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
  territoryCode: string = 'USA',
  ctx: RequestContext = {}
): Promise<
  Array<{
    id: string;
    customerPrice: string;
    proceeds: string;
  }>
> {
  const appId = await getAppIdForBundleId(credentials, ctx);
  if (!appId) {
    throw appNotFoundError(credentials);
  }

  try {
    const response = await appleApiRequest<
      AppleApiListResponse<ApplePricePoint>
    >(credentials, `/apps/${encodeURIComponent(appId)}/appPricePoints`, {
      budget: ctx.budget,
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
  } catch (error) {
    // Failures are thrown, so callers never mistake them for "no price points"
    throw toApiError(error, 'apple');
  }
}

/**
 * @deprecated Creates a schedule with ONE manual price whose territory becomes
 * the base territory; Apple replaces the whole schedule, so every other
 * manual price is dropped. Use replaceInAppPurchaseManualPrices.
 */
export async function updateInAppPurchasePrice(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  pricePointId: string,
  territoryCode: string,
  startDate?: string,
  ctx: RequestContext = {}
): Promise<void> {
  // Create or update price for a specific territory
  await appleApiRequest(
    credentials,
    `/inAppPurchasePriceSchedules`,
    {
      budget: ctx.budget,
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
  manualPrices: Array<{ territoryId: string; pricePointId: string; startDate?: string | null }>,
  baseTerritoryId: string = 'USA',
  ctx: RequestContext = {}
): Promise<void> {
  // Apple requires a manual price for the base territory; without one the
  // whole schedule is rejected, so fail loudly instead of reporting success
  if (UNSUPPORTED_IAP_TERRITORIES.includes(baseTerritoryId)) {
    throw new ApiError(
      `Base territory ${baseTerritoryId} is not supported for in-app purchase pricing`,
      { status: 422, code: 'UNSUPPORTED_BASE_TERRITORY', platform: 'apple' }
    );
  }

  // Filter out unsupported territories that cause 500 errors
  const supportedPrices = manualPrices.filter(p => !UNSUPPORTED_IAP_TERRITORIES.includes(p.territoryId));

  // Find base territory price (required by Apple)
  const basePrice = supportedPrices.find(p => p.territoryId === baseTerritoryId && !p.startDate);

  if (!basePrice) {
    throw new ApiError(
      `No price for base territory ${baseTerritoryId}. Apple requires the base territory price ` +
      'to be included when updating in-app purchase prices.',
      { status: 422, code: 'MISSING_BASE_TERRITORY_PRICE', platform: 'apple' }
    );
  }

  // console.log(`[Apple] updateInAppPurchasePrices - Updating ${supportedPrices.length} prices for ${inAppPurchaseId}`);

  // Build included array with all price entries
  const included = supportedPrices.map((price, index) => ({
    id: `\${price-${index}}`,
    type: 'inAppPurchasePrices',
    attributes: {
      startDate: price.startDate ?? null,
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
      budget: ctx.budget,
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

  // console.log(`[Apple] updateInAppPurchasePrices - Successfully updated ${supportedPrices.length} prices`);
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
  inAppPurchaseId: string,
  ctx: RequestContext = {}
): Promise<string> {
  // console.log(`[Apple] getSourceIdForIAP - Fetching sourceId for ${inAppPurchaseId}`);

  type PricePointResponse = AppleApiListResponse<{
    id: string;
    type: string;
    attributes: { customerPrice: string; proceeds: string };
  }>;

  // Fetch just 1 price point (limit=1) to get the sourceId
  const response: PricePointResponse = await appleApiRequest<PricePointResponse>(
    credentials,
    `/inAppPurchases/${encodeURIComponent(inAppPurchaseId)}/pricePoints`,
    {
      budget: ctx.budget,
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

  // console.log(`[Apple] getSourceIdForIAP - Got sourceId: ${decoded.sourceId}`);
  return decoded.sourceId;
}

// Resolve PPP prices to price points for multiple territories
// Uses cached tier data when available, otherwise falls back to fetching from Apple
export async function resolvePPPPricesToPricePoints(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  prices: Record<string, { currencyCode: string; units: string; nanos?: number }>,
  ctx: RequestContext = {}
): Promise<PPPResolutionResult> {
  // Check if we have cached tier data
  if (hasTierData()) {
    // console.log(`[Apple] Using cached tier data`);
    return resolvePPPPricesWithCache(credentials, inAppPurchaseId, prices, ctx);
  }

  // Fall back to fetching from Apple's API
  // console.log(`[Apple] No cached tier data - fetching from Apple API`);
  return resolvePPPPricesFromAPI(credentials, inAppPurchaseId, prices, ctx);
}

// Resolve prices using cached tier data (fast path - 1 API call)
async function resolvePPPPricesWithCache(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  prices: Record<string, { currencyCode: string; units: string; nanos?: number }>,
  ctx: RequestContext = {}
): Promise<PPPResolutionResult> {
  const territories = Object.entries(prices);

  // Step 1: Get sourceId for this IAP (single API call)
  const sourceId = await getSourceIdForIAP(credentials, inAppPurchaseId, ctx);

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

    // Construct the price point ID for this territory using the matched tier
    const pricePointId = encodePricePointId(sourceId, territoryCode, closestTier.tier);
    manualPrices.push({ territoryId: territoryCode, pricePointId });
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
  prices: Record<string, { currencyCode: string; units: string; nanos?: number }>,
  ctx: RequestContext = {}
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

  // Step 2: Fetch price points for each unique currency (using first territory as representative)
  const currencyPricePoints = new Map<string, Array<{ id: string; customerPrice: string }>>();
  const currencyTierMaps = new Map<string, Map<string, string>>(); // currency → (price → tier)

  // Fetch currencies in parallel, a few at a time
  await mapWithConcurrency(Array.from(currencyToTerritories.entries()), APPLE_READ_CONCURRENCY, async ([currency, territoryList]) => {
    const representativeTerritory = territoryList[0];
    const pricePoints = await getInAppPurchasePricePointsForTerritory(
      credentials,
      inAppPurchaseId,
      representativeTerritory,
      ctx
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
  });

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

    // Construct the price point ID for this territory using the matched tier
    const pricePointId = encodePricePointId(sourceId, territoryCode, tier);
    manualPrices.push({ territoryId: territoryCode, pricePointId });
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
  territoryCode: string,
  ctx: RequestContext = {}
): Promise<Array<{ id: string; customerPrice: string }>> {
  try {
    // console.log(`[Apple] Fetching IAP price points for ${inAppPurchaseId} in ${territoryCode}`);

    // Fetch price points for this specific IAP filtered by territory
    // The endpoint is /inAppPurchases/{id}/pricePoints (similar to subscriptions)
    const allPricePoints: Array<{ id: string; customerPrice: string }> = [];
    const queryParams = {
      'filter[territory]': territoryCode,
      'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds',
      limit: '200',
    };

    for await (const response of appleListPages<{
      id: string;
      type: string;
      attributes: { customerPrice: string; proceeds: string };
    }>(credentials, `/inAppPurchases/${encodeURIComponent(inAppPurchaseId)}/pricePoints`, { queryParams, apiVersion: 'v2', budget: ctx.budget })) {
      for (const pp of response.data) {
        allPricePoints.push({
          id: pp.id,
          customerPrice: pp.attributes.customerPrice,
        });
      }
    }

    // console.log(`[Apple] Found ${allPricePoints.length} IAP price points for ${territoryCode}`);
    return allPricePoints;
  } catch (error) {
    console.error(`[Apple] Failed to get IAP price points for territory ${territoryCode}:`, error);
    throw new Error(`Failed to fetch price points for ${territoryCode}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One manual price of an in-app purchase's price schedule */
export interface InAppPurchaseManualPrice {
  /** alpha-3 */
  territoryId: string;
  pricePointId: string;
  startDate: string | null;
  endDate: string | null;
}

/**
 * The manual prices of an in-app purchase's price schedule, read from the
 * relationships Apple returns. Returns [] when the product has no schedule
 * (404). An entry without its territory or price point is an error: the
 * schedule could not be rebuilt from it safely.
 */
export async function getInAppPurchaseManualPrices(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  ctx: RequestContext = {}
): Promise<InAppPurchaseManualPrice[]> {
  type Entry = {
    id: string;
    attributes?: { startDate?: string | null; endDate?: string | null };
    relationships?: {
      territory?: { data?: { id: string } | null };
      inAppPurchasePricePoint?: { data?: { id: string } | null };
    };
  };
  let data: Entry[];
  try {
    ({ data } = await appleListAll<Entry>(credentials, `/inAppPurchasePriceSchedules/${encodeURIComponent(inAppPurchaseId)}/manualPrices`, {
      queryParams: {
        include: 'inAppPurchasePricePoint,territory',
        limit: '200',
        'fields[inAppPurchasePrices]': 'startDate,endDate,inAppPurchasePricePoint,territory',
      },
      budget: ctx.budget,
    }));
  } catch (error) {
    if (getErrorStatus(error) === 404) return [];
    throw toApiError(error, 'apple');
  }
  return data.map((entry) => {
    const territoryId = entry.relationships?.territory?.data?.id;
    const pricePointId = entry.relationships?.inAppPurchasePricePoint?.data?.id;
    if (!territoryId || !pricePointId) {
      throw new ApiError(
        `Apple returned manual price ${entry.id} without its ${territoryId ? 'price point' : 'territory'}; the price schedule can't be updated safely`,
        { status: 502, code: 'INCOMPLETE_PRICE_SCHEDULE', platform: 'apple', retryable: false }
      );
    }
    return {
      territoryId,
      pricePointId,
      startDate: entry.attributes?.startDate ?? null,
      endDate: entry.attributes?.endDate ?? null,
    };
  });
}

/**
 * Change some territories' manual prices of an in-app purchase.
 *
 * POST /inAppPurchasePriceSchedules creates the whole schedule (base
 * territory plus every manual price), so posting one schedule per territory
 * would leave only the last one. This reads the current manual prices and
 * sends ONE schedule in which, per territory:
 *
 * - its current price is the active entry with the latest start date (sent
 *   with no start date); older active entries and expired ones are dropped
 * - its future entries are kept with their dates
 * - an immediate change replaces only the current price; the territory's
 *   scheduled prices stay and still take effect on their dates
 * - a future-dated change adds (or replaces the entry with the same date);
 *   the current price stays until then
 *
 * Nothing is dropped silently: if Apple refuses a schedule that kept a
 * changed territory's scheduled prices, the error names them.
 */
export async function replaceInAppPurchaseManualPrices(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  changes: Record<string, { pricePointId: string; startDate?: string }>,
  baseTerritoryId: string,
  ctx: RequestContext = {},
  today: string = new Date().toISOString().slice(0, 10)
): Promise<{ sent: number; kept: number; keptScheduled: Array<{ territoryId: string; startDate: string }> }> {
  const day = (value: string) => value.slice(0, 10);
  const changed = new Map<string, { pricePointId: string; startDate?: string }>();
  for (const [territory, change] of Object.entries(changes)) {
    const alpha3 = territory.length === 2 ? alpha2ToAlpha3(territory) : alpha3ToAlpha2(territory) ? territory : null;
    if (!alpha3) {
      throw new ApiError(`Unknown Apple territory "${territory}"`, { status: 400, code: 'INVALID_TERRITORY', platform: 'apple' });
    }
    if (change.startDate !== undefined && !(/^\d{4}-\d{2}-\d{2}/.test(change.startDate) && day(change.startDate) > today)) {
      throw new ApiError(
        `Start date ${change.startDate} for ${territory} is not a future date; leave it out for an immediate change`,
        { status: 400, code: 'INVALID_START_DATE', platform: 'apple' }
      );
    }
    changed.set(alpha3, change);
  }

  // Current and future entries per territory, from the live schedule
  const existing = (await getInAppPurchaseManualPrices(credentials, inAppPurchaseId, ctx)).filter(
    (p) => !p.endDate || day(p.endDate) > today
  );
  const byTerritory = new Map<string, { current?: InAppPurchaseManualPrice; future: InAppPurchaseManualPrice[] }>();
  for (const entry of existing) {
    const slot = byTerritory.get(entry.territoryId) ?? { future: [] };
    if (entry.startDate && day(entry.startDate) > today) {
      slot.future.push(entry);
    } else if (!slot.current || (entry.startDate ?? '') > (slot.current.startDate ?? '')) {
      slot.current = entry;
    }
    byTerritory.set(entry.territoryId, slot);
  }

  const schedule: Array<{ territoryId: string; pricePointId: string; startDate: string | null }> = [];
  const keptScheduled: Array<{ territoryId: string; startDate: string }> = [];
  let kept = 0;
  const territories = new Set([...byTerritory.keys(), ...changed.keys()]);
  for (const territoryId of territories) {
    const slot = byTerritory.get(territoryId) ?? { future: [] };
    const change = changed.get(territoryId);
    const immediate = change && change.startDate === undefined;

    if (immediate) {
      schedule.push({ territoryId, pricePointId: change.pricePointId, startDate: null });
    } else if (slot.current) {
      schedule.push({ territoryId, pricePointId: slot.current.pricePointId, startDate: null });
      kept++;
    }
    for (const future of slot.future) {
      if (change?.startDate && day(future.startDate!) === day(change.startDate)) continue; // replaced below
      schedule.push({ territoryId, pricePointId: future.pricePointId, startDate: future.startDate });
      kept++;
      if (change) keptScheduled.push({ territoryId, startDate: future.startDate! });
    }
    if (change?.startDate) {
      schedule.push({ territoryId, pricePointId: change.pricePointId, startDate: change.startDate });
    }
  }

  try {
    await updateInAppPurchasePrices(credentials, inAppPurchaseId, schedule, baseTerritoryId, ctx);
  } catch (error) {
    const status = getErrorStatus(error);
    if (keptScheduled.length > 0 && status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429) {
      const apiError = toApiError(error, 'apple');
      const listed = keptScheduled.map((s) => `${s.territoryId} from ${day(s.startDate)}`).join(', ');
      throw new ApiError(
        `${apiError.message} (the schedule kept the existing scheduled prices of the territories you changed: ${listed}. ` +
          'They were not removed. If they conflict with your change, change or remove them first.)',
        { status, code: apiError.code, platform: 'apple', retryable: false, cause: error }
      );
    }
    throw error;
  }
  return { sent: changed.size, kept, keptScheduled };
}

/** One in-app purchase price entry (manual or automatic), read without guessing anything */
export interface InAppPurchasePriceEntry {
  priceId: string;
  /** alpha-2; undefined if Apple didn't say */
  territory?: string;
  /** null = no start date */
  startDate: string | null;
  /** null = no end date */
  endDate: string | null;
  /** Set by the developer (manual) or derived by Apple from the base territory (automatic) */
  manual: boolean;
  pricePoint?: { id: string; customerPrice: string; proceeds: string };
  currency?: string;
  /** Why this entry can't be used as-is (missing relationship, price point or currency) */
  problem?: string;
}

/**
 * Every price entry of an in-app purchase's price schedule, manual and
 * automatic, with territory, price point and currency taken only from the
 * relationships and included resources Apple returns (paginated). Unlike
 * getInAppPurchasePrices (used by the existing UI routes), nothing is decoded
 * from IDs or defaulted (no USD), and dated entries are kept with their
 * dates. No entries when the product has no price schedule (404 on its
 * manual prices). A 404 on the automatic prices keeps the manual entries and
 * says so in `warnings`.
 */
export async function listInAppPurchasePriceEntries(
  credentials: AppleConnectCredentials,
  inAppPurchaseId: string,
  ctx: RequestContext = {}
): Promise<{ entries: InAppPurchasePriceEntry[]; warnings: string[] }> {
  type Entry = {
    id: string;
    attributes?: { startDate?: string | null; endDate?: string | null };
    relationships?: { territory?: { data?: { id: string } | null }; inAppPurchasePricePoint?: { data?: { id: string } | null } };
  };
  const entries: InAppPurchasePriceEntry[] = [];
  const warnings: string[] = [];
  for (const [kind, manual] of [['manualPrices', true], ['automaticPrices', false]] as const) {
    let result: { data: Entry[]; included: unknown[] };
    try {
      result = await appleListAll<Entry>(credentials, `/inAppPurchasePriceSchedules/${encodeURIComponent(inAppPurchaseId)}/${encodeURIComponent(kind)}`, {
        queryParams: {
          include: 'inAppPurchasePricePoint,territory',
          limit: '200',
          'fields[inAppPurchasePrices]': 'startDate,endDate,inAppPurchasePricePoint,territory',
          'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds',
          'fields[territories]': 'currency',
        },
        budget: ctx.budget,
      });
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        if (manual) return { entries: [], warnings: [] };
        warnings.push('App Store Connect answered 404 for the automatic prices; only manual prices were read');
        break;
      }
      throw toApiError(error, 'apple');
    }
    const points = new Map<string, { customerPrice: string; proceeds: string }>();
    const currencies = new Map<string, string>();
    for (const item of result.included as Array<{ id: string; type: string; attributes?: Record<string, string> }>) {
      if (item.type === 'inAppPurchasePricePoints' && item.attributes) points.set(item.id, { customerPrice: item.attributes.customerPrice, proceeds: item.attributes.proceeds });
      else if (item.type === 'territories' && item.attributes?.currency) currencies.set(item.id, item.attributes.currency);
    }
    for (const price of result.data) {
      const alpha3 = price.relationships?.territory?.data?.id;
      const territory = alpha3 ? alpha3ToAlpha2(alpha3) ?? undefined : undefined;
      const pointId = price.relationships?.inAppPurchasePricePoint?.data?.id;
      const point = pointId ? points.get(pointId) : undefined;
      const currency = alpha3 ? currencies.get(alpha3) : undefined;
      const problem = !territory
        ? `price ${price.id} has no territory`
        : !pointId
          ? `price ${price.id} in ${territory} has no price point`
          : !point
            ? `price ${price.id} in ${territory}: price point ${pointId} was not returned`
            : !currency
              ? `price ${price.id} in ${territory} has no currency`
              : undefined;
      entries.push({
        priceId: price.id,
        ...(territory ? { territory } : {}),
        startDate: price.attributes?.startDate ?? null,
        endDate: price.attributes?.endDate ?? null,
        manual,
        ...(point && pointId ? { pricePoint: { id: pointId, ...point } } : {}),
        ...(currency ? { currency } : {}),
        ...(problem ? { problem } : {}),
      });
    }
  }
  return { entries, warnings };
}
