'use client';

import { useState, useMemo, useEffect } from 'react';
import { Calculator, Globe, DollarSign, TrendingDown, Sliders, RefreshCw, Beef, AlertTriangle, Loader2 } from 'lucide-react';
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
import { useUpdateAppleSubscriptionPrices } from '@/hooks/use-subscriptions';

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
}: AppleSubscriptionBulkPricingModalProps) {
  const [basePrice, setBasePrice] = useState<string>('');
  const [inputMode, setInputMode] = useState<'tier' | 'manual'>('tier');
  const [strategy, setStrategy] = useState<PricingStrategy>('ppp');
  const [rounding, setRounding] = useState<RoundingMode>('charm');
  const [applyToAllRegions, setApplyToAllRegions] = useState(true);
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);

  // PPP data from World Bank API
  const [pppData, setPppData] = useState<DynamicPPPData | null>(null);
  const [pppMetadata, setPppMetadata] = useState<PPPApiResponse['metadata'] | null>(null);
  const [pppLoading, setPppLoading] = useState(false);

  // Exchange rates from Open Exchange Rates API
  const [exchangeRates, setExchangeRates] = useState<DynamicExchangeRates | null>(null);
  const [exchangeRatesLoading, setExchangeRatesLoading] = useState(false);

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
        if (data.metadata.fallback) {
          toast.warning('Using cached PPP data (World Bank API unavailable)');
        }
      }
    } catch (error) {
      console.error('Failed to fetch PPP data:', error);
      toast.error('Failed to fetch PPP data, using static values');
    } finally {
      setPppLoading(false);
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
      }
    } catch (error) {
      console.error('Failed to fetch exchange rates:', error);
    } finally {
      setExchangeRatesLoading(false);
    }
  };

  // Get regions to apply pricing to
  const targetRegions = useMemo(() => {
    if (applyToAllRegions) {
      return allTerritories.map((t) => t.alpha2);
    }
    return Array.from(selectedRegions);
  }, [applyToAllRegions, selectedRegions, allTerritories]);

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

    // Calculate ideal prices using existing bulk pricing function
    const calculatedPrices = calculateBulkPrices(
      basePriceNum,
      targetRegions,
      strategy,
      rounding,
      undefined, // customMultipliers
      pppData ?? undefined,
      actualCurrencies,
      exchangeRates ?? undefined
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
  const handleApply = async () => {
    if (previewPrices.length === 0) {
      toast.error('Please enter a valid base price');
      return;
    }

    // Check for regions without tier data
    const regionsWithoutTiers = previewPrices.filter(p => p.noTierData);
    if (regionsWithoutTiers.length > 0) {
      toast.warning(`Skipping ${regionsWithoutTiers.length} regions without Apple tier data`);
    }

    // Filter to only regions with valid tier data
    const validPrices = previewPrices.filter(p => !p.noTierData && p.tier);

    if (validPrices.length === 0) {
      toast.error('No valid price tiers found for any region');
      return;
    }

    setIsSaving(true);

    try {
      // Build prices payload by fetching price points per territory
      // Each territory needs its own territory-specific price point ID
      const prices: Record<string, { pricePointId: string; startDate?: string }> = {};
      let successCount = 0;
      let skipCount = 0;

      // Process territories in parallel batches to avoid overwhelming the API
      const BATCH_SIZE = 10;

      for (let i = 0; i < validPrices.length; i += BATCH_SIZE) {
        const batch = validPrices.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (territory) => {
          const alpha3Code = territory.territoryAlpha3;

          try {
            const response = await fetch(
              `/api/apple/subscriptions/${encodeURIComponent(subscription.id)}/price-points?territory=${encodeURIComponent(alpha3Code)}`
            );

            if (!response.ok) {
              console.warn(`Failed to fetch price points for ${alpha3Code}`);
              skipCount++;
              return;
            }

            const data = await response.json();
            const pricePoints: Array<{ id: string; customerPrice: string; proceeds: string }> = data.pricePoints || [];

            // Find the closest price point instead of exact match
            // This handles cases where local tier data doesn't align with Apple's territory-specific price points
            const matchingPoint = pricePoints.length > 0
              ? pricePoints.reduce((closest, pp) => {
                  const ppPrice = parseFloat(pp.customerPrice);
                  const closestPrice = parseFloat(closest.customerPrice);
                  const diff = Math.abs(ppPrice - territory.tierPrice);
                  const closestDiff = Math.abs(closestPrice - territory.tierPrice);
                  return diff < closestDiff ? pp : closest;
                })
              : null;

            if (matchingPoint) {
              prices[territory.territoryCode] = {
                pricePointId: matchingPoint.id,
                ...(isApproved && startDate ? { startDate } : {}),
              };
              successCount++;
            } else {
              console.warn(`No price point found for ${territory.territoryCode} at ${territory.tierPrice} ${territory.currency}`);
              skipCount++;
            }
          } catch (error) {
            console.error(`Error fetching price points for ${alpha3Code}:`, error);
            skipCount++;
          }
        }));
      }

      if (Object.keys(prices).length === 0) {
        toast.error('Failed to resolve any prices to Apple price points');
        return;
      }

      // Update prices via mutation
      await updateMutation.mutateAsync({
        subscriptionId: subscription.id,
        prices,
      });

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
      setBasePrice('');
      setInputMode('tier');
      setStrategy('ppp');
      setRounding('charm');
      setApplyToAllRegions(true);
      setSelectedRegions(new Set(Object.keys(subscription.prices || {})));
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
            Set a base USD price for <strong>{subscription.productId}</strong> and automatically calculate regional prices mapped to Apple&apos;s price tiers.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 pr-4">
          <div className="space-y-6 py-4">
            {/* Base Price and Effective Date Row */}
            <div className="flex gap-8">
              {/* Base Price Input */}
              <div className="space-y-2">
                <Label>Base Price (USD)</Label>
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
                      {selectedRegions.size} of {allTerritories.length} regions selected
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={toggleAllRegions}
                    >
                      {selectedRegions.size === allTerritories.length
                        ? 'Deselect All'
                        : 'Select All'}
                    </Button>
                  </div>
                  <ScrollArea className="h-32">
                    <div className="grid grid-cols-4 gap-2">
                      {allTerritories.map((territory) => (
                        <label
                          key={territory.alpha2}
                          className="flex items-center gap-2 text-sm cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedRegions.has(territory.alpha2)}
                            onCheckedChange={() => toggleRegion(territory.alpha2)}
                          />
                          <span className="truncate" title={territory.name}>
                            {alpha2ToAlpha3(territory.alpha2) || territory.alpha2}
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
                <div className="flex items-center justify-between">
                  <Label>Preview ({previewPrices.length} regions)</Label>
                  {warningCount > 0 && (
                    <div className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
                      <AlertTriangle className="h-4 w-4" />
                      <span className="text-xs">{warningCount} regions with tier mismatch or missing data</span>
                    </div>
                  )}
                </div>
                <div className="border rounded-lg">
                  <ScrollArea className="h-64">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-20">Region</TableHead>
                          <TableHead>Country</TableHead>
                          <TableHead>Currency</TableHead>
                          <TableHead className="text-right">Current</TableHead>
                          <TableHead className="text-right">New</TableHead>
                          <TableHead className="text-right">Change</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {previewPrices.map((preview) => {
                          const rowClassName = preview.noTierData
                            ? 'bg-red-50/50 dark:bg-red-950/20'
                            : '';

                          return (
                            <TableRow key={preview.territoryCode} className={rowClassName}>
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
            onClick={handleApply}
            disabled={previewPrices.length === 0 || isSaving || updateMutation.isPending}
          >
            {isSaving || updateMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {updateMutation.progress
                  ? `${updateMutation.progress.phase === 'delete' ? 'Clearing' : 'Updating'} ${updateMutation.progress.completed} of ${updateMutation.progress.total}...`
                  : 'Resolving price points...'}
              </>
            ) : (
              `Apply to ${previewPrices.filter(p => !p.noTierData).length} Regions`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
