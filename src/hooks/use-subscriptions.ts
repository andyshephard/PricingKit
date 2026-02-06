import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Subscription, RegionalBasePlanConfig } from '@/lib/google-play/types';
import type { RawAppleSubscription, SubscriptionsListResponse, SubscriptionResponse } from '@/types/api';
import type { AppleProductPrice } from '@/lib/apple-connect/types';
import { useAuthStore } from '@/store/auth-store';
import { useStreamingMutation } from './use-streaming-mutation';

export function useSubscriptions() {
  const platform = useAuthStore((state) => state.platform);
  const appleBaseCountry = useAuthStore((state) => state.appleBaseCountry) || 'US';

  return useQuery<SubscriptionsListResponse>({
    queryKey: ['subscriptions', platform, platform === 'apple' ? appleBaseCountry : null],
    queryFn: async () => {
      const url = platform === 'apple' ? '/api/apple/subscriptions' : '/api/subscriptions';
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch subscriptions');
      }
      const data = await response.json();

      // Normalize Apple subscriptions to match Google subscription structure for table display
      if (platform === 'apple' && data.subscriptions) {
        data.subscriptions = data.subscriptions.map((s: RawAppleSubscription) => {
          // Get the base price for selected country, fallback to US, then first available
          const basePrice = s.prices?.[appleBaseCountry] || s.prices?.['US'] || Object.values(s.prices || {})[0] || null;
          const basePriceRegion = basePrice
            ? (s.prices?.[appleBaseCountry] ? appleBaseCountry : (s.prices?.['US'] ? 'US' : Object.keys(s.prices || {})[0]))
            : null;

          return {
            productId: s.productId,
            archived: s.state !== 'APPROVED' && s.state !== 'READY_TO_SUBMIT',
            listings: [{ title: s.name, languageCode: 'en-US' }],
            basePlans: [{
              basePlanId: 'default',
              state: s.state === 'APPROVED' ? 'active' : 'inactive',
              autoRenewingBasePlanType: { billingPeriodDuration: s.period },
              regionalConfigs: basePrice && basePriceRegion ? [{
                regionCode: basePriceRegion,
                price: {
                  currencyCode: basePrice.currency || 'USD',
                  units: basePrice.customerPrice,
                },
              }] : [],
            }],
            // Keep original Apple data with base price info (including id for routing)
            _appleSubscription: { ...s, basePrice },
          };
        });
      }

      return data;
    },
    enabled: !!platform,
  });
}

export function useSubscription(productId: string) {
  const platform = useAuthStore((state) => state.platform);

  return useQuery<SubscriptionResponse>({
    queryKey: ['subscriptions', platform, productId],
    queryFn: async () => {
      const url = platform === 'apple'
        ? `/api/apple/subscriptions/${encodeURIComponent(productId)}`
        : `/api/subscriptions/${encodeURIComponent(productId)}`;
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch subscription');
      }
      const data = await response.json();

      // Normalize Apple subscription to match Google subscription structure
      if (platform === 'apple' && data.subscription) {
        const s = data.subscription;
        // Get the base price - for detail view we have all prices, use USA as default display
        const usaPrice = s.prices?.USA;

        data.subscription = {
          productId: s.productId,
          archived: s.state !== 'APPROVED' && s.state !== 'READY_TO_SUBMIT',
          listings: [{ title: s.name, languageCode: 'en-US' }],
          basePlans: [{
            basePlanId: 'default',
            state: s.state === 'APPROVED' ? 'active' : 'inactive',
            autoRenewingBasePlanType: { billingPeriodDuration: s.period },
            regionalConfigs: Object.entries(s.prices || {}).map(([code, price]) => {
              const priceData = price as AppleProductPrice;
              return {
                regionCode: code,
                price: {
                  currencyCode: priceData.currency || 'USD',
                  units: priceData.customerPrice || '0',
                },
              };
            }),
          }],
          // Include basePrice in _appleSubscription for detail page access
          _appleSubscription: { ...s, basePrice: usaPrice },
        };
      }

      return data;
    },
    enabled: !!productId && !!platform,
  });
}

export function useUpdateBasePlanPrices() {
  const queryClient = useQueryClient();
  const platform = useAuthStore((state) => state.platform);

  return useMutation({
    mutationFn: async ({
      productId,
      basePlanId,
      regionalConfigs,
    }: {
      productId: string;
      basePlanId: string;
      regionalConfigs: RegionalBasePlanConfig[];
    }) => {
      const url = platform === 'apple'
        ? `/api/apple/subscriptions/${encodeURIComponent(productId)}`
        : `/api/subscriptions/${encodeURIComponent(productId)}`;

      const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basePlanId, regionalConfigs }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to update base plan');
      }

      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions', platform] });
      queryClient.invalidateQueries({
        queryKey: ['subscriptions', platform, variables.productId],
      });
      // Also invalidate other hook systems' caches to prevent stale data
      if (platform === 'apple') {
        queryClient.invalidateQueries({ queryKey: ['apple', 'subscriptions'] });
      }
      queryClient.invalidateQueries({ queryKey: ['platform-subscriptions', platform] });
    },
  });
}

export function useDeleteBasePlanRegionPrice() {
  const queryClient = useQueryClient();
  const platform = useAuthStore((state) => state.platform);

  return useMutation({
    mutationFn: async ({
      productId,
      basePlanId,
      regionCode,
    }: {
      productId: string;
      basePlanId: string;
      regionCode: string;
    }) => {
      const url = platform === 'apple'
        ? `/api/apple/subscriptions/${encodeURIComponent(productId)}`
        : `/api/subscriptions/${encodeURIComponent(productId)}`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basePlanId, regionCode }),
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
      queryClient.invalidateQueries({ queryKey: ['subscriptions', platform] });
      queryClient.invalidateQueries({
        queryKey: ['subscriptions', platform, variables.productId],
      });
      if (platform === 'apple') {
        queryClient.invalidateQueries({ queryKey: ['apple', 'subscriptions'] });
      }
      queryClient.invalidateQueries({ queryKey: ['platform-subscriptions', platform] });
    },
  });
}

// Hook to fetch available price points for a specific territory
export interface SubscriptionPricePoint {
  id: string;
  customerPrice: string;
  proceeds: string;
}

export function useSubscriptionPricePoints(subscriptionId: string, territoryCode: string) {
  return useQuery<{ pricePoints: SubscriptionPricePoint[] }>({
    queryKey: ['apple', 'subscriptions', subscriptionId, 'pricePoints', territoryCode],
    queryFn: async () => {
      const response = await fetch(
        `/api/apple/subscriptions/${encodeURIComponent(subscriptionId)}/price-points?territory=${encodeURIComponent(territoryCode)}`
      );
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch price points');
      }
      return response.json();
    },
    enabled: !!subscriptionId && !!territoryCode,
  });
}

// Hook to update Apple subscription prices (with streaming progress)
export function useUpdateAppleSubscriptionPrices() {
  const queryClient = useQueryClient();
  const streaming = useStreamingMutation();

  const mutateAsync = async ({
    subscriptionId,
    prices,
  }: {
    subscriptionId: string;
    prices: Record<string, { pricePointId: string; startDate?: string }>;
  }) => {
    const result = await streaming.mutateAsync(
      `/api/apple/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices }),
      }
    );

    // Invalidate caches after streaming completes
    queryClient.invalidateQueries({ queryKey: ['subscriptions', 'apple'] });
    queryClient.invalidateQueries({
      queryKey: ['subscriptions', 'apple', subscriptionId],
    });
    queryClient.invalidateQueries({ queryKey: ['apple', 'subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['platform-subscriptions', 'apple'] });

    return result;
  };

  return {
    mutateAsync,
    isPending: streaming.isPending,
    progress: streaming.progress,
    error: streaming.error,
    reset: streaming.reset,
  };
}

// Hook to delete Apple subscription price for a territory
export function useDeleteAppleSubscriptionPrice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      subscriptionId,
      subscriptionPriceId,
    }: {
      subscriptionId: string;
      subscriptionPriceId: string;
    }) => {
      const response = await fetch(
        `/api/apple/subscriptions/${encodeURIComponent(subscriptionId)}`,
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
        throw new Error(error.error || 'Failed to delete subscription price');
      }

      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['subscriptions', 'apple'] });
      queryClient.invalidateQueries({
        queryKey: ['subscriptions', 'apple', variables.subscriptionId],
      });
      queryClient.invalidateQueries({ queryKey: ['apple', 'subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['platform-subscriptions', 'apple'] });
    },
  });
}

// Hook to clear all scheduled (future) prices for an Apple subscription (with streaming progress)
export function useClearScheduledPrices() {
  const queryClient = useQueryClient();
  const streaming = useStreamingMutation();

  const mutateAsync = async ({
    subscriptionId,
  }: {
    subscriptionId: string;
  }) => {
    const result = await streaming.mutateAsync(
      `/api/apple/subscriptions/${encodeURIComponent(subscriptionId)}/clear-scheduled`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
    );

    // Invalidate caches after streaming completes
    queryClient.invalidateQueries({ queryKey: ['subscriptions', 'apple'] });
    queryClient.invalidateQueries({
      queryKey: ['subscriptions', 'apple', subscriptionId],
    });
    queryClient.invalidateQueries({ queryKey: ['apple', 'subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['platform-subscriptions', 'apple'] });

    return result;
  };

  return {
    mutateAsync,
    isPending: streaming.isPending,
    progress: streaming.progress,
    error: streaming.error,
    reset: streaming.reset,
  };
}
