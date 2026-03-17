import type {
  AppleConnectCredentials,
  AppleApiResponse,
  AppleApiListResponse,
  AppleProductPrice,
  AppleTerritory,
} from './types';
import { appleApiRequest, getAppIdForBundleId } from './client';
import { UNSUPPORTED_IAP_TERRITORIES } from './territories';
import { getAvailablePricePoints, findClosestPricePoint } from './products';

// Get the app's price schedule ID and base territory
export async function getAppPriceSchedule(
  credentials: AppleConnectCredentials
): Promise<{ scheduleId: string; baseTerritory: string } | null> {
  const appId = await getAppIdForBundleId(credentials);
  if (!appId) {
    throw new Error(`App with Bundle ID "${credentials.bundleId}" not found`);
  }

  try {
    const response = await appleApiRequest<
      AppleApiResponse<{
        id: string;
        type: 'appPriceSchedules';
        relationships?: {
          baseTerritory?: { data: { id: string; type: 'territories' } };
        };
      }>
    >(credentials, `/apps/${appId}/appPriceSchedule`, {
      queryParams: {
        include: 'baseTerritory',
        'fields[appPriceSchedules]': 'baseTerritory',
        'fields[territories]': 'currency',
      },
    });

    const baseTerritory =
      response.data?.relationships?.baseTerritory?.data?.id || 'USA';

    return {
      scheduleId: response.data.id,
      baseTerritory,
    };
  } catch (error: unknown) {
    // Free app — no schedule exists
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      (error as { statusCode: number }).statusCode === 404
    ) {
      return null;
    }
    throw error;
  }
}

// Decode Apple's base64-encoded price ID (same logic as products.ts)
function decodePriceId(
  encodedId: string
): { sourceId?: string; territoryCode?: string; pricePointRef?: string } | null {
  try {
    const decoded = Buffer.from(encodedId, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    return {
      sourceId: parsed.s,
      territoryCode: parsed.t,
      pricePointRef: parsed.p,
    };
  } catch {
    return null;
  }
}

// Encode a price point ID with specific territory and tier
function encodePricePointId(sourceId: string, territoryCode: string, priceTier: string): string {
  const data = { s: sourceId, t: territoryCode, p: priceTier };
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

// Get all app prices (manual + automatic) for all territories
export async function getAppPrices(
  credentials: AppleConnectCredentials
): Promise<{
  manual: Record<string, AppleProductPrice>;
  automatic: Record<string, AppleProductPrice>;
  baseTerritory: string;
}> {
  const schedule = await getAppPriceSchedule(credentials);
  if (!schedule) {
    return { manual: {}, automatic: {}, baseTerritory: 'USA' };
  }

  const { scheduleId, baseTerritory } = schedule;

  // Fetch both manual and automatic prices with pagination
  const [manualPrices, automaticPrices] = await Promise.all([
    fetchPaginatedPrices(credentials, `/appPriceSchedules/${scheduleId}/manualPrices`),
    fetchPaginatedPrices(credentials, `/appPriceSchedules/${scheduleId}/automaticPrices`),
  ]);

  return {
    manual: manualPrices,
    automatic: automaticPrices,
    baseTerritory,
  };
}

// Fetch paginated prices from an endpoint, returning territory → price map
async function fetchPaginatedPrices(
  credentials: AppleConnectCredentials,
  basePath: string
): Promise<Record<string, AppleProductPrice>> {
  const prices: Record<string, AppleProductPrice> = {};
  let nextUrl: string | null = basePath;
  const seenUrls = new Set<string>();
  const MAX_PAGES = 20;
  let pageCount = 0;

  const queryParams = {
    include: 'appPricePoint,territory',
    limit: '200',
    'fields[appPrices]': 'startDate,endDate',
    'fields[appPricePoints]': 'customerPrice,proceeds',
    'fields[territories]': 'currency',
  };

  while (nextUrl) {
    if (++pageCount > MAX_PAGES) {
      console.warn(`[Apple] fetchPaginatedPrices - Hit max page limit for ${basePath}`);
      break;
    }

    if (seenUrls.has(nextUrl)) break;
    seenUrls.add(nextUrl);

    const currentUrl: string = nextUrl;
    const endpoint: string = currentUrl.startsWith('http')
      ? new URL(currentUrl).pathname.replace('/v1', '')
      : currentUrl;

    const response = await appleApiRequest<
      AppleApiListResponse<{
        id: string;
        type: string;
        attributes: { startDate?: string; endDate?: string };
      }>
    >(credentials, endpoint, {
      queryParams: currentUrl.includes('?') ? undefined : queryParams,
    });

    // Build lookups from included data
    const pricePoints = new Map<string, { customerPrice: string; proceeds: string }>();
    const territories = new Map<string, { currency: string }>();

    if (response.included) {
      for (const item of response.included) {
        if (item.type === 'appPricePoints') {
          const pp = item as unknown as { id: string; attributes: { customerPrice: string; proceeds: string } };
          pricePoints.set(pp.id, {
            customerPrice: pp.attributes.customerPrice,
            proceeds: pp.attributes.proceeds,
          });
        } else if (item.type === 'territories') {
          const territory = item as AppleTerritory;
          territories.set(territory.id, { currency: territory.attributes.currency });
        }
      }
    }

    // Process each price entry
    for (const priceEntry of response.data) {
      const decoded = decodePriceId(priceEntry.id);
      if (!decoded?.territoryCode) continue;

      const territoryCode = decoded.territoryCode;
      if (prices[territoryCode]) continue; // first entry wins

      const territory = territories.get(territoryCode);

      // Find matching price point by territory
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
          startDate: priceEntry.attributes.startDate,
        };
      }
    }

    nextUrl = response.links?.next ?? null;
  }

  return prices;
}

// Update the app's price schedule
export async function updateAppPriceSchedule(
  credentials: AppleConnectCredentials,
  manualPrices: Array<{ territoryId: string; pricePointId: string }>,
  baseTerritoryId: string = 'USA'
): Promise<void> {
  const appId = await getAppIdForBundleId(credentials);
  if (!appId) {
    throw new Error(`App with Bundle ID "${credentials.bundleId}" not found`);
  }

  // Filter out unsupported territories
  const supportedPrices = manualPrices.filter(
    (p) => !UNSUPPORTED_IAP_TERRITORIES.includes(p.territoryId)
  );

  const basePrice = supportedPrices.find((p) => p.territoryId === baseTerritoryId);
  if (!basePrice) {
    throw new Error(`Base territory ${baseTerritoryId} not found in prices`);
  }

  const included = supportedPrices.map((price, index) => ({
    id: `\${price-${index}}`,
    type: 'appPrices',
    attributes: {
      startDate: null,
    },
    relationships: {
      appPricePoint: {
        data: {
          id: price.pricePointId,
          type: 'appPricePoints',
        },
      },
    },
  }));

  await appleApiRequest(credentials, `/appPriceSchedules`, {
    method: 'POST',
    body: {
      data: {
        type: 'appPriceSchedules',
        relationships: {
          app: {
            data: {
              id: appId,
              type: 'apps',
            },
          },
          manualPrices: {
            data: supportedPrices.map((_, index) => ({
              id: `\${price-${index}}`,
              type: 'appPrices',
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
  });
}

// Resolve Money-format prices to app price point IDs
export async function resolveAppPricesToPricePoints(
  credentials: AppleConnectCredentials,
  prices: Record<string, { currencyCode: string; units: string; nanos?: number }>
): Promise<{
  resolved: Array<{ territoryId: string; pricePointId: string }>;
  skipped: string[];
}> {
  const resolved: Array<{ territoryId: string; pricePointId: string }> = [];
  const skipped: string[] = [];

  // Group by currency to minimize API calls
  const currencyToTerritories = new Map<string, string[]>();
  for (const [territoryCode, price] of Object.entries(prices)) {
    const currency = price.currencyCode;
    if (!currencyToTerritories.has(currency)) {
      currencyToTerritories.set(currency, []);
    }
    currencyToTerritories.get(currency)!.push(territoryCode);
  }

  // Fetch price points per currency (using first territory as representative)
  // Also build a tier map so we can re-encode IDs for other territories
  const currencyPricePointsMap = new Map<
    string,
    Array<{ id: string; customerPrice: string; proceeds: string }>
  >();
  let sourceId: string | null = null;

  for (const [, territoryList] of currencyToTerritories) {
    const representativeTerritory = territoryList[0];
    const currency = prices[representativeTerritory].currencyCode;

    if (!currencyPricePointsMap.has(currency)) {
      const pricePoints = await getAvailablePricePoints(
        credentials,
        representativeTerritory
      );
      currencyPricePointsMap.set(currency, pricePoints);

      // Extract sourceId from any price point (same for all price points of this app)
      if (!sourceId && pricePoints.length > 0) {
        const decoded = decodePriceId(pricePoints[0].id);
        if (decoded?.sourceId) {
          sourceId = decoded.sourceId;
        }
      }
    }
  }

  if (!sourceId) {
    return { resolved: [], skipped: ['Could not determine app source ID from price points'] };
  }

  // Resolve each territory — find the closest price tier, then construct
  // a territory-specific price point ID using encodePricePointId
  for (const [territoryCode, price] of Object.entries(prices)) {
    const localAmount =
      parseFloat(price.units) + (price.nanos ? price.nanos / 1_000_000_000 : 0);
    const pricePoints = currencyPricePointsMap.get(price.currencyCode);

    if (!pricePoints || pricePoints.length === 0) {
      skipped.push(`${territoryCode}: no price points for ${price.currencyCode}`);
      continue;
    }

    const closest = findClosestPricePoint(localAmount, pricePoints);
    if (!closest) {
      skipped.push(
        `${territoryCode}: no matching price point for ${price.currencyCode} ${localAmount}`
      );
      continue;
    }

    // Decode the matched price point to get the tier reference,
    // then re-encode with the correct target territory
    const decoded = decodePriceId(closest.id);
    if (!decoded?.pricePointRef) {
      skipped.push(`${territoryCode}: could not decode tier from price point`);
      continue;
    }

    const pricePointId = encodePricePointId(sourceId, territoryCode, decoded.pricePointRef);
    resolved.push({ territoryId: territoryCode, pricePointId });
  }

  return { resolved, skipped };
}
