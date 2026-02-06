import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/store/auth-store';
import type { Subscription, RegionalBasePlanConfig } from '@/lib/google-play/types';
import type { NormalizedAppleSubscription } from '@/lib/apple-connect/types';

// Unified subscription type that works for both platforms
export interface PlatformSubscription {
  id: string; // productId for both platforms
  name: string;
  status: string;
  period?: string;
  platform: 'google' | 'apple';
  // For Google: base plans info
  basePlans?: Array<{
    basePlanId: string;
    state: string;
    billingPeriod?: string;
    regionalConfigs: Array<{
      regionCode: string;
      price: { currencyCode: string; units: string; nanos?: number };
    }>;
  }>;
  // For Apple: group info
  groupId?: string;
  groupName?: string;
  // Original data for platform-specific operations
  googleSubscription?: Subscription;
  appleSubscription?: NormalizedAppleSubscription;
}

// Convert Google subscription to unified format
function normalizeGoogleSubscription(sub: Subscription): PlatformSubscription {
  const title = sub.listings?.[0]?.title || sub.productId;
  return {
    id: sub.productId,
    name: title,
    status: sub.archived ? 'archived' : 'active',
    platform: 'google',
    basePlans: sub.basePlans?.map((bp) => ({
      basePlanId: bp.basePlanId,
      state: bp.state,
      billingPeriod: bp.autoRenewingBasePlanType?.billingPeriodDuration ||
                     bp.prepaidBasePlanType?.billingPeriodDuration,
      regionalConfigs: bp.regionalConfigs || [],
    })),
    googleSubscription: sub,
  };
}

// Convert Apple subscription to unified format
function normalizeAppleSubscription(sub: NormalizedAppleSubscription): PlatformSubscription {
  return {
    id: sub.productId,
    name: sub.name,
    status: sub.state.toLowerCase(),
    period: sub.period,
    platform: 'apple',
    groupId: sub.groupId,
    groupName: sub.groupName,
    appleSubscription: sub,
  };
}

export function usePlatformSubscriptions() {
  const platform = useAuthStore((state) => state.platform);

  return useQuery<{ subscriptions: PlatformSubscription[] }>({
    queryKey: ['platform-subscriptions', platform],
    queryFn: async () => {
      if (!platform) {
        return { subscriptions: [] };
      }

      if (platform === 'google') {
        const response = await fetch('/api/subscriptions');
        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('401: Unauthorized');
          }
          const error = await response.json();
          throw new Error(error.error || 'Failed to fetch subscriptions');
        }
        const data = await response.json();
        return {
          subscriptions: (data.subscriptions || []).map(normalizeGoogleSubscription),
        };
      } else {
        const response = await fetch('/api/apple/subscriptions');
        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('401: Unauthorized');
          }
          const error = await response.json();
          throw new Error(error.error || 'Failed to fetch subscriptions');
        }
        const data = await response.json();
        return {
          subscriptions: (data.subscriptions || []).map(normalizeAppleSubscription),
        };
      }
    },
    enabled: !!platform,
  });
}

export function usePlatformSubscription(productId: string) {
  const platform = useAuthStore((state) => state.platform);

  return useQuery<{ subscription: PlatformSubscription }>({
    queryKey: ['platform-subscriptions', platform, productId],
    queryFn: async () => {
      if (!platform) {
        throw new Error('No platform selected');
      }

      const apiPath = platform === 'google'
        ? `/api/subscriptions/${encodeURIComponent(productId)}`
        : `/api/apple/subscriptions/${encodeURIComponent(productId)}`;

      const response = await fetch(apiPath);
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch subscription');
      }

      const data = await response.json();

      if (platform === 'google') {
        return { subscription: normalizeGoogleSubscription(data.subscription) };
      } else {
        return { subscription: normalizeAppleSubscription(data.subscription) };
      }
    },
    enabled: !!platform && !!productId,
  });
}

export function useUpdatePlatformSubscriptionPrices() {
  const queryClient = useQueryClient();
  const platform = useAuthStore((state) => state.platform);

  return useMutation({
    mutationFn: async ({
      productId,
      basePlanId,
      regionalConfigs,
      prices,
    }: {
      productId: string;
      // Google-specific
      basePlanId?: string;
      regionalConfigs?: RegionalBasePlanConfig[];
      // Apple-specific
      prices?: Record<string, { pricePointId: string; startDate?: string }>;
    }) => {
      if (!platform) {
        throw new Error('No platform selected');
      }

      const apiPath = platform === 'google'
        ? `/api/subscriptions/${encodeURIComponent(productId)}`
        : `/api/apple/subscriptions/${encodeURIComponent(productId)}`;

      const body = platform === 'google'
        ? { basePlanId, regionalConfigs }
        : { prices };

      const response = await fetch(apiPath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

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
      queryClient.invalidateQueries({ queryKey: ['platform-subscriptions', platform] });
      queryClient.invalidateQueries({
        queryKey: ['platform-subscriptions', platform, variables.productId],
      });
      queryClient.invalidateQueries({ queryKey: ['subscriptions', platform] });
      if (platform === 'apple') {
        queryClient.invalidateQueries({ queryKey: ['apple', 'subscriptions'] });
      }
    },
  });
}
