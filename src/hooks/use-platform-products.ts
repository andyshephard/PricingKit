import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/store/auth-store';
import type { InAppProduct, Money } from '@/lib/google-play/types';
import type { NormalizedAppleProduct } from '@/lib/apple-connect/types';

// Unified product type that works for both platforms
export interface PlatformProduct {
  id: string; // SKU for Google, productId for Apple
  name: string;
  status: string;
  type: string;
  platform: 'google' | 'apple';
  // Original data for platform-specific operations
  googleProduct?: InAppProduct;
  appleProduct?: NormalizedAppleProduct;
}

// Convert Google product to unified format
function normalizeGoogleProduct(product: InAppProduct): PlatformProduct {
  const title = product.listings?.['en-US']?.title ||
                Object.values(product.listings || {})[0]?.title ||
                product.sku;
  return {
    id: product.sku,
    name: title,
    status: product.status,
    type: product.purchaseType,
    platform: 'google',
    googleProduct: product,
  };
}

// Convert Apple product to unified format
function normalizeAppleProduct(product: NormalizedAppleProduct): PlatformProduct {
  return {
    id: product.productId,
    name: product.name,
    status: product.state.toLowerCase(),
    type: product.type,
    platform: 'apple',
    appleProduct: product,
  };
}

export function usePlatformProducts() {
  const platform = useAuthStore((state) => state.platform);

  return useQuery<{ products: PlatformProduct[] }>({
    queryKey: ['platform-products', platform],
    queryFn: async () => {
      if (!platform) {
        return { products: [] };
      }

      if (platform === 'google') {
        const response = await fetch('/api/products');
        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('401: Unauthorized');
          }
          const error = await response.json();
          throw new Error(error.error || 'Failed to fetch products');
        }
        const data = await response.json();
        return {
          products: (data.products || []).map(normalizeGoogleProduct),
        };
      } else {
        const response = await fetch('/api/apple/products');
        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('401: Unauthorized');
          }
          const error = await response.json();
          throw new Error(error.error || 'Failed to fetch products');
        }
        const data = await response.json();
        return {
          products: (data.products || []).map(normalizeAppleProduct),
        };
      }
    },
    enabled: !!platform,
  });
}

export function usePlatformProduct(productId: string) {
  const platform = useAuthStore((state) => state.platform);

  return useQuery<{ product: PlatformProduct }>({
    queryKey: ['platform-products', platform, productId],
    queryFn: async () => {
      if (!platform) {
        throw new Error('No platform selected');
      }

      const apiPath = platform === 'google'
        ? `/api/products/${encodeURIComponent(productId)}`
        : `/api/apple/products/${encodeURIComponent(productId)}`;

      const response = await fetch(apiPath);
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch product');
      }

      const data = await response.json();

      if (platform === 'google') {
        return { product: normalizeGoogleProduct(data.product) };
      } else {
        return { product: normalizeAppleProduct(data.product) };
      }
    },
    enabled: !!platform && !!productId,
  });
}

export function useUpdatePlatformProductPrices() {
  const queryClient = useQueryClient();
  const platform = useAuthStore((state) => state.platform);

  return useMutation({
    mutationFn: async ({
      productId,
      prices,
      defaultPrice,
    }: {
      productId: string;
      prices: Record<string, Money> | Record<string, { pricePointId: string; startDate?: string }>;
      defaultPrice?: Money;
    }) => {
      if (!platform) {
        throw new Error('No platform selected');
      }

      const apiPath = platform === 'google'
        ? `/api/products/${encodeURIComponent(productId)}`
        : `/api/apple/products/${encodeURIComponent(productId)}`;

      const response = await fetch(apiPath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(platform === 'google' ? { prices, defaultPrice } : { prices }),
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
      queryClient.invalidateQueries({ queryKey: ['platform-products', platform] });
      queryClient.invalidateQueries({
        queryKey: ['platform-products', platform, variables.productId]
      });
    },
  });
}
