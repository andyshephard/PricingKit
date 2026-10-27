'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { Calculator } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Header } from '@/components/layout';
import { PageHeader, pageClass } from '@/components/layout/page-header';
import { DetailList, PanelCard, StrategyPanel } from '@/components/pricing/strategy-panel';
import { BasePlanEditor } from '@/components/subscriptions/base-plan-editor';
import { PlaySubscriptionOffers } from '@/components/subscriptions/play-subscription-offers';
import { ExportPricesButton } from '@/components/pricing/export-prices-button';
import { formatMoney } from '@/lib/google-play/types';
import type { SubscriptionResponse } from '@/types/api';

export default function GoogleSubscriptionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [strategyPlanId, setStrategyPlanId] = useState<string | null>(null);
  const decodedId = decodeURIComponent(id);

  const { data, isLoading, error, refetch, isRefetching } = useQuery<SubscriptionResponse>({
    queryKey: ['subscriptions', 'google', decodedId],
    queryFn: async () => {
      const response = await fetch(`/api/subscriptions/${encodeURIComponent(decodedId)}`);
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch subscription');
      }
      return response.json();
    },
    enabled: !!decodedId,
  });

  if (error) {
    toast.error(error.message);
  }

  const subscription = data?.subscription;

  const getSubscriptionTitle = () => {
    if (!subscription) return decodedId;
    const listing =
      subscription.listings?.find((l) => l.languageCode === 'en-US') ||
      subscription.listings?.[0];
    return listing?.title || subscription.productId;
  };

  const getTotalRegions = () => {
    const regions = new Set<string>();
    subscription?.basePlans?.forEach((bp) => {
      bp.regionalConfigs?.forEach((rc) => regions.add(rc.regionCode));
    });
    return regions.size;
  };

  const getBasePrice = () => {
    // Get US price from first base plan as the base price
    const firstBasePlan = subscription?.basePlans?.[0];
    const usConfig = firstBasePlan?.regionalConfigs?.find(
      (rc) => rc.regionCode === 'US'
    );
    if (usConfig?.price) {
      return formatMoney(usConfig.price);
    }
    return 'Not set';
  };

  const listHref = '/dashboard/google/subscriptions';
  const basePlans = subscription?.basePlans ?? [];

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
            description={<span className="font-mono text-sm text-muted-foreground">{decodedId}</span>}
            actions={
              subscription && (
                <ExportPricesButton
                  platform="google"
                  type="subscription"
                  id={subscription.productId || decodedId}
                  basePlanIds={subscription.basePlans?.map((bp) => bp.basePlanId) ?? []}
                />
              )
            }
          />
        </div>

        {isLoading ? (
          <div className="space-y-4">
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
                  <span className="text-[13px] text-muted-foreground">
                    {basePlans.length} base plan{basePlans.length === 1 ? '' : 's'} · {getTotalRegions()} regions
                  </span>
                </div>
                <div className="p-4 sm:p-5">
                  <BasePlanEditor
                    subscription={subscription}
                    bulkPricingPlanId={strategyPlanId}
                    onBulkPricingPlanIdChange={setStrategyPlanId}
                  />
                </div>
              </section>

              <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
                <StrategyPanel note="Google Play keeps existing subscribers on their current price. New prices apply to new subscribers.">
                  {basePlans.map((bp, i) => (
                    <Button
                      key={bp.basePlanId}
                      className="w-full"
                      size="lg"
                      variant={i === 0 ? 'default' : 'outline'}
                      onClick={() => setStrategyPlanId(bp.basePlanId)}
                    >
                      <Calculator aria-hidden="true" />
                      <span className="truncate">
                        Price {basePlans.length > 1 ? <span className="font-mono">{bp.basePlanId}</span> : 'base plan'} by strategy
                      </span>
                    </Button>
                  ))}
                  {basePlans.length === 0 && (
                    <p className="text-sm text-muted-foreground">This subscription has no base plans yet.</p>
                  )}
                </StrategyPanel>

                <PanelCard title="Details">
                  <DetailList
                    items={[
                      {
                        label: 'Status',
                        value: (
                          <Badge variant={subscription.archived ? 'secondary' : 'success'}>
                            {subscription.archived ? 'Archived' : 'Active'}
                          </Badge>
                        ),
                      },
                      { label: 'Base plans', value: basePlans.length },
                      { label: 'Base price', value: <span className="font-mono font-medium">{getBasePrice()}</span> },
                      { label: 'Regions', value: getTotalRegions() },
                    ]}
                  />
                  {subscription.listings?.[0]?.description && (
                    <p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed text-soft">
                      {subscription.listings[0].description}
                    </p>
                  )}
                </PanelCard>
              </div>
            </div>

            <PlaySubscriptionOffers productId={subscription.productId || decodedId} />
          </>
        ) : (
          <div className="rounded-2xl border bg-card px-6 py-12 text-center">
            <p className="text-muted-foreground">Subscription not found</p>
            <Button variant="outline" className="mt-4" asChild>
              <Link href={listHref}>Back to subscriptions</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
