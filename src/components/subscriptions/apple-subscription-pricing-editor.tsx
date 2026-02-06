'use client';

import { useState, useMemo } from 'react';
import { Plus, Trash2, Globe, Calculator, X, Check, Loader2, CalendarX } from 'lucide-react';
import { toast } from 'sonner';
import { AppleSubscriptionBulkPricingModal } from './apple-subscription-bulk-pricing-modal';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  APPLE_TERRITORIES,
  getTerritoryByAlpha2,
  alpha2ToAlpha3,
} from '@/lib/apple-connect/territories';
import type { AppleProductPrice } from '@/lib/apple-connect/types';
import {
  useSubscriptionPricePoints,
  useUpdateAppleSubscriptionPrices,
  useClearScheduledPrices,
  type SubscriptionPricePoint,
} from '@/hooks/use-subscriptions';

// Convert Apple subscription period to human-readable format
function formatApplePeriod(period: string): string {
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

// Format Apple status for display
function formatAppleStatus(status: string): {
  label: string;
  variant: 'default' | 'secondary' | 'outline';
} {
  const statusMap: Record<
    string,
    { label: string; variant: 'default' | 'secondary' | 'outline' }
  > = {
    APPROVED: { label: 'APPROVED', variant: 'default' },
    READY_TO_SUBMIT: { label: 'READY', variant: 'secondary' },
    WAITING_FOR_REVIEW: { label: 'IN REVIEW', variant: 'outline' },
    DEVELOPER_ACTION_NEEDED: { label: 'ACTION NEEDED', variant: 'secondary' },
    IN_REVIEW: { label: 'IN REVIEW', variant: 'outline' },
    PENDING_BINARY_APPROVAL: { label: 'PENDING', variant: 'outline' },
    REJECTED: { label: 'REJECTED', variant: 'secondary' },
    DEVELOPER_REMOVED_FROM_SALE: { label: 'REMOVED', variant: 'secondary' },
    REMOVED_FROM_SALE: { label: 'REMOVED', variant: 'secondary' },
  };
  return statusMap[status] || { label: status, variant: 'secondary' };
}

// Format price with currency
function formatPrice(price: string, currency: string): string {
  const amount = parseFloat(price);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${price}`;
  }
}

// Get earliest allowed effective date (2 days from now) in YYYY-MM-DD format
function getEarliestEffectiveDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  return date.toISOString().split('T')[0];
}

// Format date for display
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Format date for compact display (without year if current year)
function formatDateShort(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

interface AppleSubscriptionData {
  id: string;
  productId: string;
  name: string;
  state: string;
  period: string;
  groupName?: string;
  prices: Record<string, AppleProductPrice>;
  scheduledPrices?: Record<string, AppleProductPrice>;
}

interface AppleSubscriptionPricingEditorProps {
  subscription: AppleSubscriptionData;
}

interface RegionPriceChange {
  territoryCode: string;
  oldPrice: AppleProductPrice | null;
  newPricePointId: string;
  newCustomerPrice: string;
  newCurrency: string;
  startDate?: string; // ISO 8601 date string for scheduled price changes
}

export function AppleSubscriptionPricingEditor({
  subscription,
}: AppleSubscriptionPricingEditorProps) {
  const [addRegionOpen, setAddRegionOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [editingTerritory, setEditingTerritory] = useState<string | null>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<string, RegionPriceChange>>(new Map());
  const [bulkPricingOpen, setBulkPricingOpen] = useState(false);
  const [clearScheduledConfirmOpen, setClearScheduledConfirmOpen] = useState(false);

  // For two-step price selection (approved subscriptions need a start date)
  const [selectedPricePoint, setSelectedPricePoint] = useState<SubscriptionPricePoint | null>(null);
  const [selectedStartDate, setSelectedStartDate] = useState<string>('');

  // Mutations
  const updateMutation = useUpdateAppleSubscriptionPrices();
  const clearScheduledMutation = useClearScheduledPrices();

  // Get territory info for the editing dialog
  const editingTerritoryInfo = editingTerritory
    ? getTerritoryByAlpha2(editingTerritory)
    : null;

  // Fetch price points for the territory being edited
  const { data: pricePointsData, isLoading: isLoadingPricePoints } =
    useSubscriptionPricePoints(
      subscription.id,
      editingTerritory || ''
    );

  // Get sorted list of current prices (including pending new additions)
  const sortedPrices = useMemo(() => {
    const pricesMap = new Map(Object.entries(subscription.prices || {}));

    // Add any pending new regions
    pendingChanges.forEach((change, territoryCode) => {
      if (!pricesMap.has(territoryCode)) {
        // This is a new region being added
        pricesMap.set(territoryCode, {
          territoryCode,
          currency: change.newCurrency,
          customerPrice: change.newCustomerPrice,
          proceeds: '',
          pricePointId: change.newPricePointId,
        });
      }
    });

    return Array.from(pricesMap.entries()).sort(([a], [b]) => {
      const territoryA = getTerritoryByAlpha2(a);
      const territoryB = getTerritoryByAlpha2(b);
      return (territoryA?.name || a).localeCompare(territoryB?.name || b);
    });
  }, [subscription.prices, pendingChanges]);

  // Get available regions (not already in prices and not in pending changes)
  const availableRegions = useMemo(() => {
    const existingCodes = new Set(Object.keys(subscription.prices || {}));
    pendingChanges.forEach((_, code) => existingCodes.add(code));
    return APPLE_TERRITORIES.filter((t) => !existingCodes.has(t.alpha2)).sort(
      (a, b) => a.name.localeCompare(b.name)
    );
  }, [subscription.prices, pendingChanges]);

  const status = formatAppleStatus(subscription.state);
  const hasChanges = pendingChanges.size > 0;
  const hasScheduledPrices = Object.keys(subscription.scheduledPrices || {}).length > 0;
  const scheduledPricesCount = Object.keys(subscription.scheduledPrices || {}).length;

  // Open price selector for a territory
  const handleEditPrice = (territoryCode: string) => {
    setEditingTerritory(territoryCode);
  };

  // Check if this subscription requires a start date for price changes
  const isApproved = subscription.state === 'APPROVED';

  // Handle price point selection
  const handleSelectPricePoint = (pricePoint: SubscriptionPricePoint) => {
    if (!editingTerritory) return;

    // For approved subscriptions, we need to show the date picker
    if (isApproved) {
      setSelectedPricePoint(pricePoint);
      setSelectedStartDate(getEarliestEffectiveDate());
      return;
    }

    // For non-approved subscriptions, apply immediately
    applyPriceChange(pricePoint);
  };

  // Apply the price change (called directly or after date selection)
  const applyPriceChange = (pricePoint: SubscriptionPricePoint, startDate?: string) => {
    if (!editingTerritory) return;

    const existingPrice = subscription.prices[editingTerritory];
    const territory = getTerritoryByAlpha2(editingTerritory);

    setPendingChanges((prev) => {
      const newChanges = new Map(prev);
      newChanges.set(editingTerritory, {
        territoryCode: editingTerritory,
        oldPrice: existingPrice || null,
        newPricePointId: pricePoint.id,
        newCustomerPrice: pricePoint.customerPrice,
        newCurrency: territory?.currency || 'USD',
        startDate,
      });
      return newChanges;
    });

    // Reset state
    setEditingTerritory(null);
    setSelectedPricePoint(null);
    setSelectedStartDate('');
  };

  // Confirm price selection with start date (for approved subscriptions)
  const handleConfirmPriceWithDate = () => {
    if (!selectedPricePoint || !selectedStartDate) return;
    applyPriceChange(selectedPricePoint, selectedStartDate);
  };

  // Cancel the date selection step
  const handleCancelDateSelection = () => {
    setSelectedPricePoint(null);
    setSelectedStartDate('');
  };

  // Cancel a pending change
  const handleCancelChange = (territoryCode: string) => {
    setPendingChanges((prev) => {
      const newChanges = new Map(prev);
      newChanges.delete(territoryCode);
      return newChanges;
    });
  };

  // Save all changes
  const handleSaveChanges = async () => {
    const prices: Record<string, { pricePointId: string; startDate?: string }> = {};

    pendingChanges.forEach((change, territoryCode) => {
      prices[territoryCode] = {
        pricePointId: change.newPricePointId,
        startDate: change.startDate,
      };
    });

    try {
      await updateMutation.mutateAsync({
        subscriptionId: subscription.id,
        prices,
      });
      toast.success('Prices updated successfully');
      setPendingChanges(new Map());
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to update prices'
      );
    }
  };

  // Discard all changes
  const handleDiscardChanges = () => {
    setPendingChanges(new Map());
  };

  // Clear all scheduled prices
  const handleClearScheduledPrices = async () => {
    try {
      const result = await clearScheduledMutation.mutateAsync({
        subscriptionId: subscription.id,
      }) as { message?: string };
      toast.success(result?.message || 'Scheduled prices cleared');
      setClearScheduledConfirmOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to clear scheduled prices'
      );
    }
  };

  // Add a new region (opens the price selector)
  const handleAddRegion = (regionCode: string) => {
    setAddRegionOpen(false);
    setEditingTerritory(regionCode);
  };

  // Delete a region price
  const handleDeleteRegion = async (regionCode: string) => {
    const price = subscription.prices[regionCode];
    if (!price?.pricePointId) {
      // If it's a pending addition, just remove it from pending
      handleCancelChange(regionCode);
      setDeleteConfirm(null);
      return;
    }

    try {
      // For Apple, we need to get the subscription price ID
      // The pricePointId is not the same as subscriptionPriceId
      // We need to look this up - for now show a message
      toast.info('Delete region functionality requires the subscription price ID');
      setDeleteConfirm(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to delete price'
      );
    }
  };

  // Get display price for a territory (considering pending changes)
  const getDisplayPrice = (territoryCode: string, originalPrice: AppleProductPrice) => {
    const pendingChange = pendingChanges.get(territoryCode);
    if (pendingChange) {
      return {
        price: pendingChange.newCustomerPrice,
        currency: pendingChange.newCurrency,
        isChanged: true,
      };
    }
    return {
      price: originalPrice.customerPrice,
      currency: originalPrice.currency,
      isChanged: false,
    };
  };

  return (
    <div className="space-y-6">
      {/* Pending Changes Banner */}
      {hasChanges && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                {pendingChanges.size} pending change{pendingChanges.size !== 1 ? 's' : ''}
              </Badge>
              <span className="text-sm text-amber-800 dark:text-amber-200">
                {Array.from(pendingChanges.values()).some(c => c.startDate)
                  ? 'Save to schedule price changes in App Store Connect'
                  : 'Save to apply changes to App Store Connect'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDiscardChanges}
                disabled={updateMutation.isPending}
              >
                <X className="mr-1 h-3 w-3" />
                Discard
              </Button>
              <Button
                size="sm"
                onClick={handleSaveChanges}
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    {updateMutation.progress
                      ? `${updateMutation.progress.phase === 'delete' ? 'Clearing' : 'Saving'} ${updateMutation.progress.completed} of ${updateMutation.progress.total}...`
                      : 'Saving...'}
                  </>
                ) : (
                  <>
                    <Check className="mr-1 h-3 w-3" />
                    Save Changes
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Accordion type="multiple" className="space-y-4" defaultValue={['subscription-plan']}>
        <AccordionItem
          value="subscription-plan"
          className="border rounded-lg px-4"
        >
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <Badge variant="outline" className="font-mono">
                {subscription.productId}
              </Badge>
              <Badge variant={status.variant}>{status.label}</Badge>
              <span className="text-sm text-muted-foreground">
                {formatApplePeriod(subscription.period)}
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="pt-4 pb-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Regional Pricing</span>
                  <Badge variant="secondary" className="text-xs">
                    {sortedPrices.length} regions
                  </Badge>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setBulkPricingOpen(true)}
                  >
                    <Calculator className="mr-1 h-3 w-3" />
                    Bulk Edit Prices
                  </Button>
                  {hasScheduledPrices && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setClearScheduledConfirmOpen(true)}
                      disabled={clearScheduledMutation.isPending}
                    >
                      {clearScheduledMutation.isPending ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <CalendarX className="mr-1 h-3 w-3" />
                      )}
                      Clear Scheduled
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAddRegionOpen(true)}
                    disabled={availableRegions.length === 0}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Add Region
                  </Button>
                </div>
              </div>

              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">Region</TableHead>
                      <TableHead>Country</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead className="w-16">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedPrices.map(([regionCode, price]) => {
                      const territory = getTerritoryByAlpha2(regionCode);
                      const displayData = getDisplayPrice(regionCode, price);
                      const isNewRegion = !subscription.prices[regionCode];
                      const scheduledPrice = subscription.scheduledPrices?.[regionCode];

                      return (
                        <TableRow
                          key={regionCode}
                          className={
                            displayData.isChanged
                              ? 'bg-amber-50/50 dark:bg-amber-950/20'
                              : ''
                          }
                        >
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {alpha2ToAlpha3(regionCode) || regionCode}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">
                            <div className="flex items-center gap-2">
                              {territory?.name || regionCode}
                              {isNewRegion && (
                                <Badge variant="secondary" className="text-xs">
                                  NEW
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <button
                              type="button"
                              onClick={() => handleEditPrice(regionCode)}
                              className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors text-left min-w-[100px]"
                            >
                              <div className="flex flex-col">
                                <span className="font-medium">
                                  {formatPrice(displayData.price, displayData.currency)}
                                </span>
                                {/* Show pending change effective date */}
                                {displayData.isChanged && pendingChanges.get(regionCode)?.startDate && (
                                  <span className="text-xs text-muted-foreground">
                                    Effective {formatDate(pendingChanges.get(regionCode)!.startDate!)}
                                  </span>
                                )}
                                {/* Show existing scheduled price from Apple (only if no pending change) */}
                                {!displayData.isChanged && scheduledPrice && scheduledPrice.startDate && (
                                  <span className="text-xs text-muted-foreground">
                                    → {formatPrice(scheduledPrice.customerPrice, scheduledPrice.currency)} on {formatDateShort(scheduledPrice.startDate)}
                                  </span>
                                )}
                              </div>
                              {displayData.isChanged && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCancelChange(regionCode);
                                  }}
                                  className="ml-auto text-muted-foreground hover:text-destructive"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              )}
                            </button>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-destructive hover:text-destructive"
                              onClick={() => setDeleteConfirm(regionCode)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {sortedPrices.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="text-center text-muted-foreground py-6"
                        >
                          No regional pricing configured
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {/* Price Selector Dialog */}
      <Dialog
        open={!!editingTerritory}
        onOpenChange={(open) => {
          if (!open) {
            setEditingTerritory(null);
            setSelectedPricePoint(null);
            setSelectedStartDate('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {selectedPricePoint
                ? 'Schedule Price Change'
                : `Select Price for ${editingTerritoryInfo?.name || editingTerritory}`}
            </DialogTitle>
            <DialogDescription>
              {selectedPricePoint
                ? 'Approved subscriptions require a future effective date for price changes.'
                : 'Choose a price tier from the available options. Prices are set by Apple.'}
            </DialogDescription>
          </DialogHeader>

          {/* Date selection step for approved subscriptions */}
          {selectedPricePoint ? (
            <div className="py-4 space-y-4">
              <div className="p-3 rounded-md bg-muted">
                <div className="text-sm text-muted-foreground">New price</div>
                <div className="font-medium text-lg">
                  {formatPrice(
                    selectedPricePoint.customerPrice,
                    editingTerritoryInfo?.currency || 'USD'
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="start-date">Effective Date</Label>
                <input
                  id="start-date"
                  type="date"
                  value={selectedStartDate}
                  min={getEarliestEffectiveDate()}
                  onChange={(e) => setSelectedStartDate(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <p className="text-xs text-muted-foreground">
                  The price change will take effect on this date.
                </p>
              </div>

              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" onClick={handleCancelDateSelection}>
                  Back
                </Button>
                <Button
                  onClick={handleConfirmPriceWithDate}
                  disabled={!selectedStartDate}
                >
                  Confirm
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="py-2">
              {isLoadingPricePoints ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : pricePointsData?.pricePoints && pricePointsData.pricePoints.length > 0 ? (
                <ScrollArea className="h-80">
                  <div className="space-y-1 pr-4">
                    {pricePointsData.pricePoints.map((pp) => {
                      const currentPrice = editingTerritory
                        ? subscription.prices[editingTerritory]
                        : null;
                      const pendingChange = editingTerritory
                        ? pendingChanges.get(editingTerritory)
                        : null;
                      const isCurrentPrice = currentPrice?.pricePointId === pp.id;
                      const isPendingPrice = pendingChange?.newPricePointId === pp.id;

                      return (
                        <button
                          key={pp.id}
                          type="button"
                          onClick={() => handleSelectPricePoint(pp)}
                          className={`w-full p-3 rounded-md text-left transition-colors ${
                            isCurrentPrice || isPendingPrice
                              ? 'bg-primary/10 border border-primary'
                              : 'hover:bg-muted border border-transparent'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium">
                              {formatPrice(
                                pp.customerPrice,
                                editingTerritoryInfo?.currency || 'USD'
                              )}
                            </span>
                            <span className="text-sm text-muted-foreground">
                              proceeds: {formatPrice(
                                pp.proceeds,
                                editingTerritoryInfo?.currency || 'USD'
                              )}
                            </span>
                          </div>
                          {(isCurrentPrice || isPendingPrice) && (
                            <span className="text-xs text-primary mt-1 block">
                              {isPendingPrice ? 'Selected (pending)' : 'Current price'}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              ) : (
                <div className="text-center text-muted-foreground py-8">
                  No price tiers available for this territory
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Region Dialog */}
      <Dialog open={addRegionOpen} onOpenChange={setAddRegionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Regional Pricing</DialogTitle>
            <DialogDescription>
              Select a region to add pricing for this subscription.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="region">Region</Label>
            <Select onValueChange={handleAddRegion}>
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="Select a region" />
              </SelectTrigger>
              <SelectContent>
                {availableRegions.map((territory) => (
                  <SelectItem key={territory.alpha2} value={territory.alpha2}>
                    {territory.name} ({territory.alpha2}) - {territory.currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Regional Pricing</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove pricing for{' '}
              {deleteConfirm
                ? getTerritoryByAlpha2(deleteConfirm)?.name || deleteConfirm
                : ''}
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && handleDeleteRegion(deleteConfirm)}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Pricing Modal */}
      <AppleSubscriptionBulkPricingModal
        subscription={subscription}
        open={bulkPricingOpen}
        onOpenChange={setBulkPricingOpen}
      />

      {/* Clear Scheduled Prices Confirmation Dialog */}
      <Dialog open={clearScheduledConfirmOpen} onOpenChange={setClearScheduledConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear Scheduled Price Changes</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove all {scheduledPricesCount} scheduled price{' '}
              {scheduledPricesCount !== 1 ? 'changes' : 'change'}? This will cancel any
              future price updates that have been scheduled in App Store Connect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setClearScheduledConfirmOpen(false)}
              disabled={clearScheduledMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleClearScheduledPrices}
              disabled={clearScheduledMutation.isPending}
            >
              {clearScheduledMutation.isPending ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  {clearScheduledMutation.progress
                    ? `Clearing ${clearScheduledMutation.progress.completed} of ${clearScheduledMutation.progress.total}...`
                    : 'Clearing...'}
                </>
              ) : (
                'Clear All'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
