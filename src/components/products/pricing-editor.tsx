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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { Money, InAppProduct } from '@/lib/google-play/types';
import type { AppleProductPrice } from '@/lib/apple-connect/types';
import {
  GOOGLE_PLAY_REGIONS,
  formatMoney,
  parseMoney,
  moneyToNumber,
} from '@/lib/google-play/types';
import { getSupportedAppleTerritories, getTerritoryByAlpha3 } from '@/lib/apple-connect/territories';
import { useAuthStore } from '@/store/auth-store';
import { useUpdateProductPrices, useDeleteRegionPrice } from '@/hooks/use-products';
import { BulkPricingModal } from './bulk-pricing-modal';

interface PricingEditorProps {
  product: InAppProduct;
}

interface PriceChange {
  regionCode: string;
  oldPrice: Money | null;
  newPrice: Money;
  isNew?: boolean;
}

// Helper to get region info for both platforms
function getRegionInfo(code: string, platform: 'google' | 'apple' | null) {
  if (platform === 'apple') {
    const territory = getTerritoryByAlpha3(code);
    return territory ? { code: territory.alpha3, name: territory.name, currency: territory.currency } : null;
  }
  const region = GOOGLE_PLAY_REGIONS.find((r) => r.code === code);
  return region ? { code: region.code, name: region.name, currency: region.currency } : null;
}

// Helper to convert Apple price to Money format
function appleToMoney(applePrice: { customerPrice: string; currency: string }): Money {
  return {
    currencyCode: applePrice.currency,
    units: applePrice.customerPrice,
  };
}

export function PricingEditor({ product }: PricingEditorProps) {
  const platform = useAuthStore((state) => state.platform);
  const [pendingChanges, setPendingChanges] = useState<Map<string, PriceChange>>(
    new Map()
  );
  const [addRegionOpen, setAddRegionOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [bulkPricingOpen, setBulkPricingOpen] = useState(false);

  const updateMutation = useUpdateProductPrices();
  const deleteMutation = useDeleteRegionPrice();

  // Normalize prices to Money format (handles both Google and Apple)
  const normalizedPrices = useMemo(() => {
    const prices: Record<string, Money> = {};

    if (product.prices) {
      Object.entries(product.prices).forEach(([code, price]) => {
        if (platform === 'apple') {
          // Apple prices have customerPrice and currency (runtime type differs from InAppProduct.prices)
          const applePrice = price as unknown as AppleProductPrice;
          if (applePrice.customerPrice) {
            prices[code] = appleToMoney(applePrice);
          }
        } else {
          // Google prices are already Money format
          prices[code] = price as Money;
        }
      });
    }

    return prices;
  }, [product.prices, platform]);

  const currentPrices = useMemo(() => {
    const prices: Record<string, Money> = { ...normalizedPrices };

    pendingChanges.forEach((change, regionCode) => {
      prices[regionCode] = change.newPrice;
    });

    return prices;
  }, [normalizedPrices, pendingChanges]);

  const availableRegions = useMemo(() => {
    const usedRegions = new Set(Object.keys(currentPrices));
    if (platform === 'apple') {
      return getSupportedAppleTerritories()
        .filter((t) => !usedRegions.has(t.alpha3))
        .map((t) => ({ code: t.alpha3, name: t.name, currency: t.currency }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return GOOGLE_PLAY_REGIONS
      .filter((r) => !usedRegions.has(r.code))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [currentPrices, platform]);

  const handlePriceChange = (regionCode: string, value: string) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue < 0) return;

    const region = getRegionInfo(regionCode, platform);
    if (!region) return;

    const oldPrice = normalizedPrices[regionCode] || null;
    const newPrice = parseMoney(numValue, region.currency);

    const changes = new Map(pendingChanges);
    changes.set(regionCode, {
      regionCode,
      oldPrice,
      newPrice,
      isNew: !oldPrice,
    });
    setPendingChanges(changes);
  };

  const handleAddRegion = (regionCode: string) => {
    const region = getRegionInfo(regionCode, platform);
    if (!region) return;

    const changes = new Map(pendingChanges);
    changes.set(regionCode, {
      regionCode,
      oldPrice: null,
      newPrice: parseMoney(0, region.currency),
      isNew: true,
    });
    setPendingChanges(changes);
    setAddRegionOpen(false);
  };

  const handleCancelChange = (regionCode: string) => {
    const changes = new Map(pendingChanges);
    changes.delete(regionCode);
    setPendingChanges(changes);
  };

  const handleDeleteRegion = async (regionCode: string) => {
    try {
      await deleteMutation.mutateAsync({
        sku: product.sku,
        regionCode,
      });
      toast.success(`Removed pricing for ${regionCode}`);
      setDeleteConfirm(null);

      // Also remove from pending changes if exists
      const changes = new Map(pendingChanges);
      changes.delete(regionCode);
      setPendingChanges(changes);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete region price');
    }
  };

  const handleSaveChanges = async () => {
    if (pendingChanges.size === 0) return;

    const prices: Record<string, Money> = {};
    pendingChanges.forEach((change, regionCode) => {
      prices[regionCode] = change.newPrice;
    });

    try {
      await updateMutation.mutateAsync({
        sku: product.sku,
        prices,
      });
      toast.success('Prices updated successfully');
      setPendingChanges(new Map());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update prices');
    }
  };

  const sortedRegions = useMemo(() => {
    return Object.entries(currentPrices).sort(([a], [b]) => {
      const regionA = getRegionInfo(a, platform);
      const regionB = getRegionInfo(b, platform);
      return (regionA?.name || a).localeCompare(regionB?.name || b);
    });
  }, [currentPrices, platform]);

  return (
    <div className="space-y-6">
      {pendingChanges.size > 0 && (
        <Card className="border-amber-500 bg-amber-50 dark:bg-amber-950/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              Pending Changes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 mb-4">
              {Array.from(pendingChanges.values()).map((change) => {
                const region = getRegionInfo(change.regionCode, platform);
                return (
                  <div
                    key={change.regionCode}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>
                      <Badge variant="outline" className="mr-2">
                        {change.regionCode}
                      </Badge>
                      {region?.name}
                    </span>
                    <span>
                      {change.oldPrice ? (
                        <>
                          <span className="text-muted-foreground line-through mr-2">
                            {formatMoney(change.oldPrice)}
                          </span>
                          <span className="text-green-600">
                            {formatMoney(change.newPrice)}
                          </span>
                        </>
                      ) : (
                        <span className="text-green-600">
                          + {formatMoney(change.newPrice)}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <Button
                onClick={handleSaveChanges}
                disabled={updateMutation.isPending}
              >
                <Save className="mr-2 h-4 w-4" />
                {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setPendingChanges(new Map())}
              >
                <X className="mr-2 h-4 w-4" />
                Discard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-muted-foreground" />
          <span className="font-medium">Regional Pricing</span>
          <Badge variant="secondary">{sortedRegions.length} regions</Badge>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setBulkPricingOpen(true)}
          >
            <Calculator className="mr-2 h-4 w-4" />
            Bulk Edit Prices
          </Button>
          <Button
            variant="outline"
            onClick={() => setAddRegionOpen(true)}
            disabled={availableRegions.length === 0}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Region
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">Region</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead>Price</TableHead>
              <TableHead className="w-24">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRegions.map(([regionCode, price]) => {
              const region = getRegionInfo(regionCode, platform);
              const pendingChange = pendingChanges.get(regionCode);
              const displayPrice = pendingChange?.newPrice || price;

              return (
                <TableRow
                  key={regionCode}
                  className={pendingChange ? 'bg-amber-50 dark:bg-amber-950/20' : ''}
                >
                  <TableCell>
                    <Badge variant="outline">{regionCode}</Badge>
                  </TableCell>
                  <TableCell>{region?.name || regionCode}</TableCell>
                  <TableCell>{price.currencyCode || region?.currency}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        className="w-32"
                        value={moneyToNumber(displayPrice).toFixed(2)}
                        onChange={(e) =>
                          handlePriceChange(regionCode, e.target.value)
                        }
                      />
                      {pendingChange && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleCancelChange(regionCode)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {!pendingChange?.isNew && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteConfirm(regionCode)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                    {pendingChange?.isNew && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleCancelChange(regionCode)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {sortedRegions.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground py-8"
                >
                  No regional pricing configured. Click &quot;Add Region&quot; to start.
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
              Select a region to add custom pricing for this product.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="region">Region</Label>
            <Select onValueChange={handleAddRegion}>
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
                ? getRegionInfo(deleteConfirm, platform)?.name || deleteConfirm
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
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Removing...' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Pricing Modal */}
      <BulkPricingModal
        product={product}
        open={bulkPricingOpen}
        onOpenChange={setBulkPricingOpen}
      />
    </div>
  );
}
