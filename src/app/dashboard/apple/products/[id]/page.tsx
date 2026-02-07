'use client';

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Package } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Header } from '@/components/layout';
import { PricingEditor } from '@/components/products/pricing-editor';
import { formatMoney, type InAppProduct } from '@/lib/google-play/types';
import type { RawAppleProduct } from '@/types/api';

function formatAppleProductType(type?: string): string {
  if (!type) return 'Unknown';
  const typeMap: Record<string, string> = {
    CONSUMABLE: 'Consumable',
    NON_CONSUMABLE: 'Non-Consumable',
    NON_RENEWING_SUBSCRIPTION: 'Non-Renewing Subscription',
  };
  return typeMap[type] || type;
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

export default function AppleProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const decodedId = decodeURIComponent(id);

  const { data, isLoading, error, refetch, isRefetching } = useQuery<{ product: InAppProduct & { _appleProduct?: RawAppleProduct } }>({
    queryKey: ['products', 'apple', decodedId],
    queryFn: async () => {
      const response = await fetch(`/api/apple/products/${encodeURIComponent(decodedId)}`);
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('401: Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch product');
      }
      const data = await response.json();

      // Normalize Apple product for the editor
      if (data.product) {
        const p = data.product as RawAppleProduct;
        const baseTerritoryCode = p.baseTerritory || 'USA';
        const basePrice = p.prices?.[baseTerritoryCode];
        const defaultPrice = basePrice
          ? { currencyCode: basePrice.currency || 'USD', units: basePrice.customerPrice }
          : null;

        data.product = {
          sku: p.productId,
          status: p.state === 'APPROVED' ? 'active' : 'inactive',
          purchaseType: p.type,
          listings: { 'en-US': { title: p.name } },
          defaultPrice,
          prices: p.prices || {},
          _appleProduct: p,
        };
      }

      return data;
    },
    enabled: !!decodedId,
  });

  if (error) {
    toast.error(error.message);
  }

  const product = data?.product;
  const appleProduct = product?._appleProduct as RawAppleProduct | undefined;

  const getProductTitle = () => {
    if (!product) return decodedId;
    const listing = product.listings?.['en-US'];
    return listing?.title || product.sku;
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
            <Link href="/dashboard/apple/products">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex-1">
            {isLoading ? (
              <Skeleton className="h-8 w-64" />
            ) : (
              <>
                <h1 className="text-2xl font-bold">{getProductTitle()}</h1>
                <p className="text-muted-foreground font-mono">{decodedId}</p>
              </>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Fetching product information, please wait...</span>
            </div>
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : product ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Package className="h-5 w-5" />
                  Product Details
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    <Badge
                      variant={product.status === 'active' ? 'default' : 'secondary'}
                      className="mt-1"
                    >
                      {formatAppleStatus(appleProduct?.state)}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Type</p>
                    <p className="font-medium mt-1">
                      {formatAppleProductType(product.purchaseType)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Base Price ({product.defaultPrice?.currencyCode || 'USD'})</p>
                    <p className="font-medium mt-1">
                      {product.defaultPrice
                        ? formatMoney(product.defaultPrice)
                        : 'Not set'}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Territories</p>
                    <p className="font-medium mt-1">
                      {Object.keys(product.prices || {}).length} territories
                    </p>
                  </div>
                </div>

                {product.listings?.['en-US']?.description && (
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-sm text-muted-foreground">Description</p>
                    <p className="mt-1">
                      {product.listings['en-US'].description}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            <PricingEditor product={product} />
          </>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">Product not found</p>
              <Button variant="outline" className="mt-4" asChild>
                <Link href="/dashboard/apple/products">Back to Products</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
