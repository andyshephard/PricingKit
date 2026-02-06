'use client';

import { use, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, CreditCard, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Header } from '@/components/layout';
import { AppleSubscriptionPricingEditor } from '@/components/subscriptions/apple-subscription-pricing-editor';
import { formatMoney } from '@/lib/google-play/types';
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
  variant: 'default' | 'secondary' | 'outline';
} {
  if (!state) return { label: 'Unknown', variant: 'secondary' };
  const statusMap: Record<
    string,
    { label: string; variant: 'default' | 'secondary' | 'outline' }
  > = {
    APPROVED: { label: 'Active', variant: 'default' },
    READY_TO_SUBMIT: { label: 'Ready to Submit', variant: 'secondary' },
    WAITING_FOR_REVIEW: { label: 'In Review', variant: 'outline' },
    DEVELOPER_ACTION_NEEDED: { label: 'Action Needed', variant: 'secondary' },
    IN_REVIEW: { label: 'In Review', variant: 'outline' },
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
  const decodedId = decodeURIComponent(id);

  const { data, isLoading, error, refetch, isRefetching } =
    useQuery<AppleSubscriptionResponse>({
      queryKey: ['subscriptions', 'apple', decodedId],
      queryFn: async () => {
        const response = await fetch(
          `/api/apple/subscriptions/${encodeURIComponent(decodedId)}`
        );
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
    // Get US price as base price
    const usPrice = subscription?.prices?.US;
    if (usPrice) {
      return formatMoney({
        currencyCode: usPrice.currency || 'USD',
        units: usPrice.customerPrice,
      });
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
            <Link href="/dashboard/apple/subscriptions">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex-1">
            {isLoading ? (
              <Skeleton className="h-8 w-64" />
            ) : (
              <>
                <h1 className="text-2xl font-bold">{getSubscriptionTitle()}</h1>
                <p className="text-muted-foreground font-mono">
                  {subscription?.productId || decodedId}
                </p>
              </>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Fetching subscription information, please wait...</span>
            </div>
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
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    {(() => {
                      const status = formatAppleStatus(subscription.state);
                      return (
                        <Badge variant={status.variant} className="mt-1">
                          {status.label}
                        </Badge>
                      );
                    })()}
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Subscription Group
                    </p>
                    <p className="font-medium mt-1">
                      {subscription.groupName || 'None'}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Base Price</p>
                    <p className="font-medium mt-1">{getBasePrice()}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Regions</p>
                    <p className="font-medium mt-1">{getTotalTerritories()}</p>
                  </div>
                </div>

                {getDescription() && (
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-sm text-muted-foreground">Description</p>
                    <p className="mt-1">{getDescription()}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <div>
              <h2 className="text-lg font-semibold mb-4">Subscription Plan</h2>
              <AppleSubscriptionPricingEditor subscription={subscription} />
            </div>
          </>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">Subscription not found</p>
              <Button variant="outline" className="mt-4" asChild>
                <Link href="/dashboard/apple/subscriptions">
                  Back to Subscriptions
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
