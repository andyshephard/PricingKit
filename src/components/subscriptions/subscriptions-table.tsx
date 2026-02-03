'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  ChevronRight,
  MoreHorizontal,
  Edit,
  Globe,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import type { Subscription, BasePlan, Money } from '@/lib/google-play/types';
import { formatMoney } from '@/lib/google-play/types';
import { useAuthStore } from '@/store/auth-store';

type SortField = 'productId' | 'basePlans' | 'status';
type SortOrder = 'asc' | 'desc';
type StatusFilter = 'all' | 'active' | 'inactive';

// Check if a subscription is active (works for both Google and Apple)
function isSubscriptionActive(subscription: Subscription, platform: string | null): boolean {
  if (platform === 'apple') {
    const appleSub = (subscription as { _appleSubscription?: { state?: string } })._appleSubscription;
    const state = appleSub?.state || '';
    return state === 'APPROVED' || state === 'READY_TO_SUBMIT';
  }
  // Google: check if any base plans are active
  return subscription.basePlans?.some((bp) => bp.state?.toLowerCase() === 'active') || false;
}

// Legacy function for backward compatibility
function hasActiveBasePlans(subscription: Subscription): boolean {
  return subscription.basePlans?.some((bp) => bp.state?.toLowerCase() === 'active') || false;
}

interface SubscriptionsTableProps {
  subscriptions: Subscription[];
  isLoading?: boolean;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  searchQuery: string;
}

function getSubscriptionTitle(subscription: Subscription): string {
  const defaultListing = subscription.listings?.find(
    (l) => l.languageCode === 'en-US'
  ) || subscription.listings?.[0];
  return defaultListing?.title || subscription.productId;
}

function getActiveBasePlansCount(subscription: Subscription): number {
  return subscription.basePlans?.filter((bp) => bp.state?.toLowerCase() === 'active').length || 0;
}

function getTotalRegions(subscription: Subscription): number {
  const regions = new Set<string>();
  subscription.basePlans?.forEach((bp) => {
    bp.regionalConfigs?.forEach((rc) => regions.add(rc.regionCode));
  });
  return regions.size;
}

// Get the US (base) price for a subscription - uses the first active base plan's US price
function getBasePrice(subscription: Subscription): Money | null {
  // Find the first active base plan with a US price
  for (const basePlan of subscription.basePlans || []) {
    if (basePlan.state?.toLowerCase() === 'active') {
      const usConfig = basePlan.regionalConfigs?.find(rc => rc.regionCode === 'US');
      if (usConfig?.price) {
        return usConfig.price;
      }
    }
  }
  // Fallback: any base plan with US price
  for (const basePlan of subscription.basePlans || []) {
    const usConfig = basePlan.regionalConfigs?.find(rc => rc.regionCode === 'US');
    if (usConfig?.price) {
      return usConfig.price;
    }
  }
  return null;
}

// Convert ISO 8601 duration to human-readable format (Google)
function formatBillingPeriod(duration: string): string {
  const durationMap: Record<string, string> = {
    'P1W': 'Weekly',
    'P2W': '2 Weeks',
    'P1M': 'Monthly',
    'P2M': '2 Months',
    'P3M': 'Quarterly',
    'P4M': '4 Months',
    'P6M': '6 Months',
    'P1Y': 'Annual',
    'P2Y': '2 Years',
    'P3Y': '3 Years',
  };
  return durationMap[duration] || duration;
}

// Convert Apple subscription period to human-readable format
function formatApplePeriod(period: string): string {
  const periodMap: Record<string, string> = {
    'ONE_WEEK': 'Weekly',
    'ONE_MONTH': 'Monthly',
    'TWO_MONTHS': '2 Months',
    'THREE_MONTHS': 'Quarterly',
    'SIX_MONTHS': '6 Months',
    'ONE_YEAR': 'Annual',
  };
  return periodMap[period] || period;
}

// Get Apple subscription period from normalized data
function getApplePeriod(subscription: Subscription): string {
  const appleSub = (subscription as { _appleSubscription?: { period?: string } })._appleSubscription;
  return appleSub?.period || '';
}

// Get Apple subscription status
function getAppleStatus(subscription: Subscription): string {
  const appleSub = (subscription as { _appleSubscription?: { state?: string } })._appleSubscription;
  return appleSub?.state || 'unknown';
}

// Format Apple status for display
function formatAppleStatus(status: string): { label: string; variant: 'default' | 'secondary' | 'outline' } {
  const statusMap: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
    'APPROVED': { label: 'Approved', variant: 'default' },
    'READY_TO_SUBMIT': { label: 'Ready', variant: 'secondary' },
    'WAITING_FOR_REVIEW': { label: 'In Review', variant: 'outline' },
    'DEVELOPER_ACTION_NEEDED': { label: 'Action Needed', variant: 'secondary' },
    'IN_REVIEW': { label: 'In Review', variant: 'outline' },
    'PENDING_BINARY_APPROVAL': { label: 'Pending', variant: 'outline' },
    'REJECTED': { label: 'Rejected', variant: 'secondary' },
    'DEVELOPER_REMOVED_FROM_SALE': { label: 'Removed', variant: 'secondary' },
    'REMOVED_FROM_SALE': { label: 'Removed', variant: 'secondary' },
  };
  return statusMap[status] || { label: status, variant: 'secondary' };
}

function BasePlanRow({ basePlan }: { basePlan: BasePlan }) {
  return (
    <div className="flex items-center justify-between py-2 px-4 bg-muted/30 rounded">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono text-xs">
          {basePlan.basePlanId}
        </Badge>
        <Badge
          variant={basePlan.state?.toLowerCase() === 'active' ? 'default' : 'secondary'}
          className="text-xs"
        >
          {basePlan.state}
        </Badge>
        {basePlan.autoRenewingBasePlanType && (
          <span className="text-xs text-muted-foreground">
            {formatBillingPeriod(basePlan.autoRenewingBasePlanType.billingPeriodDuration)}
          </span>
        )}
        {basePlan.prepaidBasePlanType && (
          <span className="text-xs text-muted-foreground">
            Prepaid · {formatBillingPeriod(basePlan.prepaidBasePlanType.billingPeriodDuration)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Globe className="h-3 w-3" />
        <span>{basePlan.regionalConfigs?.length || 0} regions</span>
      </div>
    </div>
  );
}

// Custom Collapsible using shadcn primitives
function CollapsibleWrapper({
  children,
  trigger,
}: {
  children: React.ReactNode;
  trigger: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>{trigger}</CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function SubscriptionsTable({
  subscriptions,
  isLoading,
  selectedIds,
  onSelectionChange,
  searchQuery,
}: SubscriptionsTableProps) {
  const platform = useAuthStore((state) => state.platform);
  const [sortField, setSortField] = useState<SortField>('productId');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const filteredSubscriptions = useMemo(() => {
    let filtered = subscriptions;

    // Apply status filter
    if (statusFilter === 'active') {
      filtered = filtered.filter((sub) => isSubscriptionActive(sub, platform));
    } else if (statusFilter === 'inactive') {
      filtered = filtered.filter((sub) => !isSubscriptionActive(sub, platform));
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (sub) =>
          sub.productId.toLowerCase().includes(query) ||
          getSubscriptionTitle(sub).toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [subscriptions, searchQuery, statusFilter, platform]);

  // Count subscriptions by status for filter badges
  const statusCounts = useMemo(() => {
    const active = subscriptions.filter((sub) => isSubscriptionActive(sub, platform)).length;
    const inactive = subscriptions.length - active;
    return { all: subscriptions.length, active, inactive };
  }, [subscriptions, platform]);

  const sortedSubscriptions = useMemo(() => {
    return [...filteredSubscriptions].sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'productId':
          comparison = a.productId.localeCompare(b.productId);
          break;
        case 'basePlans':
          if (platform === 'apple') {
            // For Apple, sort by period
            comparison = getApplePeriod(a).localeCompare(getApplePeriod(b));
          } else {
            comparison = (a.basePlans?.length || 0) - (b.basePlans?.length || 0);
          }
          break;
        case 'status':
          if (platform === 'apple') {
            comparison = getAppleStatus(a).localeCompare(getAppleStatus(b));
          } else {
            const activeA = getActiveBasePlansCount(a);
            const activeB = getActiveBasePlansCount(b);
            comparison = activeA - activeB;
          }
          break;
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });
  }, [filteredSubscriptions, sortField, sortOrder, platform]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const handleSelectAll = () => {
    if (selectedIds.length === sortedSubscriptions.length) {
      onSelectionChange([]);
    } else {
      onSelectionChange(sortedSubscriptions.map((s) => s.productId));
    }
  };

  const handleSelectOne = (productId: string) => {
    if (selectedIds.includes(productId)) {
      onSelectionChange(selectedIds.filter((id) => id !== productId));
    } else {
      onSelectionChange([...selectedIds, productId]);
    }
  };

  const toggleExpanded = (productId: string) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(productId)) {
      newExpanded.delete(productId);
    } else {
      newExpanded.add(productId);
    }
    setExpandedRows(newExpanded);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ChevronsUpDown className="ml-1 h-4 w-4" />;
    }
    return sortOrder === 'asc' ? (
      <ChevronUp className="ml-1 h-4 w-4" />
    ) : (
      <ChevronDown className="ml-1 h-4 w-4" />
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (sortedSubscriptions.length === 0 && statusFilter === 'all' && !searchQuery) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No subscriptions found</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Status Filter */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Filter:</span>
        <div className="flex gap-1">
          <Button
            variant={statusFilter === 'all' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatusFilter('all')}
          >
            All ({statusCounts.all})
          </Button>
          <Button
            variant={statusFilter === 'active' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatusFilter('active')}
          >
            Active ({statusCounts.active})
          </Button>
          <Button
            variant={statusFilter === 'inactive' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatusFilter('inactive')}
          >
            Inactive ({statusCounts.inactive})
          </Button>
        </div>
      </div>

      {sortedSubscriptions.length === 0 ? (
        <div className="text-center py-12 border rounded-md">
          <p className="text-muted-foreground">
            {searchQuery
              ? 'No subscriptions match your search'
              : `No ${statusFilter} subscriptions found`}
          </p>
        </div>
      ) : (
      <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <Checkbox
                checked={
                  selectedIds.length === sortedSubscriptions.length &&
                  sortedSubscriptions.length > 0
                }
                onCheckedChange={handleSelectAll}
                aria-label="Select all"
              />
            </TableHead>
            {platform === 'google' && <TableHead className="w-8"></TableHead>}
            <TableHead>
              <Button
                variant="ghost"
                className="h-auto p-0 font-semibold hover:bg-transparent"
                onClick={() => handleSort('productId')}
              >
                Product ID / Name
                <SortIcon field="productId" />
              </Button>
            </TableHead>
            {platform === 'google' ? (
              <>
                <TableHead>
                  <Button
                    variant="ghost"
                    className="h-auto p-0 font-semibold hover:bg-transparent"
                    onClick={() => handleSort('basePlans')}
                  >
                    Base Plans
                    <SortIcon field="basePlans" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    className="h-auto p-0 font-semibold hover:bg-transparent"
                    onClick={() => handleSort('status')}
                  >
                    Active Plans
                    <SortIcon field="status" />
                  </Button>
                </TableHead>
                <TableHead>Regions</TableHead>
                <TableHead>
                  {(() => {
                    // Get base price currency from first subscription
                    const basePrice = getBasePrice(subscriptions[0]);
                    return `Base Price${basePrice?.currencyCode ? ` (${basePrice.currencyCode})` : ''}`;
                  })()}
                </TableHead>
              </>
            ) : (
              <>
                <TableHead>Period</TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    className="h-auto p-0 font-semibold hover:bg-transparent"
                    onClick={() => handleSort('status')}
                  >
                    Status
                    <SortIcon field="status" />
                  </Button>
                </TableHead>
                <TableHead>
                  {(() => {
                    // Get base price currency from first subscription's basePlans regionalConfigs
                    const firstSubWithPrice = subscriptions.find(s =>
                      s.basePlans?.[0]?.regionalConfigs?.[0]?.price?.currencyCode
                    );
                    const currency = firstSubWithPrice?.basePlans?.[0]?.regionalConfigs?.[0]?.price?.currencyCode;
                    return `Base Price${currency ? ` (${currency})` : ''}`;
                  })()}
                </TableHead>
              </>
            )}
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedSubscriptions.map((subscription) => {
            const isExpanded = expandedRows.has(subscription.productId);

            return (
              <React.Fragment key={subscription.productId}>
                <TableRow
                  className={
                    selectedIds.includes(subscription.productId)
                      ? 'bg-muted/50'
                      : ''
                  }
                >
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.includes(subscription.productId)}
                      onCheckedChange={() =>
                        handleSelectOne(subscription.productId)
                      }
                      aria-label={`Select ${subscription.productId}`}
                    />
                  </TableCell>
                  {platform === 'google' && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => toggleExpanded(subscription.productId)}
                      >
                        <ChevronRight
                          className={`h-4 w-4 transition-transform ${
                            isExpanded ? 'rotate-90' : ''
                          }`}
                        />
                      </Button>
                    </TableCell>
                  )}
                  <TableCell>
                    <Link
                      href={`/dashboard/subscriptions/${encodeURIComponent(
                        subscription.productId
                      )}`}
                      className="hover:underline"
                    >
                      <div className="font-medium">
                        {getSubscriptionTitle(subscription)}
                      </div>
                      <div className="text-sm text-muted-foreground font-mono">
                        {subscription.productId}
                      </div>
                    </Link>
                  </TableCell>
                  {platform === 'google' ? (
                    <>
                      <TableCell>
                        {subscription.basePlans?.length || 0}
                      </TableCell>
                      <TableCell>
                        <Badge variant="default">
                          {getActiveBasePlansCount(subscription)} active
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Globe className="h-4 w-4 text-muted-foreground" />
                          <span>{getTotalRegions(subscription)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {getBasePrice(subscription) ? (
                          <span className="font-medium">
                            {formatMoney(getBasePrice(subscription)!)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell>
                        <span className="text-sm">
                          {formatApplePeriod(getApplePeriod(subscription))}
                        </span>
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const status = formatAppleStatus(getAppleStatus(subscription));
                          return <Badge variant={status.variant}>{status.label}</Badge>;
                        })()}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          // Try to get price from basePlans regionalConfigs (which we set up in the hook)
                          const regionalConfig = subscription.basePlans?.[0]?.regionalConfigs?.[0];
                          if (regionalConfig?.price) {
                            return (
                              <span className="font-medium">
                                {formatMoney(regionalConfig.price)}
                              </span>
                            );
                          }
                          return <span className="text-muted-foreground">—</span>;
                        })()}
                      </TableCell>
                    </>
                  )}
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link
                            href={`/dashboard/subscriptions/${encodeURIComponent(
                              subscription.productId
                            )}`}
                          >
                            <Edit className="mr-2 h-4 w-4" />
                            Edit Pricing
                          </Link>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
                {platform === 'google' && isExpanded && subscription.basePlans && (
                  <TableRow key={`${subscription.productId}-expanded`}>
                    <TableCell colSpan={8} className="bg-muted/20 p-4">
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-muted-foreground mb-2">
                          Base Plans
                        </p>
                        {subscription.basePlans.map((bp) => (
                          <BasePlanRow key={bp.basePlanId} basePlan={bp} />
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
      )}
    </div>
  );
}
