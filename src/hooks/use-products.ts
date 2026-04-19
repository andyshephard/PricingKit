import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InAppProduct, Money } from '@/lib/google-play/types';
import { parseMoney } from '@/lib/google-play/types';
import type { RawAppleProduct, ProductsListResponse, ProductResponse } from '@/types/api';
import { useAuthStore } from '@/store/auth-store';

export function useProducts() {
  const platform = useAuthStore((state) => state.platform);

  return useQuery<ProductsListResponse>({
    queryKey: ['products', platform],
    queryFn: async () => {
      // Use platform-specific API
      const url = platform === 'apple' ? '/api/apple/products' : '/api/products';
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch products');
      }
      const data = await response.json();

      // Normalize Apple products to match Google product structure for table display
      if (platform === 'apple' && data.products) {
        data.products = data.products.map((p: RawAppleProduct) => {
          // Get the base price using the detected base territory
          const baseTerritoryCode = p.baseTerritory || 'USA';
          const basePrice = p.prices?.[baseTerritoryCode] || Object.values(p.prices || {})[0] || null;
          
          const defaultPrice = basePrice
            ? parseMoney(parseFloat(basePrice.customerPrice), basePrice.currency || 'USD')
            : null;

          return {
            sku: p.productId,
            status: p.state === 'APPROVED' ? 'active' : 'inactive',
            purchaseType: p.type,
            listings: { 'en-US': { title: p.name } },
            defaultPrice,
            prices: p.prices || {},
            _appleProduct: p,
          };
        });
      }

      return data;
    },
    enabled: !!platform,
  });
}

export function useProduct(sku: string) {
  const platform = useAuthStore((state) => state.platform);

  return useQuery<ProductResponse>({
    queryKey: ['products', platform, sku],
    queryFn: async () => {
      const url = platform === 'apple'
        ? `/api/apple/products/${encodeURIComponent(sku)}`
        : `/api/products/${encodeURIComponent(sku)}`;
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch product');
      }
      const data = await response.json();

      // Normalize Apple product to match Google product structure
      if (platform === 'apple' && data.product) {
        const p = data.product;
        // Get the base price using the detected base territory
        const baseTerritoryCode = p.baseTerritory || 'USA';
        const basePrice = p.prices?.[baseTerritoryCode];
        
        const defaultPrice = basePrice
          ? parseMoney(parseFloat(basePrice.customerPrice), basePrice.currency || 'USD')
          : null;

        data.product = {
          sku: p.productId,
          status: p.state === 'APPROVED' ? 'active' : 'inactive',
          purchaseType: p.type,
          listings: { 'en-US': { title: p.name } },
          defaultPrice,
          prices: p.prices || {},
          // Keep original Apple data for reference
          _appleProduct: p,
        };
      }

      return data;
    },
    enabled: !!sku && !!platform,
  });
}

export function useUpdateProductPrices() {
  const queryClient = useQueryClient();
  const platform = useAuthStore((state) => state.platform);

  return useMutation({
    mutationFn: async ({
      sku,
      prices,
      defaultPrice,
    }: {
      sku: string;
      prices: Record<string, Money>;
      defaultPrice?: Money;
    }) => {
      const url = platform === 'apple'
        ? `/api/apple/products/${encodeURIComponent(sku)}`
        : `/api/products/${encodeURIComponent(sku)}`;

      const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices, defaultPrice }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to update product');
      }

      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['products', platform] });
      queryClient.invalidateQueries({ queryKey: ['products', platform, variables.sku] });
      if (platform === 'apple') {
        queryClient.invalidateQueries({ queryKey: ['apple', 'products'] });
      }
      queryClient.invalidateQueries({ queryKey: ['platform-products', platform] });
    },
  });
}

export function useDeleteRegionPrice() {
  const queryClient = useQueryClient();
  const platform = useAuthStore((state) => state.platform);

  return useMutation({
    mutationFn: async ({ sku, regionCode }: { sku: string; regionCode: string }) => {
      const url = platform === 'apple'
        ? `/api/apple/products/${encodeURIComponent(sku)}`
        : `/api/products/${encodeURIComponent(sku)}`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regionCode }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete region price');
      }

      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['products', platform] });
      queryClient.invalidateQueries({ queryKey: ['products', platform, variables.sku] });
      if (platform === 'apple') {
        queryClient.invalidateQueries({ queryKey: ['apple', 'products'] });
      }
      queryClient.invalidateQueries({ queryKey: ['platform-products', platform] });
    },
  });
}
