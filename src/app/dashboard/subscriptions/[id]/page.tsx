'use client';

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft, CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Header } from '@/components/layout';
import { BasePlanEditor } from '@/components/subscriptions/base-plan-editor';
import { useSubscription } from '@/hooks/use-subscriptions';
import { useAuthStore } from '@/store/auth-store';
import { formatMoney } from '@/lib/google-play/types';

function formatApplePeriod(period?: string): string {
  if (!period) return 'Unknown';
  const periodMap: Record<string, string> = {
    ONE_WEEK: 'Weekly',
    ONE_MONTH: 'Monthly',
    TWO_MONTHS: '2 Months',
    THREE_MONTHS: 'Quarterly',
    SIX_MONTHS: '6 Months',
    ONE_YEAR: 'Annual',
  };
  return periodMap[period] || period;
}

function formatAppleStatus(state?: string): string {
  if (!state) return 'Unknown';
  const statusMap: Record<string, string> = {
    APPROVED: 'Approved',
    READY_TO_SUBMIT: 'Ready to Submit',
    WAITING_FOR_REVIEW: 'In Review',
    DEVELOPER_ACTION_NEEDED: 'Action Needed',
    IN_REVIEW: 'In Review',
    REJECTED: 'Rejected',
    DEVELOPER_REMOVED_FROM_SALE: 'Removed',
    REMOVED_FROM_SALE: 'Removed',
  };
  return statusMap[state] || state;
}

export default function SubscriptionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const decodedId = decodeURIComponent(id);
  const platform = useAuthStore((state) => state.platform);

  const { data, isLoading, error, refetch, isRefetching } = useSubscription(decodedId);

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

  const getActiveBasePlansCount = () => {
    return (
      subscription?.basePlans?.filter((bp) => bp.state === 'active').length || 0
    );
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

  return (
    <div className="flex flex-col h-full">
      <Header
        onRefresh={() => refetch()}
        isRefreshing={isRefetching}
        showSearch={false}
      />

      <div className="flex-1 p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/dashboard/subscriptions">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex-1">
            {isLoading ? (
              <Skeleton className="h-8 w-64" />
            ) : (
              <>
                <h1 className="text-2xl font-bold">{getSubscriptionTitle()}</h1>
                <p className="text-muted-foreground font-mono">{decodedId}</p>
              </>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : subscription ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <CreditCard className="h-5 w-5" />
                  Subscription Details
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {platform === 'apple' ? (
                    <>
                      <div>
                        <p className="text-sm text-muted-foreground">Status</p>
                        <Badge
                          variant={subscription.archived ? 'secondary' : 'default'}
                          className="mt-1"
                        >
                          {formatAppleStatus((subscription as { _appleSubscription?: { state?: string } })._appleSubscription?.state)}
                        </Badge>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Period</p>
                        <p className="font-medium mt-1">
                          {formatApplePeriod((subscription as { _appleSubscription?: { period?: string } })._appleSubscription?.period)}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Base Price (USD)</p>
                        <p className="font-medium mt-1">
                          {(() => {
                            const appleSub = (subscription as { _appleSubscription?: { usaPrice?: { customerPrice: string; currency: string } } })._appleSubscription;
                            const usaPrice = appleSub?.usaPrice;
                            if (usaPrice) {
                              return formatMoney({ currencyCode: usaPrice.currency || 'USD', units: usaPrice.customerPrice });
                            }
                            return 'Not set';
                          })()}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Group</p>
                        <p className="font-medium mt-1">
                          {(subscription as { _appleSubscription?: { groupName?: string } })._appleSubscription?.groupName || 'Unknown'}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <p className="text-sm text-muted-foreground">Status</p>
                        <Badge
                          variant={subscription.archived ? 'secondary' : 'default'}
                          className="mt-1"
                        >
                          {subscription.archived ? 'Archived' : 'Active'}
                        </Badge>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Base Plans</p>
                        <p className="font-medium mt-1">
                          {subscription.basePlans?.length || 0} total
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Base Price</p>
                        <p className="font-medium mt-1">{getBasePrice()}</p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Regions</p>
                        <p className="font-medium mt-1">{getTotalRegions()}</p>
                      </div>
                    </>
                  )}
                </div>

                {subscription.listings?.[0]?.description && (
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-sm text-muted-foreground">Description</p>
                    <p className="mt-1">{subscription.listings[0].description}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {platform === 'google' && (
              <div>
                <h2 className="text-lg font-semibold mb-4">Base Plans</h2>
                <BasePlanEditor subscription={subscription} />
              </div>
            )}
          </>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">Subscription not found</p>
              <Button variant="outline" className="mt-4" asChild>
                <Link href="/dashboard/subscriptions">Back to Subscriptions</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
