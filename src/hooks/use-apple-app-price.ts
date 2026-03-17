import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AppleProductPrice } from '@/lib/apple-connect/types';

interface AppPriceData {
  prices: Record<string, AppleProductPrice>;
  baseTerritory: string;
  hasSchedule: boolean;
}

export function useAppleAppPrice() {
  return useQuery<AppPriceData>({
    queryKey: ['apple', 'app-price'],
    queryFn: async () => {
      const response = await fetch('/api/apple/app-price');
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch app price');
      }
      return response.json();
    },
  });
}

export function useUpdateAppleAppPrice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      prices,
      baseTerritoryId,
    }: {
      prices: Record<string, { pricePointId: string } | { currencyCode: string; units: string; nanos?: number }>;
      baseTerritoryId?: string;
    }) => {
      const response = await fetch('/api/apple/app-price', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices, baseTerritoryId }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to update app price');
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apple', 'app-price'] });
    },
  });
}
