// Per-product base territory in the web app. App Store subscriptions and
// in-app purchases each have their own base territory (an in-app purchase's
// price schedule names one; a subscription's is the developer's choice), so
// the web app remembers one per product rather than one per app. Pure
// helpers; the remembered choices live in the auth store (per viewer,
// localStorage).

/** Key of a product's remembered base territory: the app and the product */
export function productBaseKey(bundleId: string | null | undefined, productId: string): string {
  return `${bundleId ?? ''}/${productId}`;
}

/**
 * The price to show as a product's base price: the first candidate
 * territory (alpha-2) the product has a price in, else its first price.
 * Candidates go from the most specific (the product's own base territory)
 * to the least (an app-wide display default, then US).
 */
export function pickBasePrice<T>(prices: Record<string, T> | undefined, candidates: Array<string | null | undefined>): { region: string; price: T } | null {
  if (!prices) return null;
  for (const region of candidates) {
    if (region && prices[region] !== undefined && prices[region] !== null) return { region, price: prices[region] };
  }
  const first = Object.keys(prices)[0];
  return first !== undefined ? { region: first, price: prices[first] } : null;
}

/**
 * The base territory an in-app purchase's bulk pricing starts from: the
 * product's own price schedule base territory, then (only when the product
 * has none) the app's price schedule base territory, then USA. Alpha-3.
 */
export function inAppBaseTerritory(productBase: string | null | undefined, appBase: string | null | undefined): string {
  return productBase || appBase || 'USA';
}

/** The fields of an App Store subscription the list needs */
interface ListedAppleSubscription {
  productId: string;
  name?: string;
  state?: string;
  period?: string;
  prices?: Record<string, { customerPrice: string; currency?: string }>;
}

/**
 * App Store subscriptions shaped like Google subscriptions for the table,
 * each showing its base price in its own base territory (remembered per
 * product), then the display default, then US. Pure, so the list can apply
 * it in a query `select` and a base territory change never refetches.
 */
export function normalizeAppleSubscriptionList<T extends { subscriptions?: unknown[] }>(
  data: T,
  options: { bundleId: string | null | undefined; productBases: Record<string, string>; displayDefault: string },
  parseMoney: (amount: number, currency: string) => unknown
): T {
  if (!data?.subscriptions) return data;
  return {
    ...data,
    subscriptions: (data.subscriptions as ListedAppleSubscription[]).map((s) => {
      const picked = pickBasePrice(s.prices, [options.productBases[productBaseKey(options.bundleId, s.productId)], options.displayDefault, 'US']);
      const basePrice = picked?.price ?? null;
      const basePriceRegion = picked?.region ?? null;
      return {
        productId: s.productId,
        archived: s.state !== 'APPROVED' && s.state !== 'READY_TO_SUBMIT',
        listings: [{ title: s.name, languageCode: 'en-US' }],
        basePlans: [
          {
            basePlanId: 'default',
            state: s.state === 'APPROVED' ? 'active' : 'inactive',
            autoRenewingBasePlanType: { billingPeriodDuration: s.period },
            regionalConfigs:
              basePrice && basePriceRegion
                ? [{ regionCode: basePriceRegion, price: parseMoney(parseFloat(basePrice.customerPrice), basePrice.currency || 'USD') }]
                : [],
          },
        ],
        // Keep original Apple data with base price info (including id for routing)
        _appleSubscription: { ...s, basePrice },
      };
    }),
  };
}
