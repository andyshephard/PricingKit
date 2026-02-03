import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { NormalizedAppleProduct, AppleProductPrice } from '@/lib/apple-connect/types';

export function useAppleProducts() {
  return useQuery<{ products: NormalizedAppleProduct[] }>({
    queryKey: ['apple', 'products'],
    queryFn: async () => {
      const response = await fetch('/api/apple/products');
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch products');
      }
      return response.json();
    },
  });
}

export function useAppleProduct(productId: string) {
  return useQuery<{ product: NormalizedAppleProduct }>({
    queryKey: ['apple', 'products', productId],
    queryFn: async () => {
      const response = await fetch(
        `/api/apple/products/${encodeURIComponent(productId)}`
      );
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch product');
      }
      return response.json();
    },
    enabled: !!productId,
  });
}

export function useUpdateAppleProductPrices() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      productId,
      prices,
    }: {
      productId: string;
      prices: Record<string, { pricePointId: string; startDate?: string }>;
    }) => {
      const response = await fetch(
        `/api/apple/products/${encodeURIComponent(productId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prices }),
        }
      );

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
      queryClient.invalidateQueries({ queryKey: ['apple', 'products'] });
      queryClient.invalidateQueries({
        queryKey: ['apple', 'products', variables.productId],
      });
    },
  });
}
