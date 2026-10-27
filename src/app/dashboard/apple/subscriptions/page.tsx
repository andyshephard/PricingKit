'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Header } from '@/components/layout';
import { SubscriptionsTable } from '@/components/subscriptions/subscriptions-table';
import { Button } from '@/components/ui/button';
import { useSelectionStore } from '@/store/selection-store';
import { useAuthStore } from '@/store/auth-store';
import { pickBasePrice, productBaseKey } from '@/lib/base-territory';

const EMPTY_BASES: Record<string, string> = {};
import { parseMoney } from '@/lib/google-play/types';
import type { RawAppleSubscription, SubscriptionsListResponse } from '@/types/api';

export default function AppleSubscriptionsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const appleBaseCountry = useAuthStore((state) => state.appleBaseCountry) || 'US';
  const bundleId = useAuthStore((state) => state.bundleId);
  const productBases = useAuthStore((state) => state.appleProductBaseTerritories) ?? EMPTY_BASES;

  const { data, isLoading, refetch, isRefetching, error } = useQuery<SubscriptionsListResponse>({
    queryKey: ['subscriptions', 'apple', appleBaseCountry, bundleId, productBases],
    queryFn: async () => {
      const response = await fetch('/api/apple/subscriptions');
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch subscriptions');
      }
      const data = await response.json();

      // Normalize Apple subscriptions for the table
      if (data.subscriptions) {
        data.subscriptions = data.subscriptions.map((s: RawAppleSubscription) => {
          // The product's own base territory first, then the display default, then US
          const picked = pickBasePrice(s.prices, [productBases[productBaseKey(bundleId, s.productId)], appleBaseCountry, 'US']);
          const basePrice = picked?.price ?? null;
          const basePriceRegion = picked?.region ?? null;

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
                price: parseMoney(parseFloat(basePrice.customerPrice), basePrice.currency || 'USD'),
              }] : [],
            }],
            _appleSubscription: { ...s, basePrice },
          };
        });
      }

      return data;
    },
  });

  const { selectedSubscriptionIds, setSelectedSubscriptions } = useSelectionStore();

  if (error) {
    toast.error(error.message);
  }

  const subscriptions = data?.subscriptions || [];

  return (
    <div className="flex flex-col h-full">
      <Header
        onRefresh={() => refetch()}
        isRefreshing={isRefetching}
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <div className="flex-1 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Subscriptions</h1>
            <p className="text-muted-foreground">
              Manage subscription pricing across territories
            </p>
          </div>

          {selectedSubscriptionIds.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {selectedSubscriptionIds.length} selected
              </span>
              <Button
                variant="outline"
                onClick={() => setSelectedSubscriptions([])}
              >
                Clear Selection
              </Button>
            </div>
          )}
        </div>

        <SubscriptionsTable
          subscriptions={subscriptions}
          isLoading={isLoading}
          selectedIds={selectedSubscriptionIds}
          onSelectionChange={setSelectedSubscriptions}
          searchQuery={searchQuery}
          platform="apple"
        />
      </div>
    </div>
  );
}
