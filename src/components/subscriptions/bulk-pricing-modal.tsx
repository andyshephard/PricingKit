'use client';

import { useState, useMemo, useEffect } from 'react';
import { Calculator, Globe, DollarSign, TrendingDown, Sliders, RefreshCw, Beef, Loader2, ArrowUpDown, ChevronUp, ChevronDown } from 'lucide-react';
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
import type { Money, Subscription, BasePlan } from '@/lib/google-play/types';
import {
  GOOGLE_PLAY_REGIONS,
  formatMoney,
  moneyToNumber,
} from '@/lib/google-play/types';
import {
  calculateBulkPrices,
  calculatePriceChange,
  formatPriceChange,
  type PricingStrategy,
  type RoundingMode,
  type DynamicPPPData,
  type DynamicExchangeRates,
} from '@/lib/google-play/currency';
import { useUpdateBasePlanPrices } from '@/hooks/use-subscriptions';

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

interface SubscriptionBulkPricingModalProps {
  subscription: Subscription;
  basePlan: BasePlan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SubscriptionBulkPricingModal({
  subscription,
  basePlan,
  open,
  onOpenChange,
}: SubscriptionBulkPricingModalProps) {
  const [basePrice, setBasePrice] = useState<string>('');
  const [strategy, setStrategy] = useState<PricingStrategy>('ppp');
  const [rounding, setRounding] = useState<RoundingMode>('charm');
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());

  // PPP data from World Bank API
  const [pppData, setPppData] = useState<DynamicPPPData | null>(null);
  const [pppMetadata, setPppMetadata] = useState<PPPApiResponse['metadata'] | null>(null);
  const [pppLoading, setPppLoading] = useState(false);

  // Exchange rates from Open Exchange Rates API
  const [exchangeRates, setExchangeRates] = useState<DynamicExchangeRates | null>(null);
  const [exchangeRatesLoading, setExchangeRatesLoading] = useState(false);

  const updateMutation = useUpdateBasePlanPrices();
  const [isApplying, setIsApplying] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [hasInitializedSelection, setHasInitializedSelection] = useState(false);
  const [pppFetched, setPppFetched] = useState(false);
  const [exchangeRatesFetched, setExchangeRatesFetched] = useState(false);
  const [updateSummary, setUpdateSummary] = useState<{
    changing: Array<{ name: string; old: string; new: string; regionCode: string }>;
    staying: Array<{ name: string; price: string; regionCode: string }>;
  } | null>(null);
  const [sortConfig, setSortConfig] = useState<{
    key: string;
    direction: 'asc' | 'desc' | null;
  }>({ key: 'name', direction: 'asc' });

  const basePriceNum = parseFloat(basePrice) || 0;

  // Normalize prices from subscription data (handles both Google and Apple formats)
  // Must be calculated before allRegions so we can include territories with existing pricing
  const normalizedPrices = useMemo(() => {
    const prices: Record<string, Money> = {};
    if (basePlan.regionalConfigs) {
      for (const config of basePlan.regionalConfigs) {
        if (config.price) {
          prices[config.regionCode] = config.price;
        }
      }
    }
    return prices;
  }, [basePlan.regionalConfigs]);

  // Get Google Play regions sorted by country name
  const allRegions = useMemo(() => {
    return [...GOOGLE_PLAY_REGIONS].sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  // Fetch PPP data and exchange rates when modal opens
  // Only depend on `open` to prevent infinite retry loops on fetch failure
  useEffect(() => {
    if (open) {
      if (!pppData && !pppLoading) {
        fetchPPPData();
      }
      if (!exchangeRates && !exchangeRatesLoading) {
        fetchExchangeRates();
      }
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
    // We calculate preview for ALL regions so user can pick from the table
    return allRegions.map((r) => r.code);
  }, [allRegions]);

  // Extract actual currencies from normalized prices
  const actualCurrencies = useMemo(() => {
    const currencies: Record<string, string> = {};
    for (const [regionCode, money] of Object.entries(normalizedPrices)) {
      if (money.currencyCode) {
        currencies[regionCode] = money.currencyCode;
      }
    }
    return currencies;
  }, [normalizedPrices]);

  // Calculate preview prices
  const previewPrices = useMemo(() => {
    if (basePriceNum < 0) return [];
    
    const baseRegion = 'US';
    const baseCurrency = basePlan.regionalConfigs?.find(rc => rc.regionCode === 'US')?.price?.currencyCode || 'USD';

    return calculateBulkPrices(
      basePriceNum,
      targetRegions,
      strategy,
      rounding,
      undefined, // customMultipliers
      pppData ?? undefined, // dynamicPPPData
      actualCurrencies, // Use actual currencies from Google Play
      exchangeRates ?? undefined, // Dynamic exchange rates from API
      baseCurrency,
      baseRegion
    );
  }, [basePriceNum, targetRegions, strategy, rounding, pppData, actualCurrencies, exchangeRates, basePlan.regionalConfigs]);

  // Get current price for a region
  const getCurrentPrice = (regionCode: string): Money | null => {
    return normalizedPrices[regionCode] || null;
  };

  const sortedPreviewPrices = useMemo(() => {
    let items = [...previewPrices].map(item => {
      const region = allRegions.find(r => r.code === item.regionCode);
      const currentPrice = getCurrentPrice(item.regionCode);
      const currentPriceNum = currentPrice ? moneyToNumber(currentPrice) : 0;
      const targetPriceNum = moneyToNumber(item.price);
      const change = calculatePriceChange(currentPriceNum, targetPriceNum);
      
      return {
        ...item,
        countryName: region?.name || item.regionCode,
        currentPriceNum,
        change,
        newPriceNum: targetPriceNum,
      };
    });

    if (sortConfig.key && sortConfig.direction) {
      items.sort((a, b) => {
        let aValue: any;
        let bValue: any;

        switch (sortConfig.key) {
          case 'region':
            aValue = a.regionCode;
            bValue = b.regionCode;
            break;
          case 'name':
            aValue = a.countryName;
            bValue = b.countryName;
            break;
          case 'currency':
            aValue = a.currencyCode;
            bValue = b.currencyCode;
            break;
          case 'current':
            aValue = a.currentPriceNum;
            bValue = b.currentPriceNum;
            break;
          case 'new':
            aValue = a.newPriceNum;
            bValue = b.newPriceNum;
            break;
          case 'change':
            aValue = a.change;
            bValue = b.change;
            break;
          default:
            return 0;
        }

        if (aValue < bValue) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }

    return items;
  }, [previewPrices, sortConfig, allRegions]);

  // Auto-select regions where the target price deviates from current price
  useEffect(() => {
    // Only run if modal is open, we haven't initialized yet, and data fetching is COMPLETE
    // This prevents initializing selection with stale/default prices before PPP data loads
    const isFetchingComplete = pppFetched && exchangeRatesFetched;

    if (open && !hasInitializedSelection && previewPrices.length > 0 && isFetchingComplete) {
      // Safety check: ensure previewPrices first item matches a region we expect
      const firstPreview = previewPrices[0];
      const belongsToCurrentSubscription = allRegions.some(r => r.code === firstPreview.regionCode);
      
      if (!belongsToCurrentSubscription) return;

      const newSelected = new Set<string>();
      
      previewPrices.forEach((calculated) => {
        const current = getCurrentPrice(calculated.regionCode);
        const target = calculated.price;

        const currentNum = current ? moneyToNumber(current) : 0;
        const targetNum = moneyToNumber(target);
        
        // Calculate the same change percentage as the "Change" column
        const change = calculatePriceChange(currentNum, targetNum);
        
        // MATCH UI DISPLAY: Only pre-select if rounded change is non-zero
        // Using abs() >= 0.5 to match toFixed(0) rounding behavior seen in the table
        const isDifferent = !current || Math.abs(change) >= 0.5;

        if (isDifferent) {
          newSelected.add(calculated.regionCode);
        }
      });

      setSelectedRegions(newSelected);
      setHasInitializedSelection(true);
    }
  }, [open, previewPrices, hasInitializedSelection, normalizedPrices, allRegions, pppFetched, exchangeRatesFetched]);

  // Handle sorting
  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' | null = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    } else if (sortConfig.key === key && sortConfig.direction === 'desc') {
      direction = null;
    }
    setSortConfig({ key, direction });
  };

  const getSortIcon = (key: string) => {
    if (sortConfig.key !== key || !sortConfig.direction) {
      return <ArrowUpDown className="ml-2 h-3 w-3" />;
    }
    return sortConfig.direction === 'asc' ? (
      <ChevronUp className="ml-2 h-3 w-3" />
    ) : (
      <ChevronDown className="ml-2 h-3 w-3" />
    );
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
  const handleApplyClick = () => {
    if (selectedRegions.size === 0) {
      toast.error('Please select at least one region');
      return;
    }

    if (previewPrices.length === 0) {
      toast.error('Please enter a valid base price');
      return;
    }

    const changing: any[] = [];
    const staying: any[] = [];

    allRegions.forEach(region => {
      const previewItem = previewPrices.find(p => p.regionCode === region.code);
      const isSelected = selectedRegions.has(region.code);
      const currentPrice = getCurrentPrice(region.code);
      const currentPriceFormatted = currentPrice ? formatMoney(currentPrice) : 'None';

      if (isSelected && previewItem) {
        changing.push({
          name: region.name,
          regionCode: region.code,
          old: currentPriceFormatted,
          new: formatMoney(previewItem.price)
        });
      } else {
        staying.push({
          name: region.name,
          regionCode: region.code,
          price: currentPriceFormatted
        });
      }
    });

    setUpdateSummary({ changing, staying });
    setShowConfirmDialog(true);
  };

  const executeApply = async () => {
    const regionalConfigs = previewPrices
      .filter((calculated) => selectedRegions.has(calculated.regionCode))
      .map((calculated) => ({
        regionCode: calculated.regionCode,
        price: calculated.price,
      }));

    if (regionalConfigs.length === 0) {
      toast.error('No regions selected to update');
      return;
    }

    setIsApplying(true);
    setShowConfirmDialog(false);
    try {
      await updateMutation.mutateAsync({
        productId: subscription.productId,
        basePlanId: basePlan.basePlanId,
        regionalConfigs,
      });
      toast.success(`Updated prices for ${regionalConfigs.length} regions`);
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to update prices'
      );
    } finally {
      setIsApplying(false);
    }
  };

  // Reset form when modal opens
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      // Initialize base price from existing US price or first available price
      const usConfig = basePlan.regionalConfigs?.find(rc => rc.regionCode === 'US');
      const firstConfig = basePlan.regionalConfigs?.[0];
      const initialPrice = usConfig?.price 
        ? moneyToNumber(usConfig.price).toString() 
        : (firstConfig?.price ? moneyToNumber(firstConfig.price).toString() : '');

      setBasePrice(initialPrice);
      setStrategy('ppp');
      setRounding('charm');
      setHasInitializedSelection(false);
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
            Set a base USD price for <strong>{basePlan.basePlanId}</strong> and automatically calculate regional prices.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 pr-4">
        <div className="space-y-6 py-4">
          {/* Base Price Input */}
          <div className="space-y-2">
            <Label htmlFor="base-price">Base Price ({basePlan.regionalConfigs?.find(rc => rc.regionCode === 'US')?.price?.currencyCode || 'USD'})</Label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="base-price"
                type="number"
                step="0.01"
                min="0"
                placeholder="9.99"
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

          {/* Preserve Existing Subscriber Prices */}
          <div className="space-y-3">
            <label className="flex items-center gap-2 cursor-default">
              <Checkbox checked disabled />
              <span className="text-sm font-medium text-muted-foreground">Preserve existing subscriber prices</span>
            </label>
            <p className="text-xs text-muted-foreground ml-6">
              Google Play always preserves prices for existing subscribers. Price updates only apply to new subscribers.
            </p>
          </div>

          {/* Preview Table */}
          {previewPrices.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Regions & Preview ({selectedRegions.size} selected)</Label>
                <div className="flex items-center gap-2">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setSelectedRegions(new Set())}
                    disabled={selectedRegions.size === 0}
                  >
                    Deselect All
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setSelectedRegions(new Set(allRegions.map(r => r.code)))}
                    disabled={selectedRegions.size === allRegions.length}
                  >
                    Select All
                  </Button>
                </div>
              </div>
              <div className="border rounded-lg">
                <ScrollArea className="h-96">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background z-10 shadow-sm">
                      <TableRow>
                        <TableHead className="w-12">
                          <Checkbox 
                            checked={selectedRegions.size === allRegions.length}
                            onCheckedChange={toggleAllRegions}
                            aria-label="Select all"
                          />
                        </TableHead>
                        <TableHead className="w-20 cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('region')}>
                          <div className="flex items-center">
                            Region {getSortIcon('region')}
                          </div>
                        </TableHead>
                        <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('name')}>
                          <div className="flex items-center">
                            Country {getSortIcon('name')}
                          </div>
                        </TableHead>
                        <TableHead className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('currency')}>
                          <div className="flex items-center">
                            Currency {getSortIcon('currency')}
                          </div>
                        </TableHead>
                        <TableHead className="text-right cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('current')}>
                          <div className="flex items-center justify-end">
                            Current {getSortIcon('current')}
                          </div>
                        </TableHead>
                        <TableHead className="text-right cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('new')}>
                          <div className="flex items-center justify-end">
                            New {getSortIcon('new')}
                          </div>
                        </TableHead>
                        <TableHead className="text-right cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('change')}>
                          <div className="flex items-center justify-end">
                            Change {getSortIcon('change')}
                          </div>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedPreviewPrices.map((calculated) => {
                        const region = allRegions.find(
                          (r) => r.code === calculated.regionCode
                        );
                        const currentPrice = getCurrentPrice(
                          calculated.regionCode
                        );
                        const isSelected = selectedRegions.has(calculated.regionCode);

                        return (
                          <TableRow 
                            key={calculated.regionCode}
                            className={!isSelected ? 'opacity-50' : ''}
                          >
                            <TableCell>
                              <Checkbox 
                                checked={isSelected}
                                onCheckedChange={() => toggleRegion(calculated.regionCode)}
                                aria-label={`Select ${calculated.regionCode}`}
                              />
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">
                                {calculated.regionCode}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm">
                              {calculated.countryName}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {calculated.currencyCode}
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
                                    calculated.change > 0
                                      ? 'text-red-600'
                                      : calculated.change < 0
                                      ? 'text-green-600'
                                      : 'text-muted-foreground'
                                  }
                                >
                                  {formatPriceChange(calculated.change)}
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
            onClick={handleApplyClick}
            disabled={selectedRegions.size === 0 || isApplying}
          >
            {isApplying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Applying prices...
              </>
            ) : (
              `Apply to ${selectedRegions.size} Regions`
            )}
          </Button>
        </DialogFooter>

        {/* Confirmation Dialog */}
        <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
          <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
            <DialogHeader className="flex-shrink-0 text-left">
              <DialogTitle>Confirm Price Changes</DialogTitle>
              <DialogDescription asChild>
                <div className="text-sm text-muted-foreground">
                  Review the updates before applying them to {selectedRegions.size} regions.
                </div>
              </DialogDescription>
            </DialogHeader>

            <div className="flex-1 min-h-[300px] py-4 overflow-hidden border-y my-2">
              <ScrollArea className="h-[50vh] pr-4">
                <div className="space-y-6">
                  {/* Section: Changing */}
                  <div>
                    <h4 className="font-semibold text-sm mb-2 text-primary flex items-center gap-2 sticky top-0 bg-background py-1 z-10">
                      <span className="w-2 h-2 rounded-full bg-blue-500" />
                      Updating ({updateSummary?.changing.length})
                    </h4>
                    <div className="grid grid-cols-1 gap-1 pl-4">
                      {updateSummary?.changing.map(item => (
                        <div key={item.regionCode} className="text-xs flex justify-between border-b border-muted/30 py-1">
                          <span className="font-medium">{item.name} ({item.regionCode})</span>
                          <span className="font-mono">
                            <span className="text-muted-foreground line-through">{item.old}</span>
                            <span className="mx-2 text-muted-foreground">→</span>
                            <span className="font-bold text-blue-600 dark:text-blue-400">{item.new}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Section: Staying */}
                  <div>
                    <h4 className="font-semibold text-sm mb-2 text-muted-foreground flex items-center gap-2 sticky top-0 bg-background py-1 z-10">
                      <span className="w-2 h-2 rounded-full bg-gray-300" />
                      No Change ({updateSummary?.staying.length})
                    </h4>
                    <div className="grid grid-cols-1 gap-1 pl-4 opacity-70 text-muted-foreground">
                      {updateSummary?.staying.map(item => (
                        <div key={item.regionCode} className="text-xs flex justify-between py-1 border-b border-muted/10">
                          <span>{item.name} ({item.regionCode})</span>
                          <span className="font-mono">{item.price}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </div>

            <DialogFooter className="flex-shrink-0 gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setShowConfirmDialog(false)}>
                Cancel
              </Button>
              <Button onClick={executeApply}>
                Confirm and Apply
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
