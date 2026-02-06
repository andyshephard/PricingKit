'use client';

import { useQuery } from '@tanstack/react-query';
import { Package, CreditCard } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Header } from '@/components/layout';
import { useAuthStore } from '@/store/auth-store';

interface StatsResponse {
  products: {
    total: number;
    active: number;
  };
  subscriptions: {
    total: number;
    active: number;
  };
}

function StatCard({
  title,
  value,
  description,
  icon: Icon,
  href,
  isLoading,
}: {
  title: string;
  value: number | string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  isLoading?: boolean;
}) {
  return (
    <Link href={href}>
      <Card className="hover:border-primary/50 transition-colors cursor-pointer">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="text-2xl font-bold">{value}</div>
          )}
          <p className="text-xs text-muted-foreground">{description}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function AppleDashboardPage() {
  const bundleId = useAuthStore((state) => state.bundleId);

  const { data: stats, isLoading, refetch, isRefetching } = useQuery<StatsResponse>({
    queryKey: ['stats', 'apple'],
    queryFn: async () => {
      const [productsRes, subscriptionsRes] = await Promise.all([
        fetch('/api/apple/products'),
        fetch('/api/apple/subscriptions'),
      ]);

      const products = productsRes.ok ? await productsRes.json() : { products: [] };
      const subscriptions = subscriptionsRes.ok
        ? await subscriptionsRes.json()
        : { subscriptions: [] };

      // Apple uses different status names
      const activeProducts = products.products?.filter(
        (p: { state: string }) => p.state === 'APPROVED' || p.state === 'READY_TO_SUBMIT'
      ).length || 0;

      const activeSubscriptions = subscriptions.subscriptions?.filter(
        (sub: { state: string }) => sub.state === 'APPROVED' || sub.state === 'READY_TO_SUBMIT'
      ).length || 0;

      return {
        products: {
          total: products.products?.length || 0,
          active: activeProducts,
        },
        subscriptions: {
          total: subscriptions.subscriptions?.length || 0,
          active: activeSubscriptions,
        },
      };
    },
  });

  return (
    <div className="flex flex-col h-full">
      <Header
        onRefresh={() => refetch()}
        isRefreshing={isRefetching}
        showSearch={false}
      />

      <div className="flex-1 p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">App Store Dashboard</h1>
          <p className="text-muted-foreground">
            Overview for <span className="font-mono">{bundleId}</span>
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <StatCard
            title="In-App Products"
            value={stats?.products.total ?? 0}
            description={`${stats?.products.active ?? 0} approved`}
            icon={Package}
            href="/dashboard/apple/products"
            isLoading={isLoading}
          />
          <StatCard
            title="Subscriptions"
            value={stats?.subscriptions.total ?? 0}
            description={`${stats?.subscriptions.active ?? 0} approved`}
            icon={CreditCard}
            href="/dashboard/apple/subscriptions"
            isLoading={isLoading}
          />
        </div>
      </div>
    </div>
  );
}
