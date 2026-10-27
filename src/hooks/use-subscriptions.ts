import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { RegionalBasePlanConfig } from '@/lib/google-play/types';
import { parseMoney } from '@/lib/google-play/types';
import type { SubscriptionsListResponse, SubscriptionResponse } from '@/types/api';
import type { AppleProductPrice } from '@/lib/apple-connect/types';
import { useAuthStore } from '@/store/auth-store';
import { normalizeAppleSubscriptionList } from '@/lib/base-territory';
import { useStreamingMutation } from './use-streaming-mutation';

const EMPTY_BASES: Record<string, string> = {};

export function useSubscriptions() {
  const platform = useAuthStore((state) => state.platform);
  const appleBaseCountry = useAuthStore((state) => state.appleBaseCountry) || 'US';
  const bundleId = useAuthStore((state) => state.bundleId);
  const productBases = useAuthStore((state) => state.appleProductBaseTerritories) ?? EMPTY_BASES;

  const select = useCallback(
    (raw: SubscriptionsListResponse) =>
      platform === 'apple' ? (normalizeAppleSubscriptionList(raw, { bundleId, productBases, displayDefault: appleBaseCountry }, parseMoney) as SubscriptionsListResponse) : raw,
    [platform, bundleId, productBases, appleBaseCountry]
  );
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

      return data;
    },
    // Apple: normalised on read, so a base territory change re-selects and never refetches
    select,
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
                price: parseMoney(parseFloat(priceData.customerPrice || '0'), priceData.currency || 'USD'),
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

export function useUpdateBasePlanPrices(platformOverride?: 'google' | 'apple') {
  const queryClient = useQueryClient();
  const storePlatform = useAuthStore((state) => state.platform);
  const platform = platformOverride ?? storePlatform;

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
  const streaming = useStreamingMutation<AppleSubscriptionUpdateResult>();

  const mutateAsync = async ({
    subscriptionId,
    prices,
    preserveCurrentPrice,
  }: {
    subscriptionId: string;
    prices: Record<string, { pricePointId: string; startDate?: string }>;
    preserveCurrentPrice?: boolean;
  }) => {
    const result = await streaming.mutateAsync(
      `/api/apple/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices, preserveCurrentPrice }),
      }
    );

    // Invalidate caches after streaming completes
    queryClient.invalidateQueries({ queryKey: ['subscriptions', 'apple'] });
    queryClient.invalidateQueries({
      queryKey: ['subscriptions', 'apple', subscriptionId],
    });
    queryClient.invalidateQueries({ queryKey: ['apple', 'subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['platform-subscriptions', 'apple'] });

    // Per-territory failures arrive in a "done" event; don't treat them as success
    if (result.success === false) {
      throw new AppleSubscriptionUpdateError(result);
    }

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

/** Per-territory result from PATCH /api/apple/subscriptions/[id] */
export interface AppleTerritoryPriceOutcome {
  territoryCode: string;
  status: 'created' | 'replaced' | 'failed';
  error?: string;
  warning?: string;
}

export interface AppleSubscriptionUpdateResult {
  success: boolean;
  updatedCount?: number;
  failedCount?: number;
  results?: AppleTerritoryPriceOutcome[];
}

/** Thrown when some territories failed; message lists them */
export class AppleSubscriptionUpdateError extends Error {
  constructor(public result: AppleSubscriptionUpdateResult) {
    const failed = (result.results ?? []).filter((r) => r.status === 'failed');
    const listed = failed
      .slice(0, 3)
      .map((r) => `${r.territoryCode}: ${r.error ?? 'failed'}`)
      .join('; ');
    const more = failed.length > 3 ? ` and ${failed.length - 3} more` : '';
    super(
      `Updated ${result.updatedCount ?? 0} regions, ${failed.length} failed (${listed}${more})`
    );
    this.name = 'AppleSubscriptionUpdateError';
  }
}

// Hook to resolve Apple subscription price points in batch (server-side)
export interface BatchResolvedPricePoints {
  resolved: Record<string, { pricePointId: string; tierPrice: number }>;
  skipped: string[];
  /** Why each skipped territory couldn't be resolved */
  skippedReasons?: Record<string, string>;
}

export function useResolveAppleSubscriptionPricePoints() {
  const streaming = useStreamingMutation<BatchResolvedPricePoints>();

  const mutateAsync = async ({
    subscriptionId,
    territories,
  }: {
    subscriptionId: string;
    territories: Record<string, { targetPrice: number; currency: string }>;
  }) => {
    return streaming.mutateAsync(
      `/api/apple/subscriptions/${encodeURIComponent(subscriptionId)}/price-points/batch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ territories }),
      }
    );
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
