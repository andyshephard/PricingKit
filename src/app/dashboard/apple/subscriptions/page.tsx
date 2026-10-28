'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Header } from '@/components/layout';
import { PageHeader, pageClass, useAppContextLabel } from '@/components/layout/page-header';
import { SubscriptionsTable } from '@/components/subscriptions/subscriptions-table';
import { Button } from '@/components/ui/button';
import { useSelectionStore } from '@/store/selection-store';
import { useAuthStore } from '@/store/auth-store';
import { normalizeAppleSubscriptionList } from '@/lib/base-territory';
import { parseMoney } from '@/lib/google-play/types';
import type { SubscriptionsListResponse } from '@/types/api';
import { apiFetch } from '@/lib/web/client';

const EMPTY_BASES: Record<string, string> = {};

export default function AppleSubscriptionsPage() {
  const context = useAppContextLabel('apple');
  const [searchQuery, setSearchQuery] = useState('');
  const appleBaseCountry = useAuthStore((state) => state.appleBaseCountry) || 'US';
  const bundleId = useAuthStore((state) => state.bundleId);
  const productBases = useAuthStore((state) => state.appleProductBaseTerritories) ?? EMPTY_BASES;

  const select = useCallback(
    (raw: SubscriptionsListResponse) => normalizeAppleSubscriptionList(raw, { bundleId, productBases, displayDefault: appleBaseCountry }, parseMoney) as SubscriptionsListResponse,
    [bundleId, productBases, appleBaseCountry]
  );
  const { data, isLoading, refetch, isRefetching, error } = useQuery<SubscriptionsListResponse>({
    queryKey: ['subscriptions', 'apple'],
    queryFn: async () => {
      const response = await apiFetch('/api/apple/subscriptions');
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
    // Normalised on read: a base territory change re-selects, it never refetches
    select,
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

      <div className={pageClass}>
        <PageHeader
          eyebrow={context}
          title="Subscriptions"
          description="Subscription prices in every territory."
          actions={
            selectedSubscriptionIds.length > 0 && (
            <>
              <span className="text-sm text-muted-foreground">
                {selectedSubscriptionIds.length} selected
              </span>
              <Button
                variant="outline"
                onClick={() => setSelectedSubscriptions([])}
              >
                Clear selection
              </Button>
            </>
            )
          }
        />

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
