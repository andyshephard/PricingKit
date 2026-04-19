'use client';

import { useState, useMemo, useEffect } from 'react';
import { Calculator, Globe, DollarSign, TrendingDown, Sliders, RefreshCw, Beef, AlertTriangle, Loader2, ArrowUpDown, ChevronUp, ChevronDown } from 'lucide-react';
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
import {
  getSupportedAppleTerritories,
  getTerritoryByAlpha2,
  alpha2ToAlpha3,
} from '@/lib/apple-connect/territories';
import { findClosestTierForCurrency, getUsdPriceTiers } from '@/lib/apple-connect/price-tier-data';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AppleProductPrice } from '@/lib/apple-connect/types';
import {
  calculateBulkPrices,
  calculatePriceChange,
  formatPriceChange,
  type PricingStrategy,
  type RoundingMode,
  type DynamicPPPData,
  type DynamicExchangeRates,
} from '@/lib/google-play/currency';
import { useUpdateAppleSubscriptionPrices, useResolveAppleSubscriptionPricePoints } from '@/hooks/use-subscriptions';

// Format price with currency
function formatPrice(price: string | number, currency: string): string {
  const amount = typeof price === 'string' ? parseFloat(price) : price;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

// Get earliest allowed effective date (2 days from now) in YYYY-MM-DD format
function getEarliestEffectiveDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  return date.toISOString().split('T')[0];
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

interface AppleSubscriptionBulkPricingModalProps {
  subscription: AppleSubscriptionData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preserveCurrentPrice: boolean;
  onPreserveCurrentPriceChange: (value: boolean) => void;
}

interface PreviewPrice {
  territoryCode: string; // alpha-2 code (e.g., "US")
  territoryAlpha3: string; // alpha-3 code for API (e.g., "USA")
  countryName: string;
  currency: string;
  idealPrice: number; // Calculated price from PPP/Big Mac/etc
  tierPrice: number; // Closest Apple tier price
  tier: string | null; // Apple tier ID
  tierDifference: number; // Percentage difference between ideal and tier
  currentPrice: number | null; // Current price if exists
  priceChange: number | null; // Percentage change from current
  noTierData: boolean; // True if no tier data available for this currency
}

export function AppleSubscriptionBulkPricingModal({
  subscription,
  open,
  onOpenChange,
  preserveCurrentPrice,
  onPreserveCurrentPriceChange,
}: AppleSubscriptionBulkPricingModalProps) {
  const [basePrice, setBasePrice] = useState<string>('');
  const [inputMode, setInputMode] = useState<'tier' | 'manual'>('tier');
  const [strategy, setStrategy] = useState<PricingStrategy>('ppp');
  const [rounding, setRounding] = useState<RoundingMode>('charm');
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
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

  // PPP data from World Bank API
  const [pppData, setPppData] = useState<DynamicPPPData | null>(null);
  const [pppMetadata, setPppMetadata] = useState<PPPApiResponse['metadata'] | null>(null);
  const [pppLoading, setPppLoading] = useState(false);

  // Exchange rates from Open Exchange Rates API
  const [exchangeRates, setExchangeRates] = useState<DynamicExchangeRates | null>(null);
  const [exchangeRatesLoading, setExchangeRatesLoading] = useState(false);

  const resolveMutation = useResolveAppleSubscriptionPricePoints();
  const updateMutation = useUpdateAppleSubscriptionPrices();

  const basePriceNum = parseFloat(basePrice) || 0;
  const isApproved = subscription.state === 'APPROVED';

  // Get all supported Apple territories
  const allTerritories = useMemo(() => {
    const supportedTerritories = getSupportedAppleTerritories();
    // Add territories with existing pricing that might not be in supported list
    const existingCodes = new Set(Object.keys(subscription.prices || {}));
    const supportedCodes = new Set(supportedTerritories.map(t => t.alpha2));

    const territories = [...supportedTerritories];

    // Add any territories with existing prices not in supported list
    for (const code of existingCodes) {
      if (!supportedCodes.has(code)) {
        const territory = getTerritoryByAlpha2(code);
        if (territory) {
          territories.push(territory);
        }
      }
    }

    return territories.sort((a, b) => a.name.localeCompare(b.name));
  }, [subscription.prices]);

  // Get all USD price tiers
  const usdTiers = useMemo(() => getUsdPriceTiers(), []);

  // Initialize selected regions from existing prices
  useEffect(() => {
    if (open) {
      const existingRegions = new Set(Object.keys(subscription.prices || {}));
      setSelectedRegions(existingRegions);
      if (isApproved) {
        setStartDate(getEarliestEffectiveDate());
      }
    }
  }, [open, subscription.prices, isApproved]);

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
    } finally {
      setExchangeRatesLoading(false);
      setExchangeRatesFetched(true);
    }
  };

  // Get regions to apply pricing to
  const targetRegions = useMemo(() => {
    // We calculate preview for ALL territories so user can pick from the table
    return allTerritories.map((t) => t.alpha2);
  }, [allTerritories]);

  // Build actual currencies map from territories
  const actualCurrencies = useMemo(() => {
    const currencies: Record<string, string> = {};
    for (const territory of allTerritories) {
      currencies[territory.alpha2] = territory.currency;
    }
    return currencies;
  }, [allTerritories]);

  // Calculate preview prices with Apple tier matching
  const previewPrices = useMemo((): PreviewPrice[] => {
    if (basePriceNum <= 0) return [];

    // Determine the base currency and region from the subscription
    // For subscriptions, we currently assume US as base if not specified, 
    // but let's try to find the actual base territory if possible.
    // Apple subscriptions don't have a single 'baseTerritory' field in our RawAppleSubscription type yet,
    // so we'll use the one from the prices map that matches our current basePrice.
    const baseRegion = Object.keys(subscription.prices || {}).find(
      code => subscription.prices[code].customerPrice === basePrice
    ) || 'US';
    
    const baseCurrency = subscription.prices[baseRegion]?.currency || 'USD';

    // Calculate ideal prices using existing bulk pricing function
    const calculatedPrices = calculateBulkPrices(
      basePriceNum,
      targetRegions,
      strategy,
      rounding,
      undefined, // customMultipliers
      pppData ?? undefined,
      actualCurrencies,
      exchangeRates ?? undefined,
      baseCurrency,
      baseRegion
    );

    // Map to preview format with Apple tier matching
    return calculatedPrices.map((calculated) => {
      const territory = getTerritoryByAlpha2(calculated.regionCode);
      const alpha3 = alpha2ToAlpha3(calculated.regionCode) || calculated.regionCode;
      const currency = calculated.currencyCode;

      // Find closest Apple tier for this price/currency
      const closestTier = findClosestTierForCurrency(calculated.rawPrice, currency);

      const tierPrice = closestTier?.price ?? calculated.rawPrice;
      const tier = closestTier?.tier ?? null;
      const tierDifference = closestTier
        ? ((closestTier.price - calculated.rawPrice) / calculated.rawPrice) * 100
        : 0;

      // Get current price for comparison
      const currentPriceData = subscription.prices[calculated.regionCode];
      const currentPrice = currentPriceData ? parseFloat(currentPriceData.customerPrice) : null;
      const priceChange = currentPrice !== null
        ? calculatePriceChange(currentPrice, tierPrice)
        : null;

      return {
        territoryCode: calculated.regionCode,
        territoryAlpha3: alpha3,
        countryName: territory?.name || calculated.regionCode,
        currency,
        idealPrice: calculated.rawPrice,
        tierPrice,
        tier,
        tierDifference,
        currentPrice,
        priceChange,
        noTierData: !closestTier,
      };
    });
  }, [basePriceNum, targetRegions, strategy, rounding, pppData, actualCurrencies, exchangeRates, subscription.prices]);

  const sortedPreviewPrices = useMemo(() => {
    let items = [...previewPrices];

    if (sortConfig.key && sortConfig.direction) {
      items.sort((a, b) => {
        let aValue: any;
        let bValue: any;

        switch (sortConfig.key) {
          case 'region':
            aValue = a.territoryAlpha3;
            bValue = b.territoryAlpha3;
            break;
          case 'name':
            aValue = a.countryName;
            bValue = b.countryName;
            break;
          case 'currency':
            aValue = a.currency;
            bValue = b.currency;
            break;
          case 'current':
            aValue = a.currentPrice || 0;
            bValue = b.currentPrice || 0;
            break;
          case 'new':
            aValue = a.tierPrice;
            bValue = b.tierPrice;
            break;
          case 'change':
            aValue = a.priceChange || 0;
            bValue = b.priceChange || 0;
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
  }, [previewPrices, sortConfig]);

  // Auto-select regions where the target price deviates from current price
  useEffect(() => {
    // Only run if modal is open, we haven't initialized yet, and data fetching is COMPLETE
    // This prevents initializing selection with stale/default prices before PPP data loads
    const isFetchingComplete = pppFetched && exchangeRatesFetched;

    if (open && !hasInitializedSelection && previewPrices.length > 0 && isFetchingComplete) {
      // Safety check: ensure previewPrices first item matches a territory we expect
      const firstPreview = previewPrices[0];
      const belongsToCurrentSubscription = allTerritories.some(t => t.alpha2 === firstPreview.territoryCode);
      
      if (!belongsToCurrentSubscription) return;

      const newSelected = new Set<string>();
      
      previewPrices.forEach((preview) => {
        // MATCH UI DISPLAY: Only pre-select if rounded change is non-zero
        // Using abs() >= 0.5 to match toFixed(0) rounding behavior seen in the table
        const isDifferent = preview.currentPrice === null || 
          Math.abs(preview.priceChange || 0) >= 0.5;

        if (isDifferent) {
          newSelected.add(preview.territoryCode);
        }
      });

      setSelectedRegions(newSelected);
      setHasInitializedSelection(true);
    }
  }, [open, previewPrices, hasInitializedSelection, allTerritories, pppFetched, exchangeRatesFetched]);

  const validSelectedCount = useMemo(() => {
    return previewPrices.filter(p => selectedRegions.has(p.territoryCode) && !p.noTierData && p.tier).length;
  }, [previewPrices, selectedRegions]);

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

  // Count warnings (large tier differences or missing tier data)
  const warningCount = useMemo(() => {
    return previewPrices.filter(p => p.noTierData || Math.abs(p.tierDifference) > 10).length;
  }, [previewPrices]);

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
    if (selectedRegions.size === allTerritories.length) {
      setSelectedRegions(new Set());
    } else {
      setSelectedRegions(new Set(allTerritories.map((t) => t.alpha2)));
    }
  };

  // Handle input mode change - snap to closest tier when switching to tier mode
  const handleInputModeChange = (mode: 'tier' | 'manual') => {
    setInputMode(mode);
    if (mode === 'tier' && basePrice) {
      const currentPrice = parseFloat(basePrice);
      if (!isNaN(currentPrice) && currentPrice > 0) {
        const closestTier = findClosestTierForCurrency(currentPrice, 'USD');
        if (closestTier) {
          setBasePrice(closestTier.price.toString());
        }
      }
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

    allTerritories.forEach(territory => {
      const previewItem = previewPrices.find(p => p.territoryCode === territory.alpha2);
      const isSelected = selectedRegions.has(territory.alpha2);
      const currentPriceData = subscription.prices[territory.alpha2];
      const currentPriceFormatted = currentPriceData 
        ? formatPrice(currentPriceData.customerPrice, currentPriceData.currency)
        : 'None';

      if (isSelected && previewItem && !previewItem.noTierData) {
        changing.push({
          name: territory.name,
          regionCode: territory.alpha2,
          old: currentPriceFormatted,
          new: formatPrice(previewItem.tierPrice, previewItem.currency)
        });
      } else {
        staying.push({
          name: territory.name,
          regionCode: territory.alpha2,
          price: currentPriceFormatted
        });
      }
    });

    setUpdateSummary({ changing, staying });
    setShowConfirmDialog(true);
  };

  const executeApply = async () => {
    // Filter to only selected regions
    const selectedPreviewPrices = previewPrices.filter(p => selectedRegions.has(p.territoryCode));

    // Check for regions without tier data
    const regionsWithoutTiers = selectedPreviewPrices.filter(p => p.noTierData);
    if (regionsWithoutTiers.length > 0) {
      toast.warning(`Skipping ${regionsWithoutTiers.length} regions without Apple tier data`);
    }

    // Filter to only regions with valid tier data
    const validPrices = selectedPreviewPrices.filter(p => !p.noTierData && p.tier);

    if (validPrices.length === 0) {
      toast.error('No valid price tiers found for any selected region');
      return;
    }

    setIsSaving(true);
    setShowConfirmDialog(false);

    try {
      // Phase 1: Resolve price points server-side in a single request
      const territories: Record<string, { targetPrice: number; currency: string }> = {};
      for (const p of validPrices) {
        territories[p.territoryCode] = {
          targetPrice: p.tierPrice,
          currency: p.currency,
        };
      }

      const { resolved, skipped } = await resolveMutation.mutateAsync({
        subscriptionId: subscription.id,
        territories,
      });

      const skipCount = skipped.length;

      if (Object.keys(resolved).length === 0) {
        toast.error('Failed to resolve any prices to Apple price points');
        return;
      }

      // Phase 2: Build prices payload and update via streaming mutation
      const prices: Record<string, { pricePointId: string; startDate?: string }> = {};
      for (const [territoryCode, { pricePointId }] of Object.entries(resolved)) {
        prices[territoryCode] = {
          pricePointId,
          ...(isApproved && startDate ? { startDate } : {}),
        };
      }

      await updateMutation.mutateAsync({
        subscriptionId: subscription.id,
        prices,
        preserveCurrentPrice,
      });

      const successCount = Object.keys(resolved).length;
      if (skipCount > 0) {
        toast.success(`Updated ${successCount} regions (${skipCount} skipped)`);
      } else {
        toast.success(`Updated prices for ${successCount} regions`);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to update prices'
      );
    } finally {
      setIsSaving(false);
    }
  };

  // Reset form when modal opens
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      // Initialize base price from existing US price or first available price
      const usPrice = subscription.prices?.['US'] || subscription.prices?.['USA'];
      const firstPrice = Object.values(subscription.prices || {})[0];
      const initialPrice = usPrice?.customerPrice || firstPrice?.customerPrice || '';
      
      setBasePrice(initialPrice);
      setInputMode('tier');
      setStrategy('ppp');
      setRounding('charm');
      setHasInitializedSelection(false);
      if (isApproved) {
        setStartDate(getEarliestEffectiveDate());
      } else {
        setStartDate('');
      }
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-6xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5" />
            Bulk Edit Regional Prices
          </DialogTitle>
          <DialogDescription>
            Set a base price for <strong>{subscription.productId}</strong> and automatically calculate regional prices mapped to Apple&apos;s price tiers.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 pr-4">
          <div className="space-y-6 py-4">
            {/* Base Price and Effective Date Row */}
            <div className="flex gap-8">
              {/* Base Price Input */}
              <div className="space-y-2">
                <Label>
                  Base Price ({(() => {
                    const usPrice = subscription.prices?.['US'] || subscription.prices?.['USA'];
                    const firstPrice = Object.values(subscription.prices || {})[0];
                    const basePrice = usPrice || firstPrice;
                    return basePrice ? `${basePrice.currency} - ${basePrice.territoryCode}` : 'USD';
                  })()})
                </Label>
                <Tabs value={inputMode} onValueChange={(v) => handleInputModeChange(v as 'tier' | 'manual')}>
                  <TabsList className="grid w-full grid-cols-2 max-w-xs">
                    <TabsTrigger value="tier">Select Tier</TabsTrigger>
                    <TabsTrigger value="manual">Enter Price</TabsTrigger>
                  </TabsList>

                  <TabsContent value="tier" className="mt-3">
                    <Select value={basePrice} onValueChange={setBasePrice}>
                      <SelectTrigger className="w-48">
                        <SelectValue placeholder="Select a price tier" />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        {usdTiers.map((tier) => (
                          <SelectItem key={tier.tier} value={tier.price.toString()}>
                            ${tier.price.toFixed(2)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-2">
                      Select from Apple&apos;s {usdTiers.length} available USD price tiers
                    </p>
                  </TabsContent>

                  <TabsContent value="manual" className="mt-3">
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
                    <p className="text-xs text-muted-foreground mt-2">
                      Enter any price - it will be matched to the closest Apple tier
                    </p>
                  </TabsContent>
                </Tabs>
              </div>

              {/* Effective Date for Approved Subscriptions */}
              {isApproved && (
                <div className="space-y-2">
                  <Label htmlFor="start-date">Effective Date</Label>
                  <div className="pt-[36px]">
                    <input
                      id="start-date"
                      type="date"
                      value={startDate}
                      min={getEarliestEffectiveDate()}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="flex h-10 w-48 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <p className="text-xs text-muted-foreground mt-2">
                      Future date required for approved subscriptions.
                    </p>
                  </div>
                </div>
              )}
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
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={preserveCurrentPrice}
                  onCheckedChange={(checked) => onPreserveCurrentPriceChange(checked === true)}
                />
                <span className="text-sm font-medium">Preserve existing subscriber prices</span>
              </label>
              <p className="text-xs text-muted-foreground ml-6">
                When enabled, existing subscribers keep their current price. Only new subscribers get the updated price.
              </p>
            </div>

            {/* Preview Table */}
            {previewPrices.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <Label>Regions & Preview ({selectedRegions.size} selected)</Label>
                    {warningCount > 0 && (
                      <div className="flex items-center gap-1 text-amber-600 dark:text-amber-500 mt-1">
                        <AlertTriangle className="h-3 w-3" />
                        <span className="text-[10px]">{warningCount} regions with issues</span>
                      </div>
                    )}
                  </div>
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
                      onClick={() => setSelectedRegions(new Set(allTerritories.map(t => t.alpha2)))}
                      disabled={selectedRegions.size === allTerritories.length}
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
                              checked={selectedRegions.size === allTerritories.length}
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
                        {sortedPreviewPrices.map((preview) => {
                          const isSelected = selectedRegions.has(preview.territoryCode);
                          const rowClassName = preview.noTierData
                            ? 'bg-red-50/50 dark:bg-red-950/20'
                            : !isSelected ? 'opacity-50' : '';

                          return (
                            <TableRow key={preview.territoryCode} className={rowClassName}>
                              <TableCell>
                                <Checkbox 
                                  checked={isSelected}
                                  onCheckedChange={() => toggleRegion(preview.territoryCode)}
                                  aria-label={`Select ${preview.territoryCode}`}
                                />
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline">
                                  {preview.territoryAlpha3}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-sm">
                                {preview.countryName}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {preview.currency}
                              </TableCell>
                              <TableCell className="text-right text-sm text-muted-foreground">
                                {preview.currentPrice !== null
                                  ? formatPrice(preview.currentPrice, preview.currency)
                                  : '-'}
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                {preview.noTierData ? (
                                  <span className="text-red-600">No tier data</span>
                                ) : (
                                  formatPrice(preview.tierPrice, preview.currency)
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                {preview.priceChange !== null ? (
                                  <span
                                    className={
                                      preview.priceChange > 0
                                        ? 'text-red-600'
                                        : preview.priceChange < 0
                                        ? 'text-green-600'
                                        : 'text-muted-foreground'
                                    }
                                  >
                                    {formatPriceChange(preview.priceChange)}
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

        <DialogFooter className="flex-shrink-0 border-t pt-4 mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleApplyClick}
            disabled={previewPrices.length === 0 || isSaving || resolveMutation.isPending || updateMutation.isPending}
          >
            {isSaving || resolveMutation.isPending || updateMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {resolveMutation.isPending && resolveMutation.progress
                  ? `Resolving price points ${resolveMutation.progress.completed} of ${resolveMutation.progress.total}...`
                  : updateMutation.progress
                    ? `${updateMutation.progress.phase === 'delete' ? 'Clearing' : 'Updating'} ${updateMutation.progress.completed} of ${updateMutation.progress.total}...`
                    : 'Resolving price points...'}
              </>
            ) : (
              `Apply to ${validSelectedCount} Regions`
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
                  {isApproved && startDate && (
                    <div className="mt-2 text-primary font-medium">
                      New prices will take effect on {startDate}.
                    </div>
                  )}
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
