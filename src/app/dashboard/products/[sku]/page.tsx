'use client';

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft, Package } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Header } from '@/components/layout';
import { PricingEditor } from '@/components/products/pricing-editor';
import { useProduct } from '@/hooks/use-products';
import { formatMoney } from '@/lib/google-play/types';
import { useAuthStore } from '@/store/auth-store';

function formatAppleProductType(type?: string): string {
  if (!type) return 'Unknown';
  const typeMap: Record<string, string> = {
    CONSUMABLE: 'Consumable',
    NON_CONSUMABLE: 'Non-Consumable',
    NON_RENEWING_SUBSCRIPTION: 'Non-Renewing Subscription',
  };
  return typeMap[type] || type;
}

export default function ProductDetailPage({
  params,
}: {
  params: Promise<{ sku: string }>;
}) {
  const { sku } = use(params);
  const decodedSku = decodeURIComponent(sku);
  const platform = useAuthStore((state) => state.platform);

  const { data, isLoading, error, refetch, isRefetching } = useProduct(decodedSku);

  if (error) {
    toast.error(error.message);
  }

  const product = data?.product;

  const getProductTitle = () => {
    if (!product) return decodedSku;
    const listing = product.listings?.[product.defaultLanguage];
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
            <Link href="/dashboard/products">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex-1">
            {isLoading ? (
              <Skeleton className="h-8 w-64" />
            ) : (
              <>
                <h1 className="text-2xl font-bold">{getProductTitle()}</h1>
                <p className="text-muted-foreground font-mono">{decodedSku}</p>
              </>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-4">
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
                      {product.status}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Type</p>
                    <p className="font-medium mt-1">
                      {platform === 'apple'
                        ? formatAppleProductType(product.purchaseType)
                        : product.purchaseType === 'managedUser'
                        ? 'Managed Product'
                        : product.purchaseType}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">
                      {platform === 'apple' ? 'Base Price (USD)' : 'Default Price'}
                    </p>
                    <p className="font-medium mt-1">
                      {product.defaultPrice
                        ? formatMoney(product.defaultPrice)
                        : 'Not set'}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">
                      {platform === 'apple' ? 'Territories' : 'Regional Prices'}
                    </p>
                    <p className="font-medium mt-1">
                      {Object.keys(product.prices || {}).length} {platform === 'apple' ? 'territories' : 'regions'}
                    </p>
                  </div>
                </div>

                {product.listings?.[product.defaultLanguage]?.description && (
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-sm text-muted-foreground">Description</p>
                    <p className="mt-1">
                      {product.listings[product.defaultLanguage].description}
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
                <Link href="/dashboard/products">Back to Products</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
