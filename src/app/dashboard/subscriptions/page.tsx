'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Header } from '@/components/layout';
import { SubscriptionsTable } from '@/components/subscriptions/subscriptions-table';
import { BulkUpdateModal } from '@/components/pricing/bulk-update-modal';
import { Button } from '@/components/ui/button';
import { useSubscriptions } from '@/hooks/use-subscriptions';
import { useSelectionStore } from '@/store/selection-store';

export default function SubscriptionsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkModalOpen, setBulkModalOpen] = useState(false);

  const { data, isLoading, refetch, isRefetching, error } = useSubscriptions();
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
              Manage subscription base plans and regional pricing
            </p>
          </div>

          {selectedSubscriptionIds.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {selectedSubscriptionIds.length} selected
              </span>
              <Button onClick={() => setBulkModalOpen(true)}>
                Bulk Update Prices
              </Button>
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
