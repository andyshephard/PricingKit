import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Subscription, RegionalBasePlanConfig } from '@/lib/google-play/types';
import type { RawAppleSubscription, SubscriptionsListResponse, SubscriptionResponse } from '@/types/api';
import type { AppleProductPrice } from '@/lib/apple-connect/types';
import { useAuthStore } from '@/store/auth-store';

export function useSubscriptions() {
  const platform = useAuthStore((state) => state.platform);

  return useQuery<SubscriptionsListResponse>({
    queryKey: ['subscriptions', platform],
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
        console.log('[useSubscriptions] Raw Apple subscriptions:', data.subscriptions.length);
        console.log('[useSubscriptions] First subscription prices:', data.subscriptions[0]?.prices);

        data.subscriptions = data.subscriptions.map((s: RawAppleSubscription) => {
          // Get the base price (first/only price in the list view - this is the base territory price)
          const priceEntries = Object.entries(s.prices || {});
          const basePrice = priceEntries.length > 0 ? priceEntries[0][1] : null;

          console.log('[useSubscriptions] Subscription', s.productId, 'prices:', s.prices, 'basePrice:', basePrice);

          return {
            productId: s.productId,
            archived: s.state !== 'APPROVED' && s.state !== 'READY_TO_SUBMIT',
            listings: [{ title: s.name, languageCode: 'en-US' }],
            basePlans: [{
              basePlanId: 'default',
              state: s.state === 'APPROVED' ? 'active' : 'inactive',
              autoRenewingBasePlanType: { billingPeriodDuration: s.period },
              regionalConfigs: basePrice ? [{
                regionCode: priceEntries[0][0], // Territory code (e.g., 'USA')
                price: {
                  currencyCode: basePrice.currency || 'USD',
                  units: basePrice.customerPrice,
                },
              }] : [],
            }],
            // Keep original Apple data with base price info
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
    },
  });
}
