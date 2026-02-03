'use client';

import { useState, useMemo } from 'react';
import { Plus, Trash2, Save, X, Globe, AlertCircle, Calculator } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { Subscription, BasePlan, RegionalBasePlanConfig, Money } from '@/lib/google-play/types';
import {
  GOOGLE_PLAY_REGIONS,
  formatMoney,
  parseMoney,
  moneyToNumber,
} from '@/lib/google-play/types';
import {
  useUpdateBasePlanPrices,
  useDeleteBasePlanRegionPrice,
} from '@/hooks/use-subscriptions';
import { SubscriptionBulkPricingModal } from './bulk-pricing-modal';

// Convert ISO 8601 duration to human-readable format
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

interface BasePlanEditorProps {
  subscription: Subscription;
}

interface RegionPriceChange {
  regionCode: string;
  oldPrice: Money | null;
  newPrice: Money;
  isNew?: boolean;
}

interface BasePlanChanges {
  basePlanId: string;
  changes: Map<string, RegionPriceChange>;
}

function BasePlanPricingSection({
  subscription,
  basePlan,
  pendingChanges,
  onPriceChange,
  onAddRegion,
  onCancelChange,
  onDeleteRegion,
}: {
  subscription: Subscription;
  basePlan: BasePlan;
  pendingChanges: Map<string, RegionPriceChange>;
  onPriceChange: (regionCode: string, value: string) => void;
  onAddRegion: (regionCode: string) => void;
  onCancelChange: (regionCode: string) => void;
  onDeleteRegion: (regionCode: string) => void;
}) {
  const [addRegionOpen, setAddRegionOpen] = useState(false);
  const [bulkPricingOpen, setBulkPricingOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const deleteMutation = useDeleteBasePlanRegionPrice();

  const currentConfigs = useMemo(() => {
    const configs = new Map<string, RegionalBasePlanConfig>();

    basePlan.regionalConfigs?.forEach((config) => {
      configs.set(config.regionCode, config);
    });

    pendingChanges.forEach((change, regionCode) => {
      const existing = configs.get(regionCode);
      configs.set(regionCode, {
        regionCode,
        price: change.newPrice,
        newSubscriberAvailability: existing?.newSubscriberAvailability,
      });
    });

    return configs;
  }, [basePlan.regionalConfigs, pendingChanges]);

  const availableRegions = useMemo(() => {
    return GOOGLE_PLAY_REGIONS.filter((r) => !currentConfigs.has(r.code));
  }, [currentConfigs]);

  const sortedConfigs = useMemo(() => {
    return Array.from(currentConfigs.entries()).sort(([a], [b]) => {
      const regionA = GOOGLE_PLAY_REGIONS.find((r) => r.code === a);
      const regionB = GOOGLE_PLAY_REGIONS.find((r) => r.code === b);
      return (regionA?.name || a).localeCompare(regionB?.name || b);
    });
  }, [currentConfigs]);

  const handleDeleteConfirm = async (regionCode: string) => {
    try {
      await deleteMutation.mutateAsync({
        productId: subscription.productId,
        basePlanId: basePlan.basePlanId,
        regionCode,
      });
      toast.success(`Removed pricing for ${regionCode}`);
      setDeleteConfirm(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to delete region price'
      );
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Regional Pricing</span>
          <Badge variant="secondary" className="text-xs">
            {sortedConfigs.length} regions
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
            {sortedConfigs.map(([regionCode, config]) => {
              const region = GOOGLE_PLAY_REGIONS.find((r) => r.code === regionCode);
              const pendingChange = pendingChanges.get(regionCode);
              const displayPrice = pendingChange?.newPrice || config.price;

              return (
                <TableRow
                  key={regionCode}
                  className={pendingChange ? 'bg-amber-50 dark:bg-amber-950/20' : ''}
                >
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {regionCode}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {region?.name || regionCode}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        className="w-28 h-8"
                        value={moneyToNumber(displayPrice).toFixed(2)}
                        onChange={(e) => onPriceChange(regionCode, e.target.value)}
                      />
                      <span className="text-xs text-muted-foreground">
                        {displayPrice.currencyCode}
                      </span>
                      {pendingChange && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => onCancelChange(regionCode)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {!pendingChange?.isNew && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        onClick={() => setDeleteConfirm(regionCode)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                    {pendingChange?.isNew && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => onCancelChange(regionCode)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {sortedConfigs.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                  No regional pricing configured
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Add Region Dialog */}
      <Dialog open={addRegionOpen} onOpenChange={setAddRegionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Regional Pricing</DialogTitle>
            <DialogDescription>
              Select a region to add pricing for this base plan.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="region">Region</Label>
            <Select
              onValueChange={(value) => {
                onAddRegion(value);
                setAddRegionOpen(false);
              }}
            >
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="Select a region" />
              </SelectTrigger>
              <SelectContent>
                {availableRegions.map((region) => (
                  <SelectItem key={region.code} value={region.code}>
                    {region.name} ({region.code}) - {region.currency}
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
                ? GOOGLE_PLAY_REGIONS.find((r) => r.code === deleteConfirm)?.name ||
                  deleteConfirm
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
              onClick={() => deleteConfirm && handleDeleteConfirm(deleteConfirm)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Removing...' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Pricing Modal */}
      <SubscriptionBulkPricingModal
        subscription={subscription}
        basePlan={basePlan}
        open={bulkPricingOpen}
        onOpenChange={setBulkPricingOpen}
      />
    </div>
  );
}

export function BasePlanEditor({ subscription }: BasePlanEditorProps) {
  const [allChanges, setAllChanges] = useState<Map<string, BasePlanChanges>>(
    new Map()
  );

  const updateMutation = useUpdateBasePlanPrices();

  const handlePriceChange = (
    basePlanId: string,
    regionCode: string,
    value: string
  ) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue < 0) return;

    const region = GOOGLE_PLAY_REGIONS.find((r) => r.code === regionCode);
    if (!region) return;

    const basePlan = subscription.basePlans?.find(
      (bp) => bp.basePlanId === basePlanId
    );
    const existingConfig = basePlan?.regionalConfigs?.find(
      (rc) => rc.regionCode === regionCode
    );

    const oldPrice = existingConfig?.price || null;
    const newPrice = parseMoney(numValue, region.currency);

    setAllChanges((prev) => {
      const newChanges = new Map(prev);
      const planChanges = newChanges.get(basePlanId) || {
        basePlanId,
        changes: new Map(),
      };
      planChanges.changes.set(regionCode, {
        regionCode,
        oldPrice,
        newPrice,
        isNew: !oldPrice,
      });
      newChanges.set(basePlanId, planChanges);
      return newChanges;
    });
  };

  const handleAddRegion = (basePlanId: string, regionCode: string) => {
    const region = GOOGLE_PLAY_REGIONS.find((r) => r.code === regionCode);
    if (!region) return;

    setAllChanges((prev) => {
      const newChanges = new Map(prev);
      const planChanges = newChanges.get(basePlanId) || {
        basePlanId,
        changes: new Map(),
      };
      planChanges.changes.set(regionCode, {
        regionCode,
        oldPrice: null,
        newPrice: parseMoney(0, region.currency),
        isNew: true,
      });
      newChanges.set(basePlanId, planChanges);
      return newChanges;
    });
  };

  const handleCancelChange = (basePlanId: string, regionCode: string) => {
    setAllChanges((prev) => {
      const newChanges = new Map(prev);
      const planChanges = newChanges.get(basePlanId);
      if (planChanges) {
        planChanges.changes.delete(regionCode);
        if (planChanges.changes.size === 0) {
          newChanges.delete(basePlanId);
        }
      }
      return newChanges;
    });
  };

  const handleSaveChanges = async (basePlanId: string) => {
    const planChanges = allChanges.get(basePlanId);
    if (!planChanges || planChanges.changes.size === 0) return;

    const regionalConfigs: RegionalBasePlanConfig[] = [];
    planChanges.changes.forEach((change) => {
      regionalConfigs.push({
        regionCode: change.regionCode,
        price: change.newPrice,
      });
    });

    try {
      await updateMutation.mutateAsync({
        productId: subscription.productId,
        basePlanId,
        regionalConfigs,
      });
      toast.success('Prices updated successfully');

      setAllChanges((prev) => {
        const newChanges = new Map(prev);
        newChanges.delete(basePlanId);
        return newChanges;
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to update prices'
      );
    }
  };

  const handleDiscardChanges = (basePlanId: string) => {
    setAllChanges((prev) => {
      const newChanges = new Map(prev);
      newChanges.delete(basePlanId);
      return newChanges;
    });
  };

  const totalChanges = Array.from(allChanges.values()).reduce(
    (acc, pc) => acc + pc.changes.size,
    0
  );

  if (!subscription.basePlans || subscription.basePlans.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">
            No base plans configured for this subscription
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {totalChanges > 0 && (
        <Card className="border-amber-500 bg-amber-50 dark:bg-amber-950/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              {totalChanges} Pending Changes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Save changes individually for each base plan below.
            </p>
          </CardContent>
        </Card>
      )}

      <Accordion type="multiple" className="space-y-4" defaultValue={subscription.basePlans.map(bp => bp.basePlanId)}>
        {subscription.basePlans.map((basePlan) => {
          const planChanges = allChanges.get(basePlan.basePlanId);
          const hasChanges = planChanges && planChanges.changes.size > 0;

          return (
            <AccordionItem
              key={basePlan.basePlanId}
              value={basePlan.basePlanId}
              className="border rounded-lg px-4"
            >
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="font-mono">
                    {basePlan.basePlanId}
                  </Badge>
                  <Badge
                    variant={basePlan.state === 'active' ? 'default' : 'secondary'}
                  >
                    {basePlan.state}
                  </Badge>
                  {basePlan.autoRenewingBasePlanType && (
                    <span className="text-sm text-muted-foreground">
                      {formatBillingPeriod(basePlan.autoRenewingBasePlanType.billingPeriodDuration)}
                    </span>
                  )}
                  {basePlan.prepaidBasePlanType && (
                    <span className="text-sm text-muted-foreground">
                      Prepaid · {formatBillingPeriod(basePlan.prepaidBasePlanType.billingPeriodDuration)}
                    </span>
                  )}
                  {hasChanges && (
                    <Badge variant="outline" className="bg-amber-100 text-amber-800">
                      {planChanges.changes.size} changes
                    </Badge>
                  )}
                </div>
              </AccordionTrigger>
              <AccordionContent className="pt-4 pb-6">
                <BasePlanPricingSection
                  subscription={subscription}
                  basePlan={basePlan}
                  pendingChanges={planChanges?.changes || new Map()}
                  onPriceChange={(regionCode, value) =>
                    handlePriceChange(basePlan.basePlanId, regionCode, value)
                  }
                  onAddRegion={(regionCode) =>
                    handleAddRegion(basePlan.basePlanId, regionCode)
                  }
                  onCancelChange={(regionCode) =>
                    handleCancelChange(basePlan.basePlanId, regionCode)
                  }
                  onDeleteRegion={(regionCode) =>
                    handleCancelChange(basePlan.basePlanId, regionCode)
                  }
                />

                {hasChanges && (
                  <div className="flex gap-2 mt-4 pt-4 border-t">
                    <Button
                      onClick={() => handleSaveChanges(basePlan.basePlanId)}
                      disabled={updateMutation.isPending}
                    >
                      <Save className="mr-2 h-4 w-4" />
                      {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleDiscardChanges(basePlan.basePlanId)}
                    >
                      <X className="mr-2 h-4 w-4" />
                      Discard
                    </Button>
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}
