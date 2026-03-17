'use client';

import { useCallback } from 'react';
import { Loader2, DollarSign, Info } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Header } from '@/components/layout';
import { PricingEditor } from '@/components/products/pricing-editor';
import { formatMoney, type InAppProduct, type Money } from '@/lib/google-play/types';
import type { AppleProductPrice } from '@/lib/apple-connect/types';

interface AppPriceResponse {
  prices: Record<string, AppleProductPrice>;
  baseTerritory: string;
  hasSchedule: boolean;
}

export default function AppleAppPricePage() {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch, isRefetching } = useQuery<AppPriceResponse>({
    queryKey: ['apple', 'app-price'],
    queryFn: async () => {
      const response = await fetch('/api/apple/app-price');
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch app price');
      }
      return response.json();
    },
  });

  if (error) {
    toast.error(error.message);
  }

  // Normalize app price data into InAppProduct shape for PricingEditor
  // Uses the same normalization pattern as the product detail page —
  // Apple prices are passed through as-is since PricingEditor handles both formats at runtime
  const product: InAppProduct | null =
    data?.hasSchedule
      ? (() => {
          const baseTerritoryCode = data.baseTerritory || 'USA';
          const basePrice = data.prices?.[baseTerritoryCode];
          const defaultPrice = basePrice
            ? { currencyCode: basePrice.currency || 'USD', units: basePrice.customerPrice }
            : null;

          return {
            sku: 'app-price',
            packageName: '',
            status: 'active',
            purchaseType: 'managedUser',
            listings: { 'en-US': { title: 'App Price' } },
            defaultPrice: defaultPrice ?? { currencyCode: 'USD', units: '0' },
            prices: data.prices || {},
            defaultLanguage: 'en-US',
            _appleProduct: { prices: data.prices || {} },
          } as unknown as InAppProduct;
        })()
      : null;

  const handleSave = useCallback(async (prices: Record<string, Money>) => {
    const response = await fetch('/api/apple/app-price', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prices,
        baseTerritoryId: data?.baseTerritory || 'USA',
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('401: Unauthorized');
      }
      const error = await response.json();
      throw new Error(error.error || 'Failed to update app price');
    }

    const result = await response.json();
    queryClient.invalidateQueries({ queryKey: ['apple', 'app-price'] });
    return result;
  }, [data?.baseTerritory, queryClient]);

  return (
    <div className="flex flex-col h-full">
      <Header
        onRefresh={() => refetch()}
        isRefreshing={isRefetching}
        showSearch={false}
      />

      <div className="flex-1 p-6 space-y-6">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <h1 className="text-2xl font-bold">App Price</h1>
            <p className="text-muted-foreground">
              Manage your app&apos;s pricing across territories
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Fetching app pricing, please wait...</span>
            </div>
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : product ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  Pricing Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid md:grid-cols-3 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Base Territory</p>
                    <p className="font-medium mt-1">{data?.baseTerritory || 'USA'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Base Price ({product.defaultPrice?.currencyCode || 'USD'})
                    </p>
                    <p className="font-medium mt-1">
                      {product.defaultPrice
                        ? formatMoney(product.defaultPrice)
                        : 'Not set'}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Territories</p>
                    <p className="font-medium mt-1">
                      {Object.keys(data?.prices || {}).length} territories
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <PricingEditor product={product} onSave={handleSave} />
          </>
        ) : (
          <Card>
            <CardContent className="py-12 text-center space-y-3">
              <Info className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="text-lg font-medium">This app is currently free</p>
              <p className="text-muted-foreground text-sm max-w-md mx-auto">
                No price schedule has been set for this app. You can set a price
                through App Store Connect to enable pricing management here.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
