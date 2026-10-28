'use client';

import { useQuery } from '@tanstack/react-query';
import { Package, CreditCard } from 'lucide-react';
import Link from 'next/link';
import { PageHeader, pageClass, useAppContextLabel } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Header } from '@/components/layout';
import { apiFetch } from '@/lib/web/client';

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
    <Link
      href={href}
      className="group block rounded-2xl border bg-card p-6 transition-colors hover:border-primary"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold">{title}</h2>
        <Icon className="h-4 w-4 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
      </div>
      {isLoading ? (
        <Skeleton className="mt-3 h-9 w-16" />
      ) : (
        <p className="mt-2 font-mono text-[32px] font-medium leading-tight">{value}</p>
      )}
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </Link>
  );
}

export default function AppleDashboardPage() {
  const context = useAppContextLabel('apple');

  const { data: stats, isLoading, refetch, isRefetching } = useQuery<StatsResponse>({
    queryKey: ['stats', 'apple'],
    queryFn: async () => {
      const [productsRes, subscriptionsRes] = await Promise.all([
        apiFetch('/api/apple/products'),
        apiFetch('/api/apple/subscriptions'),
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

      <div className={pageClass}>
        <PageHeader eyebrow={context} title="Overview" description="Your App Store products and subscriptions at a glance." />

        <div className="grid gap-4 md:grid-cols-2">
          <StatCard
            title="In-app purchases"
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
