'use client';

import { useState, useMemo, useEffect } from 'react';
import { Calculator, Globe, TrendingDown, Sliders, RefreshCw, Beef } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Money, InAppProduct } from '@/lib/google-play/types';
import type { AppleProductPrice } from '@/lib/apple-connect/types';
import {
  GOOGLE_PLAY_REGIONS,
  formatMoney,
  moneyToNumber,
} from '@/lib/google-play/types';
import { getSupportedAppleTerritories, getTerritoryByAlpha3 } from '@/lib/apple-connect/territories';
import { useAuthStore } from '@/store/auth-store';
import {
  calculateBulkPrices,
  calculatePriceChange,
  formatPriceChange,
  type PricingStrategy,
  type RoundingMode,
  type DynamicPPPData,
  type DynamicExchangeRates,
} from '@/lib/google-play/currency';
import { useUpdateProductPrices } from '@/hooks/use-products';

// Helper to get the currency symbol for a currency code (e.g. "GBP" → "£")
function getCurrencySymbol(currencyCode: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode })
      .formatToParts(0)
      .find(part => part.type === 'currency')?.value || currencyCode;
  } catch {
    return currencyCode;
  }
}

// Helper to convert Apple price to Money format
function appleToMoney(applePrice: { customerPrice: string; currency: string }): Money {
  return {
    currencyCode: applePrice.currency,
    units: applePrice.customerPrice,
  };
}

interface PPPApiResponse {
  success: boolean;
  data: DynamicPPPData;
  metadata: {
    baseYear: number | null;
    fetchedAt: string;
    worldBankRegions: number;
    totalRegions: number;
    fallback?: boolean;
    error?: string;
  };
}

interface ExchangeRatesApiResponse {
  success: boolean;
  noApiKey?: boolean;
  error?: string;
  data: {
    base: string;
    rates: Record<string, number>;
    timestamp: number;
    fetchedAt: string;
  };
  metadata: {
    currencyCount: number;
    cacheAge: number;
  };
}

interface BulkPricingModalProps {
  product: InAppProduct;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BulkPricingModal({
  product,
  open,
  onOpenChange,
}: BulkPricingModalProps) {
  const platform = useAuthStore((state) => state.platform);
  const [basePrice, setBasePrice] = useState<string>('');
  const [strategy, setStrategy] = useState<PricingStrategy>('ppp');
  const [rounding, setRounding] = useState<RoundingMode>('charm');
  const [applyToAllRegions, setApplyToAllRegions] = useState(true);
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(
    new Set(Object.keys(product.prices || {}))
  );

  // PPP data from World Bank API
  const [pppData, setPppData] = useState<DynamicPPPData | null>(null);
  const [pppMetadata, setPppMetadata] = useState<PPPApiResponse['metadata'] | null>(null);
  const [pppLoading, setPppLoading] = useState(false);
  const [pppFetched, setPppFetched] = useState(false);

  // Exchange rates from Open Exchange Rates API
  const [exchangeRates, setExchangeRates] = useState<DynamicExchangeRates | null>(null);
  const [exchangeRatesLoading, setExchangeRatesLoading] = useState(false);
  const [exchangeRatesFetched, setExchangeRatesFetched] = useState(false);

  const updateMutation = useUpdateProductPrices();

  const basePriceNum = parseFloat(basePrice) || 0;

  // Normalize prices to Money format (handles both Google and Apple)
  // Must be calculated before allRegions so we can include territories with existing pricing
  const normalizedPrices = useMemo(() => {
    const prices: Record<string, Money> = {};
    if (product.prices) {
      Object.entries(product.prices).forEach(([code, price]) => {
        if (platform === 'apple') {
          // Apple prices have customerPrice and currency fields
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

  // Get the appropriate regions list based on platform
  // For Apple, include both supported territories AND territories with existing pricing
  const allRegions = useMemo(() => {
    if (platform === 'apple') {
      const supportedTerritories = getSupportedAppleTerritories();
      const supportedCodes = new Set(supportedTerritories.map(t => t.alpha3));

      // Start with supported territories, using actual currency from prices when available
      const regions = supportedTerritories.map((t) => ({
        code: t.alpha3,
        name: t.name,
        currency: normalizedPrices[t.alpha3]?.currencyCode || t.currency,
      }));

      // Add territories that have existing pricing but aren't in our supported list
      for (const [code, price] of Object.entries(normalizedPrices)) {
        if (!supportedCodes.has(code)) {
          const territory = getTerritoryByAlpha3(code);
          regions.push({
            code,
            name: territory?.name || code,
            currency: price.currencyCode,
          });
        }
      }

      // Sort by country name for consistent display
      return regions.sort((a, b) => a.name.localeCompare(b.name));
    }
    // Sort Google Play regions by country name too
    return [...GOOGLE_PLAY_REGIONS].sort((a, b) => a.name.localeCompare(b.name));
  }, [platform, normalizedPrices]);

  // Fetch PPP data and exchange rates when modal opens
  // Only depend on `open` to prevent infinite retry loops on fetch failure
  useEffect(() => {
    if (open && !pppFetched && !pppLoading) {
      fetchPPPData();
    }
    if (open && !exchangeRatesFetched && !exchangeRatesLoading) {
      fetchExchangeRates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fetchPPPData = async (forceRefresh = false) => {
    setPppLoading(true);
    try {
      const url = forceRefresh ? '/api/ppp?refresh=true' : '/api/ppp';
      const response = await fetch(url);
      const data: PPPApiResponse = await response.json();

      if (data.success) {
        setPppData(data.data);
        setPppMetadata(data.metadata);
      }
    } catch (error) {
      console.error('Failed to fetch PPP data:', error);
      toast.error('Failed to fetch PPP data, using static values');
    } finally {
      setPppLoading(false);
      setPppFetched(true);
    }
  };

  const fetchExchangeRates = async (forceRefresh = false) => {
    setExchangeRatesLoading(true);
    try {
      const url = forceRefresh ? '/api/exchange-rates?refresh=true' : '/api/exchange-rates';
      const response = await fetch(url);
      const data: ExchangeRatesApiResponse = await response.json();

      if (data.success) {
        setExchangeRates({
          base: data.data.base,
          rates: data.data.rates,
          fetchedAt: data.data.fetchedAt,
        });
      } else if (data.noApiKey) {
        toast.info('Add an Open Exchange Rates API key in Settings for live exchange rates.');
      }
    } catch (error) {
      console.error('Failed to fetch exchange rates:', error);
      // Don't show error toast - we'll fall back to static rates
    } finally {
      setExchangeRatesLoading(false);
      setExchangeRatesFetched(true);
    }
  };

  // Get regions to apply pricing to
  const targetRegions = useMemo(() => {
    if (applyToAllRegions) {
      return allRegions.map((r) => r.code);
    }
    return Array.from(selectedRegions);
  }, [applyToAllRegions, selectedRegions, allRegions]);

  // Extract actual currencies from API (product.prices)
  // This ensures we use the correct currency that the platform expects for each region
  const actualCurrencies = useMemo(() => {
    const currencies: Record<string, string> = {};
    if (normalizedPrices) {
      for (const [regionCode, money] of Object.entries(normalizedPrices)) {
        if (money.currencyCode) {
          currencies[regionCode] = money.currencyCode;
        }
      }
    }
    return currencies;
  }, [normalizedPrices]);

  // Calculate preview prices
  const previewPrices = useMemo(() => {
    if (basePriceNum <= 0) return [];
    return calculateBulkPrices(
      basePriceNum,
      targetRegions,
      strategy,
      rounding,
      undefined, // customMultipliers
      pppData ?? undefined, // dynamicPPPData
      actualCurrencies, // Use actual currencies from Google Play
      exchangeRates ?? undefined // Dynamic exchange rates from API
    );
  }, [basePriceNum, targetRegions, strategy, rounding, pppData, actualCurrencies, exchangeRates]);

  // Get current price for a region
  const getCurrentPrice = (regionCode: string): Money | null => {
    return normalizedPrices[regionCode] || null;
  };

  // Handle region selection
  const toggleRegion = (regionCode: string) => {
    const newSelected = new Set(selectedRegions);
    if (newSelected.has(regionCode)) {
      newSelected.delete(regionCode);
    } else {
      newSelected.add(regionCode);
    }
    setSelectedRegions(newSelected);
  };

  // Select/deselect all regions
  const toggleAllRegions = () => {
    if (selectedRegions.size === allRegions.length) {
      setSelectedRegions(new Set());
    } else {
      setSelectedRegions(new Set(allRegions.map((r) => r.code)));
    }
  };

  // Apply bulk pricing
  const handleApply = async () => {
    if (previewPrices.length === 0) {
      toast.error('Please enter a valid base price');
      return;
    }

    const prices: Record<string, Money> = {};
    previewPrices.forEach((calculated) => {
      prices[calculated.regionCode] = calculated.price;
    });

    try {
      const result = await updateMutation.mutateAsync({
        sku: product.sku,
        prices,
      });

      // Check for skipped territories (partial update)
      const skipped = result?.skipped as string[] | undefined;
      const updated = result?.updated as number | undefined;

      if (skipped && skipped.length > 0) {
        toast.warning(
          `${skipped.length} territories could not be updated`,
          {
            description: skipped.length <= 3
              ? skipped.join(', ')
              : `${skipped.slice(0, 3).join(', ')} and ${skipped.length - 3} more`,
            duration: 5000,
          }
        );
      }

      const successCount = updated ?? previewPrices.length;
      toast.success(`Updated prices for ${successCount} regions`);
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to update prices'
      );
    }
  };

  // Reset form when modal opens
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      setBasePrice('');
      setStrategy('ppp');
      setRounding('charm');
      setApplyToAllRegions(true);
      setSelectedRegions(new Set(Object.keys(product.prices || {})));
      // PPP data will be fetched by the useEffect
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-6xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5" />
            Bulk Edit Regional Prices
          </DialogTitle>
          <DialogDescription>
            Set a base price and automatically calculate regional prices
            using a pricing strategy.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 pr-4">
        <div className="space-y-6 py-4">
          {/* Base Price Input */}
          <div className="space-y-2">
            <Label htmlFor="base-price">Base Price ({product.defaultPrice?.currencyCode || 'USD'})</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                {getCurrencySymbol(product.defaultPrice?.currencyCode || 'USD')}
              </span>
              <Input
                id="base-price"
                type="number"
                step="0.01"
                min="0"
                placeholder="4.99"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                className="pl-9 w-48"
              />
            </div>
          </div>

          {/* Pricing Strategy */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Pricing Strategy</Label>
              {(pppLoading || exchangeRatesLoading) && (
                <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
              )}
            </div>
            <TooltipProvider delayDuration={200}>
              <div className="grid grid-cols-3 gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label className="flex items-center gap-2 p-3 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                      <input
                        type="radio"
                        name="strategy"
                        value="direct"
                        checked={strategy === 'direct'}
                        onChange={() => setStrategy('direct')}
                        className="sr-only"
                      />
                      <Globe className="h-4 w-4 shrink-0" />
                      <span className="text-sm font-medium truncate">Direct</span>
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p className="font-medium">Direct Conversion</p>
                    <p className="text-xs text-muted-foreground">
                      Same USD value in all regions (converted to local currency)
                    </p>
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <label className="flex items-center gap-2 p-3 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                      <input
                        type="radio"
                        name="strategy"
                        value="ppp"
                        checked={strategy === 'ppp'}
                        onChange={() => setStrategy('ppp')}
                        className="sr-only"
                      />
                      <TrendingDown className="h-4 w-4 shrink-0" />
                      <span className="text-sm font-medium truncate">PPP (World Bank)</span>
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p className="font-medium">PPP-Adjusted (Recommended)</p>
                    <p className="text-xs text-muted-foreground">
                      Lower prices for lower-income regions based on World Bank purchasing power parity data.
                      Hyperinflation regions automatically receive reduced prices for affordability.
                    </p>
                    {pppMetadata && pppMetadata.worldBankRegions > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Data: World Bank ({pppMetadata.baseYear}) &bull; {pppMetadata.worldBankRegions} regions
                      </p>
                    )}
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <label className="flex items-center gap-2 p-3 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                      <input
                        type="radio"
                        name="strategy"
                        value="bigmac"
                        checked={strategy === 'bigmac'}
                        onChange={() => setStrategy('bigmac')}
                        className="sr-only"
                      />
                      <Beef className="h-4 w-4 shrink-0" />
                      <span className="text-sm font-medium truncate">Big Mac</span>
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p className="font-medium">Big Mac Index</p>
                    <p className="text-xs text-muted-foreground">
                      Prices based on The Economist&apos;s Big Mac Index - a real-world measure of purchasing power.
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Data: The Economist (2025) &bull; 53 countries
                    </p>
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <label className="flex items-center gap-2 p-3 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                      <input
                        type="radio"
                        name="strategy"
                        value="custom"
                        checked={strategy === 'custom'}
                        onChange={() => setStrategy('custom')}
                        className="sr-only"
                      />
                      <Sliders className="h-4 w-4 shrink-0" />
                      <span className="text-sm font-medium truncate">Custom</span>
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p className="font-medium">Custom Multipliers</p>
                    <p className="text-xs text-muted-foreground">
                      Define your own regional price multipliers (coming soon).
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
          </div>

          {/* Rounding Options */}
          <div className="space-y-3">
            <Label>Price Rounding</Label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="rounding"
                  value="charm"
                  checked={rounding === 'charm'}
                  onChange={() => setRounding('charm')}
                />
                <span className="text-sm">Nearest .99</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="rounding"
                  value="whole"
                  checked={rounding === 'whole'}
                  onChange={() => setRounding('whole')}
                />
                <span className="text-sm">Whole Numbers</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="rounding"
                  value="none"
                  checked={rounding === 'none'}
                  onChange={() => setRounding('none')}
                />
                <span className="text-sm">No Rounding</span>
              </label>
            </div>
          </div>

          {/* Region Selection */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Apply to Regions</Label>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="regionScope"
                    checked={applyToAllRegions}
                    onChange={() => setApplyToAllRegions(true)}
                  />
                  <span className="text-sm">All Regions</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="regionScope"
                    checked={!applyToAllRegions}
                    onChange={() => setApplyToAllRegions(false)}
                  />
                  <span className="text-sm">Selected Only</span>
                </label>
              </div>
            </div>

            {!applyToAllRegions && (
              <div className="border rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">
                    {selectedRegions.size} of {allRegions.length}{' '}
                    regions selected
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleAllRegions}
                  >
                    {selectedRegions.size === allRegions.length
                      ? 'Deselect All'
                      : 'Select All'}
                  </Button>
                </div>
                <ScrollArea className="h-32">
                  <div className="grid grid-cols-4 gap-2">
                    {allRegions.map((region) => (
                      <label
                        key={region.code}
                        className="flex items-center gap-2 text-sm cursor-pointer"
                      >
                        <Checkbox
                          checked={selectedRegions.has(region.code)}
                          onCheckedChange={() => toggleRegion(region.code)}
                        />
                        <span className="truncate" title={region.name}>
                          {region.code}
                        </span>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>

          {/* Preview Table */}
          {previewPrices.length > 0 && (
            <div className="space-y-2">
              <Label>Preview ({previewPrices.length} regions)</Label>
              <div className="border rounded-lg">
                <ScrollArea className="h-64">
                  <TooltipProvider delayDuration={100}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20">Region</TableHead>
                        <TableHead>Country</TableHead>
                        <TableHead>Currency</TableHead>
                        <TableHead className="text-right">Multiplier</TableHead>
                        <TableHead className="text-right">Exchange Rate</TableHead>
                        <TableHead className="text-right">Current</TableHead>
                        <TableHead className="text-right">New</TableHead>
                        <TableHead className="text-right">Change</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewPrices.map((calculated) => {
                        const region = allRegions.find(
                          (r) => r.code === calculated.regionCode
                        );
                        const currentPrice = getCurrentPrice(
                          calculated.regionCode
                        );
                        const currentPriceNum = currentPrice
                          ? moneyToNumber(currentPrice)
                          : 0;
                        const change = calculatePriceChange(
                          currentPriceNum,
                          calculated.rawPrice
                        );

                        return (
                          <TableRow key={calculated.regionCode}>
                            <TableCell>
                              <Badge variant="outline">
                                {calculated.regionCode}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm">
                              {region?.name || calculated.regionCode}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {calculated.currencyCode}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className={
                                    calculated.multiplier < 1
                                      ? 'text-green-600 cursor-help'
                                      : calculated.multiplier > 1
                                      ? 'text-orange-600 cursor-help'
                                      : 'text-muted-foreground cursor-help'
                                  }>
                                    {calculated.multiplier.toFixed(2)}×
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <p className="text-xs">
                                    {calculated.multiplierSource === 'world-bank' && 'World Bank PPP data'}
                                    {calculated.multiplierSource === 'big-mac' && 'Big Mac Index'}
                                    {calculated.multiplierSource === 'static' && 'Static fallback data'}
                                    {calculated.multiplierSource === 'custom' && 'Custom multiplier'}
                                    {calculated.multiplierSource === 'direct' && 'Direct conversion (1:1)'}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    ${basePriceNum.toFixed(2)} × {calculated.multiplier.toFixed(2)} = ${(basePriceNum * calculated.multiplier).toFixed(2)} USD
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-muted-foreground cursor-help">
                                    {calculated.exchangeRate.toFixed(2)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-xs">
                                  <p className="text-xs font-medium mb-1">
                                    USD → {calculated.currencyCode} Calculation
                                  </p>
                                  <div className="text-xs text-muted-foreground space-y-0.5">
                                    <p>1. Base price: ${basePriceNum.toFixed(2)} USD</p>
                                    <p>2. PPP adjusted: ${basePriceNum.toFixed(2)} × {calculated.multiplier.toFixed(2)} = ${calculated.adjustedUsdPrice.toFixed(2)} USD</p>
                                    <p>3. Convert to {calculated.currencyCode}: ${calculated.adjustedUsdPrice.toFixed(2)} × {calculated.exchangeRate.toFixed(2)} = {calculated.currencyCode} {(calculated.adjustedUsdPrice * calculated.exchangeRate).toFixed(2)}</p>
                                    {calculated.rawPrice !== calculated.adjustedUsdPrice * calculated.exchangeRate && (
                                      <p>4. After rounding: {calculated.currencyCode} {calculated.rawPrice.toFixed(2)}</p>
                                    )}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {currentPrice
                                ? formatMoney(currentPrice)
                                : '-'}
                            </TableCell>
                            <TableCell className="text-right font-medium">
                              {formatMoney(calculated.price)}
                            </TableCell>
                            <TableCell className="text-right">
                              {currentPrice ? (
                                <span
                                  className={
                                    change > 0
                                      ? 'text-red-600'
                                      : change < 0
                                      ? 'text-green-600'
                                      : 'text-muted-foreground'
                                  }
                                >
                                  {formatPriceChange(change)}
                                </span>
                              ) : (
                                <span className="text-green-600">New</span>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  </TooltipProvider>
                </ScrollArea>
              </div>
            </div>
          )}
        </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleApply}
            disabled={previewPrices.length === 0 || updateMutation.isPending}
          >
            {updateMutation.isPending
              ? 'Processing (This might take a while)'
              : `Apply to ${previewPrices.length} Regions`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
