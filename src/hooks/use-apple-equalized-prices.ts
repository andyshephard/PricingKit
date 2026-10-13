import { useQuery } from '@tanstack/react-query';

export interface AppleEqualizedPrice {
  customerPrice: string;
  currency: string;
  pricePointId: string;
  proceeds?: string;
  proceedsYear2?: string;
}

export interface AppleEqualizedPricesResponse {
  sourcePricePointId: string;
  sourceCustomerPrice: string;
  prices: Record<string, AppleEqualizedPrice>;
}

interface UseAppleEqualizedPricesOptions {
  kind: 'subscription' | 'product';
  id: string;
  baseRegion: string;
  basePrice: number;
  enabled: boolean;
}

/**
 * Fetch Apple's own equalized storefront prices for a selected base price.
 *
 * The server first resolves the selected base price to the nearest real Apple
 * price point, then asks App Store Connect for that point's equalizations.
 */
export function useAppleEqualizedPrices({
  kind,
  id,
  baseRegion,
  basePrice,
  enabled,
}: UseAppleEqualizedPricesOptions) {
  return useQuery<AppleEqualizedPricesResponse>({
    queryKey: [
      'apple',
      'equalized-prices',
      kind,
      id,
      baseRegion,
      Number.isFinite(basePrice) ? basePrice.toFixed(4) : 'invalid',
    ],
    queryFn: async () => {
      const basePath =
        kind === 'subscription'
          ? `/api/apple/subscriptions/${encodeURIComponent(id)}/price-points/equalizations`
          : `/api/apple/products/${encodeURIComponent(id)}/equalized-prices`;

      const params = new URLSearchParams({
        territory: baseRegion,
        price: String(basePrice),
      });

      const response = await fetch(`${basePath}?${params.toString()}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to fetch Apple equalized prices');
      }
      return response.json();
    },
    enabled: enabled && !!id && !!baseRegion && Number.isFinite(basePrice) && basePrice > 0,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}
