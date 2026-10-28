'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Header } from '@/components/layout';
import { PageHeader, pageClass, useAppContextLabel } from '@/components/layout/page-header';
import { SubscriptionsTable } from '@/components/subscriptions/subscriptions-table';
import { BulkUpdateModal } from '@/components/pricing/bulk-update-modal';
import { Button } from '@/components/ui/button';
import { useSelectionStore } from '@/store/selection-store';
import type { SubscriptionsListResponse } from '@/types/api';
import { apiFetch } from '@/lib/web/client';

export default function GoogleSubscriptionsPage() {
  const context = useAppContextLabel('google');
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkModalOpen, setBulkModalOpen] = useState(false);

  const { data, isLoading, refetch, isRefetching, error } = useQuery<SubscriptionsListResponse>({
    queryKey: ['subscriptions', 'google'],
    queryFn: async () => {
      const response = await apiFetch('/api/subscriptions');
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
          description="Base plans and their regional prices."
          actions={
            selectedSubscriptionIds.length > 0 && (
            <>
              <span className="text-sm text-muted-foreground">
                {selectedSubscriptionIds.length} selected
              </span>
              <Button onClick={() => setBulkModalOpen(true)}>
                Update prices
              </Button>
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
          platform="google"
        />
      </div>

      <BulkUpdateModal
        open={bulkModalOpen}
        onOpenChange={setBulkModalOpen}
        type="subscription"
        selectedIds={selectedSubscriptionIds}
        onSuccess={() => {
          setSelectedSubscriptions([]);
          refetch();
        }}
      />
    </div>
  );
}
