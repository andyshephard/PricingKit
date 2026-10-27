'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Calculator, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Header } from '@/components/layout';
import { PageHeader, pageClass } from '@/components/layout/page-header';
import { DetailList, PanelCard, StrategyPanel } from '@/components/pricing/strategy-panel';
import { AppleSubscriptionPricingEditor } from '@/components/subscriptions/apple-subscription-pricing-editor';
import { AppleSubscriptionOffers } from '@/components/subscriptions/apple-subscription-offers';
import { ExportPricesButton } from '@/components/pricing/export-prices-button';
import { formatMoney, parseMoney } from '@/lib/google-play/types';
import type { AppleProductPrice } from '@/lib/apple-connect/types';

interface AppleSubscriptionResponse {
  subscription: {
    id: string;
    productId: string;
    name: string;
    state: string;
    period: string;
    groupId?: string;
    groupName?: string;
    prices: Record<string, AppleProductPrice>;
    localizations?: Record<string, { name: string; description?: string }>;
  };
}

function formatAppleStatus(state?: string): {
  label: string;
  variant: 'success' | 'secondary' | 'outline' | 'warning';
} {
  if (!state) return { label: 'Unknown', variant: 'secondary' };
  const statusMap: Record<
    string,
    { label: string; variant: 'success' | 'secondary' | 'outline' | 'warning' }
  > = {
    APPROVED: { label: 'Active', variant: 'success' },
    READY_TO_SUBMIT: { label: 'Ready to submit', variant: 'secondary' },
    WAITING_FOR_REVIEW: { label: 'In review', variant: 'warning' },
    DEVELOPER_ACTION_NEEDED: { label: 'Action needed', variant: 'warning' },
    IN_REVIEW: { label: 'In review', variant: 'warning' },
    REJECTED: { label: 'Rejected', variant: 'secondary' },
    DEVELOPER_REMOVED_FROM_SALE: { label: 'Removed', variant: 'secondary' },
    REMOVED_FROM_SALE: { label: 'Removed', variant: 'secondary' },
  };
  return statusMap[state] || { label: state, variant: 'secondary' };
}

export default function AppleSubscriptionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [strategyOpen, setStrategyOpen] = useState(false);
  const decodedId = decodeURIComponent(id);

  const { data, isLoading, error, refetch, isRefetching } =
    useQuery<AppleSubscriptionResponse | null>({
      queryKey: ['subscriptions', 'apple', decodedId],
      queryFn: async () => {
        const response = await fetch(
          `/api/apple/subscriptions/${encodeURIComponent(decodedId)}`
        );
        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('401: Unauthorized');
          }
          // A genuine 404 is "not found", not a failed load
          if (response.status === 404) {
            return null;
          }
          const error = await response.json();
          throw new Error(error.error || 'Failed to fetch subscription');
        }
        return response.json();
      },
      enabled: !!decodedId,
    });

  // Track the last error shown to avoid showing duplicates
  const lastErrorShown = useRef<string | null>(null);

  useEffect(() => {
    if (error && error.message !== lastErrorShown.current) {
      lastErrorShown.current = error.message;
      toast.error(error.message);
    }
  }, [error]);

  const subscription = data?.subscription;

  const getSubscriptionTitle = () => {
    if (!subscription) return decodedId;
    // Try to get localized name, fallback to name
    const enLocalization = subscription.localizations?.['en-US'];
    return enLocalization?.name || subscription.name || subscription.productId;
  };

  const getBasePrice = () => {
    // Get US price as base price, fallback to first available
    const usPrice = subscription?.prices?.US || subscription?.prices?.USA;
    const firstPrice = Object.values(subscription?.prices || {})[0];
    const basePrice = usPrice || firstPrice;
    
    if (basePrice) {
      return formatMoney(parseMoney(parseFloat(basePrice.customerPrice), basePrice.currency || 'USD'));
    }
    return 'Not set';
  };

  const getTotalTerritories = () => {
    return Object.keys(subscription?.prices || {}).length;
  };

  const getDescription = () => {
    const enLocalization = subscription?.localizations?.['en-US'];
    return enLocalization?.description;
  };

  const status = formatAppleStatus(subscription?.state);
  const listHref = '/dashboard/apple/subscriptions';

  return (
    <div className="flex flex-col h-full">
      <Header
        onRefresh={() => refetch()}
        isRefreshing={isRefetching}
        showSearch={false}
      />

      <div className={pageClass}>
        <div>
          <nav aria-label="Breadcrumb" className="text-[13px] text-muted-foreground">
            <Link href={listHref} className="rounded-md hover:text-foreground">
              Subscriptions
            </Link>
            <span aria-hidden="true"> / </span>
            <span aria-current="page">{isLoading ? '…' : getSubscriptionTitle()}</span>
          </nav>
          <PageHeader
            className="mt-1.5"
            title={isLoading ? <Skeleton className="h-8 w-64" /> : getSubscriptionTitle()}
            description={<span className="font-mono text-sm text-muted-foreground">{subscription?.productId || decodedId}</span>}
            actions={
              subscription && (
                <ExportPricesButton
                  platform="apple"
                  type="subscription"
                  id={subscription.productId || decodedId}
                />
              )
            }
          />
        </div>

        {isLoading ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-muted-foreground py-4" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span className="text-sm">Fetching subscription information, please wait...</span>
            </div>
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : subscription ? (
          <>
            <div className="flex flex-wrap items-start gap-5">
              <section
                aria-labelledby="prices-heading"
                className="min-w-0 flex-[1_1_560px] overflow-hidden rounded-2xl border bg-card"
              >
                <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
                  <h2 id="prices-heading" className="flex-1 text-[17px] font-bold">
                    Prices by country
                  </h2>
                  <span className="text-[13px] text-muted-foreground">{getTotalTerritories()} territories</span>
                </div>
                <div className="p-4 sm:p-5">
                  <AppleSubscriptionPricingEditor
                    subscription={subscription}
                    bulkPricingOpen={strategyOpen}
                    onBulkPricingOpenChange={setStrategyOpen}
                  />
                </div>
              </section>

              <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
                <StrategyPanel
                  note={
                    <>
                      Existing subscribers keep their price when &ldquo;Preserve existing subscriber prices&rdquo; is on.
                      Decreases reach everyone.
                    </>
                  }
                >
                  <Button className="w-full" size="lg" onClick={() => setStrategyOpen(true)}>
                    <Calculator aria-hidden="true" />
                    Price by strategy
                  </Button>
                </StrategyPanel>

                <PanelCard title="Details">
                  <DetailList
                    items={[
                      { label: 'Status', value: <Badge variant={status.variant}>{status.label}</Badge> },
                      { label: 'Group', value: subscription.groupName || 'None' },
                      { label: 'Base price', value: <span className="font-mono font-medium">{getBasePrice()}</span> },
                      { label: 'Territories', value: getTotalTerritories() },
                    ]}
                  />
                  {getDescription() && (
                    <p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed text-soft">{getDescription()}</p>
                  )}
                </PanelCard>
              </div>
            </div>

            <AppleSubscriptionOffers subscriptionId={subscription.id} />
          </>
        ) : (
          <div className="rounded-2xl border bg-card px-6 py-12 text-center">
            {/* Distinguish a failed load from a genuinely missing subscription */}
            <p className={error ? 'text-destructive' : 'text-muted-foreground'}>
              {error ? `Could not load subscription: ${error.message}` : 'Subscription not found'}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {error && (
                <Button variant="outline" onClick={() => refetch()}>
                  Retry
                </Button>
              )}
              <Button variant="outline" asChild>
                <Link href={listHref}>Back to subscriptions</Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
