import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  NormalizedAppleSubscription,
  NormalizedAppleSubscriptionGroup,
} from '@/lib/apple-connect/types';

export function useAppleSubscriptions() {
  return useQuery<{
    subscriptionGroups: NormalizedAppleSubscriptionGroup[];
    subscriptions: NormalizedAppleSubscription[];
  }>({
    queryKey: ['apple', 'subscriptions'],
    queryFn: async () => {
      const response = await fetch('/api/apple/subscriptions');
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch subscriptions');
      }
      return response.json();
    },
  });
}

export function useAppleSubscription(productId: string) {
  return useQuery<{ subscription: NormalizedAppleSubscription }>({
    queryKey: ['apple', 'subscriptions', productId],
    queryFn: async () => {
      const response = await fetch(
        `/api/apple/subscriptions/${encodeURIComponent(productId)}`
      );
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch subscription');
      }
      return response.json();
    },
    enabled: !!productId,
  });
}

export function useUpdateAppleSubscriptionPrices() {
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
        `/api/apple/subscriptions/${encodeURIComponent(productId)}`,
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
        throw new Error(error.error || 'Failed to update subscription');
      }

      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['apple', 'subscriptions'] });
      queryClient.invalidateQueries({
        queryKey: ['apple', 'subscriptions', variables.productId],
      });
      queryClient.invalidateQueries({ queryKey: ['subscriptions', 'apple'] });
      queryClient.invalidateQueries({ queryKey: ['platform-subscriptions', 'apple'] });
    },
  });
}

export function useDeleteAppleSubscriptionPrice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      productId,
      subscriptionPriceId,
    }: {
      productId: string;
      subscriptionPriceId: string;
    }) => {
      const response = await fetch(
        `/api/apple/subscriptions/${encodeURIComponent(productId)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscriptionPriceId }),
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete price');
      }

      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['apple', 'subscriptions'] });
      queryClient.invalidateQueries({
        queryKey: ['apple', 'subscriptions', variables.productId],
      });
      queryClient.invalidateQueries({ queryKey: ['subscriptions', 'apple'] });
      queryClient.invalidateQueries({ queryKey: ['platform-subscriptions', 'apple'] });
    },
  });
}
