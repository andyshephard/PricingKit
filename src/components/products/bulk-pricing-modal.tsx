'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Calculator, Globe, TrendingDown, Sliders, RefreshCw, Hamburger, Loader2, ArrowUpDown, ChevronUp, ChevronDown } from 'lucide-react';
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
  parseMoney,
} from '@/lib/google-play/types';
import { getSupportedAppleTerritories, getTerritoryByAlpha3, alpha2ToAlpha3 } from '@/lib/apple-connect/territories';
import { findClosestTierForCurrency, getPriceTiersForCurrency } from '@/lib/apple-connect/price-tier-data';
import { getCurrencySymbol as sharedGetCurrencySymbol } from '@/lib/utils/currency';
import { useAuthStore } from '@/store/auth-store';
import { useAppleAppPrice } from '@/hooks/use-apple-app-price';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

// Re-exported from shared util for backwards compatibility within this module.
const getCurrencySymbol = sharedGetCurrencySymbol;

// Helper to convert Apple price to Money format
function appleToMoney(applePrice: { customerPrice: string; currency: string }): Money {
  // Use parseMoney to correctly split decimal strings (e.g. "2.99") into units/nanos
  return parseMoney(parseFloat(applePrice.customerPrice || '0'), applePrice.currency);
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

type ProductWithApple = { _appleProduct?: { baseTerritory?: string } };

interface CalculatedPriceWithTier {
  tierId?: string;
  tierPrice?: number;
  tierDifference?: number;
}

interface BulkPricingModalProps {
  product: InAppProduct;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave?: (prices: Record<string, Money>) => Promise<{ skipped?: string[]; updated?: number }>;
}

export function BulkPricingModal({
  product,
  open,
  onOpenChange,
  onSave,
}: BulkPricingModalProps) {
  const platform = useAuthStore((state) => state.platform);
  const { data: appPrice } = useAppleAppPrice();

  // Initial base region: app-level (Apple) → per-product → 'USA' / 'US'.
  const initialBaseRegion = useMemo(() => {
    if (platform === 'apple') {
      return (
        appPrice?.baseTerritory ||
        (product as ProductWithApple)._appleProduct?.baseTerritory ||
        'USA'
      );
    }
    return 'US';
  }, [platform, appPrice?.baseTerritory, product]);

  const [baseRegion, setBaseRegion] = useState<string>(initialBaseRegion);
  const [userTouchedRegion, setUserTouchedRegion] = useState(false);
  const [inputMode, setInputMode] = useState<'tier' | 'manual'>('tier');
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);

  // Once app-level base territory loads, seed unless user already picked one.
  useEffect(() => {
    if (
      open &&
      platform === 'apple' &&
      appPrice?.baseTerritory &&
      !userTouchedRegion
    ) {
      setBaseRegion(appPrice.baseTerritory);
    }
  }, [open, platform, appPrice?.baseTerritory, userTouchedRegion]);

  // Currency derived from selected base region.
  const baseCurrency = useMemo(() => {
    if (platform === 'apple') {
      return getTerritoryByAlpha3(baseRegion)?.currency || 'USD';
    }
    return 'USD'; // Google base is always 'US' for now
  }, [platform, baseRegion]);

  // Available USD tiers for Apple tier mode (Phase 1: USD only).
  const availableTiers = useMemo(() => {
    if (platform !== 'apple') return [];
    return getPriceTiersForCurrency(baseCurrency);
  }, [platform, baseCurrency]);

  // Initial price for selected base region (for prefill).
  const priceForBaseRegion = useCallback((): number | null => {
    if (!product.prices) return null;
    if (platform === 'apple') {
      const ap = product.prices[baseRegion] as unknown as AppleProductPrice | undefined;
      if (ap?.customerPrice) return parseFloat(ap.customerPrice);
      // Fallback: try alpha-2/alpha-3 conversion if region key shape mismatches.
      const altKey = baseRegion.length === 3
        ? Object.keys(product.prices).find(k => alpha2ToAlpha3(k) === baseRegion)
        : undefined;
      if (altKey) {
        const fallback = product.prices[altKey] as unknown as AppleProductPrice | undefined;
        if (fallback?.customerPrice) return parseFloat(fallback.customerPrice);
      }
      return null;
    }
    const m = product.prices[baseRegion] as Money | undefined;
    return m ? moneyToNumber(m) : null;
  }, [product.prices, baseRegion, platform]);

  const [basePrice, setBasePrice] = useState<string>(() => {
    const initial = product.defaultPrice ? moneyToNumber(product.defaultPrice) : null;
    return initial !== null ? initial.toString() : '';
  });

  // When base region changes, prefill base price from product.prices[baseRegion].
  useEffect(() => {
    const seeded = priceForBaseRegion();
    if (seeded !== null) {
      setBasePrice(seeded.toString());
    } else {
      setBasePrice('');
    }
  }, [baseRegion, priceForBaseRegion]);

  const [strategy, setStrategy] = useState<PricingStrategy>('ppp');
  const [rounding, setRounding] = useState<RoundingMode>('charm');
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());

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
  const [isApplying, setIsApplying] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [hasInitializedSelection, setHasInitializedSelection] = useState(false);
  const [updateSummary, setUpdateSummary] = useState<{
    changing: Array<{ name: string; old: string; new: string; regionCode: string; isRequired: boolean }>;
    staying: Array<{ name: string; price: string; regionCode: string }>;
  } | null>(null);
  const [sortConfig, setSortConfig] = useState<{
    key: string;
    direction: 'asc' | 'desc' | null;
  }>({ key: 'name', direction: 'asc' });

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
    // We calculate preview for ALL available regions so user can pick from the table
    return allRegions.map((r) => r.code);
  }, [allRegions]);

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

  // Calculate preview prices using the user-selected base region + currency.
  const previewPrices = useMemo(() => {
    if (basePriceNum < 0) return [];

    const calculatedPrices = calculateBulkPrices(
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

    // For Apple, match each calculated price to the closest available tier
    const finalPrices = platform === 'apple' ? calculatedPrices.map(calculated => {
      const closestTier = findClosestTierForCurrency(calculated.rawPrice, calculated.currencyCode);
      if (closestTier) {
        return {
          ...calculated,
          // Override the display price with the actual Apple tier price, correctly parsed into units/nanos
          price: parseMoney(closestTier.price, calculated.currencyCode),
          tierPrice: closestTier.price,
          tierId: closestTier.tier,
          tierDifference: ((closestTier.price - calculated.rawPrice) / calculated.rawPrice) * 100
        };
      }
      return calculated;
    }) : calculatedPrices;

    return finalPrices;
  }, [basePriceNum, targetRegions, strategy, rounding, pppData, actualCurrencies, exchangeRates, platform, baseCurrency, baseRegion]);

  // Get current price for a region
  const getCurrentPrice = useCallback((regionCode: string): Money | null => {
    return normalizedPrices[regionCode] || null;
  }, [normalizedPrices]);

  const sortedPreviewPrices = useMemo(() => {
    const items = [...previewPrices].map(item => {
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
        let aValue: string | number;
        let bValue: string | number;

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
          case 'multiplier':
            aValue = a.multiplier;
            bValue = b.multiplier;
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
          case 'tier':
            aValue = (a as { tierId?: string }).tierId || '';
            bValue = (b as { tierId?: string }).tierId || '';
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
  }, [previewPrices, sortConfig, allRegions, getCurrentPrice]);

  // Auto-select regions where the target price deviates from current price
  useEffect(() => {
    // Only run if modal is open, we haven't initialized yet, and data fetching is COMPLETE
    // This prevents initializing selection with stale/default prices before PPP data loads
    const isFetchingComplete = pppFetched && exchangeRatesFetched;
    
    if (open && !hasInitializedSelection && previewPrices.length > 0 && isFetchingComplete) {
      // Safety check: ensure previewPrices first item matches a region we expect for this product
      const firstPreview = previewPrices[0];
      const belongsToCurrentProduct = allRegions.some(r => r.code === firstPreview.regionCode);
      
      if (!belongsToCurrentProduct) return;

      const appleBaseRegion = platform === 'apple' ? baseRegion : null;

      const newSelected = new Set<string>();
      
      previewPrices.forEach((calculated) => {
        const current = getCurrentPrice(calculated.regionCode);
        const target = calculated.price;
        const isRequired = calculated.regionCode === appleBaseRegion;

        const currentNum = current ? moneyToNumber(current) : 0;
        const targetNum = moneyToNumber(target);
        
        // Calculate the same change percentage as the "Change" column
        const change = calculatePriceChange(currentNum, targetNum);
        
        // MATCH UI DISPLAY: Only pre-select if rounded change is non-zero
        // Using abs() >= 0.5 to match toFixed(0) rounding behavior seen in the table
        const isDifferent = !current || Math.abs(change) >= 0.5;

        if (isDifferent || isRequired) {
          newSelected.add(calculated.regionCode);
        }
      });

      setSelectedRegions(newSelected);
      setHasInitializedSelection(true);
    }
  }, [open, previewPrices, hasInitializedSelection, platform, product, allRegions, pppFetched, exchangeRatesFetched, getCurrentPrice, baseRegion]);

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

    const changing: Array<{
      name: string;
      regionCode: string;
      old: string;
      new: string;
      isRequired: boolean;
    }> = [];
    const staying: Array<{
      name: string;
      regionCode: string;
      price: string;
    }> = [];

    const appleBaseRegion = platform === 'apple' ? baseRegion : null;

    allRegions.forEach(region => {
      const currentPrice = getCurrentPrice(region.code);
      const newPriceItem = previewPrices.find(p => p.regionCode === region.code);
      const isSelected = selectedRegions.has(region.code);
      const isRequired = region.code === appleBaseRegion;

      if ((isSelected || isRequired) && newPriceItem) {
        changing.push({
          name: region.name,
          regionCode: region.code,
          old: currentPrice ? formatMoney(currentPrice) : 'None',
          new: formatMoney(newPriceItem.price),
          isRequired
        });
      } else {
        staying.push({
          name: region.name,
          regionCode: region.code,
          price: currentPrice ? formatMoney(currentPrice) : 'None'
        });
      }
    });

    setUpdateSummary({ changing, staying });
    setShowConfirmDialog(true);
  };

  const executeApply = async () => {
    const prices: Record<string, Money> = {};
    const appleBaseRegion = platform === 'apple' ? baseRegion : null;

    previewPrices.forEach((calculated) => {
      if (selectedRegions.has(calculated.regionCode) || calculated.regionCode === appleBaseRegion) {
        prices[calculated.regionCode] = calculated.price;
      }
    });

    if (Object.keys(prices).length === 0) {
      toast.error('No prices selected to update');
      return;
    }

    setIsApplying(true);
    setShowConfirmDialog(false);
    try {
      const result = onSave
        ? await onSave(prices)
        : await updateMutation.mutateAsync({
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

      const successCount = updated ?? selectedRegions.size;
      toast.success(`Updated prices for ${successCount} regions`);
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
      // Initialize base price from the product's current default price
      // Use moneyToNumber to handle both units and nanos (cents)
      const initialPrice = product.defaultPrice 
        ? moneyToNumber(product.defaultPrice).toString() 
        : '';
      
      console.log(`[Bulk Edit Modal] Opening. Product SKU: ${product.sku}, Default Price: ${product.defaultPrice?.units} ${product.defaultPrice?.currencyCode}, Initialized basePrice to: ${initialPrice}`);
      
      // Force the state update immediately
      setBasePrice(initialPrice);
      setStrategy('ppp');
      setRounding('charm');
      setHasInitializedSelection(false);
      // Selected regions will be initialized by the useEffect once previewPrices is calculated
      // PPP data will be fetched by the useEffect
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
            Set a base price and automatically calculate regional prices
            using a pricing strategy.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 pr-4">
        <div className="space-y-6 py-4">
          {/* Base Region + Price */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Base Region picker */}
            <div className="space-y-2">
              <Label htmlFor="base-region">Base Country / Region</Label>
              <Select
                value={baseRegion}
                onValueChange={(v) => {
                  setBaseRegion(v);
                  setUserTouchedRegion(true);
                  setSelectedTierId(null);
                }}
              >
                <SelectTrigger id="base-region">
                  <SelectValue placeholder="Select region" />
                </SelectTrigger>
                <SelectContent>
                  {platform === 'apple'
                    ? getSupportedAppleTerritories().map((t) => (
                        <SelectItem key={t.alpha3} value={t.alpha3}>
                          {t.alpha3} — {t.name} ({t.currency})
                        </SelectItem>
                      ))
                    : GOOGLE_PLAY_REGIONS.map((r) => (
                        <SelectItem key={r.code} value={r.code}>
                          {r.code} — {r.name}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
            </div>

            {/* Apple-only Input mode toggle */}
            {platform === 'apple' && (
              <div className="space-y-2">
                <Label>Input Mode</Label>
                <div className="flex gap-4 pt-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="input-mode"
                      value="tier"
                      checked={inputMode === 'tier'}
                      onChange={() => setInputMode('tier')}
                      disabled={availableTiers.length === 0}
                    />
                    <span className={`text-sm ${availableTiers.length === 0 ? 'text-muted-foreground' : ''}`}>
                      Select Tier {availableTiers.length === 0 && `(no ${baseCurrency} tiers)`}
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="input-mode"
                      value="manual"
                      checked={inputMode === 'manual' || availableTiers.length === 0}
                      onChange={() => setInputMode('manual')}
                    />
                    <span className="text-sm">Enter Price</span>
                  </label>
                </div>
              </div>
            )}

            {/* Base Price input or Tier picker */}
            <div className="space-y-2">
              <Label htmlFor="base-price">
                Base Price ({baseCurrency} — {baseRegion})
              </Label>
              {platform === 'apple' && inputMode === 'tier' && availableTiers.length > 0 ? (
                <Select
                  value={selectedTierId ?? ''}
                  onValueChange={(v) => {
                    setSelectedTierId(v);
                    const tier = availableTiers.find((t) => t.tier === v);
                    if (tier) setBasePrice(tier.price.toString());
                  }}
                >
                  <SelectTrigger id="base-price">
                    <SelectValue placeholder="Select tier" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTiers.map((t) => (
                      <SelectItem key={t.tier} value={t.tier}>
                        Tier {t.tier} — {getCurrencySymbol(baseCurrency)}{t.price.toFixed(2)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    {getCurrencySymbol(baseCurrency)}
                  </span>
                  <Input
                    id="base-price"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="4.99"
                    value={basePrice}
                    onChange={(e) => setBasePrice(e.target.value)}
                    className="pl-9"
                  />
                </div>
              )}
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
                      <Hamburger className="h-4 w-4 shrink-0" />
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
            <Label className={platform === 'apple' ? "text-muted-foreground" : ""}>
              Price Rounding {platform === 'apple' && "(Disabled for Apple - using Price Tiers)"}
            </Label>
            <div className="flex gap-4">
              <label className={`flex items-center gap-2 ${platform === 'apple' ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
                <input
                  type="radio"
                  name="rounding"
                  value="charm"
                  checked={rounding === 'charm'}
                  onChange={() => platform !== 'apple' && setRounding('charm')}
                  disabled={platform === 'apple'}
                />
                <span className="text-sm">Nearest .99</span>
              </label>
              <label className={`flex items-center gap-2 ${platform === 'apple' ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
                <input
                  type="radio"
                  name="rounding"
                  value="whole"
                  checked={rounding === 'whole'}
                  onChange={() => platform !== 'apple' && setRounding('whole')}
                  disabled={platform === 'apple'}
                />
                <span className="text-sm">Whole Numbers</span>
              </label>
              <label className={`flex items-center gap-2 ${platform === 'apple' ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
                <input
                  type="radio"
                  name="rounding"
                  value="none"
                  checked={rounding === 'none'}
                  onChange={() => platform !== 'apple' && setRounding('none')}
                  disabled={platform === 'apple'}
                />
                <span className="text-sm">No Rounding</span>
              </label>
            </div>
          </div>

          {/* Preview Table */}
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
                  onClick={() => {
                    const next = new Set<string>();
                    const appleBaseRegion = platform === 'apple' ? baseRegion : null;
                    previewPrices.forEach((calculated) => {
                      const current = getCurrentPrice(calculated.regionCode);
                      const currentNum = current ? moneyToNumber(current) : 0;
                      const targetNum = moneyToNumber(calculated.price);
                      const change = calculatePriceChange(currentNum, targetNum);
                      const isDifferent = !current || Math.abs(change) >= 0.5;
                      if (isDifferent || calculated.regionCode === appleBaseRegion) {
                        next.add(calculated.regionCode);
                      }
                    });
                    setSelectedRegions(next);
                  }}
                  disabled={previewPrices.length === 0}
                >
                  Select only modified
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
              <ScrollArea className="h-[300px]">
                <TooltipProvider delayDuration={100}>
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
                      <TableHead className="text-right cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('multiplier')}>
                        <div className="flex items-center justify-end">
                          Multiplier {getSortIcon('multiplier')}
                        </div>
                      </TableHead>
                      <TableHead className="text-right cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('current')}>
                        <div className="flex items-center justify-end">
                          Current {getSortIcon('current')}
                        </div>
                      </TableHead>
                      <TableHead className="text-right cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('new')}>
                        <div className="flex items-center justify-end">
                          New Price {getSortIcon('new')}
                        </div>
                      </TableHead>
                      {platform === 'apple' && (
                        <TableHead className="text-right cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('tier')}>
                          <div className="flex items-center justify-end">
                            Tier Match {getSortIcon('tier')}
                          </div>
                        </TableHead>
                      )}
                      <TableHead className="text-right cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => requestSort('change')}>
                        <div className="flex items-center justify-end">
                          Change {getSortIcon('change')}
                        </div>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedPreviewPrices.map((calculated) => {
                      const currentPrice = getCurrentPrice(
                        calculated.regionCode
                      );
                      const isSelected = selectedRegions.has(calculated.regionCode);
                      const appleBaseRegion = platform === 'apple' ? baseRegion : null;
                      const isRequired = calculated.regionCode === appleBaseRegion;

                      return (
                        <TableRow 
                          key={calculated.regionCode}
                          className={!isSelected && !isRequired ? 'opacity-50' : ''}
                        >
                          <TableCell>
                            <Checkbox 
                              checked={isSelected || isRequired}
                              disabled={isRequired}
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
                            <div className="flex flex-col">
                              {calculated.countryName}
                              {isRequired && (
                                <span className="text-[10px] text-amber-600 dark:text-amber-500 font-medium">Required Base</span>
                              )}
                            </div>
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
                                  Relative to {baseRegion}: {calculated.multiplier.toFixed(2)}×
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {currentPrice
                              ? formatMoney(currentPrice)
                              : '-'}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help">
                                  {formatMoney(calculated.price)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-xs">
                                <p className="text-xs font-medium mb-1">
                                  {baseCurrency} → {calculated.currencyCode} Calculation
                                </p>
                                <div className="text-xs text-muted-foreground space-y-0.5">
                                  <p>1. Base price: {basePriceNum.toFixed(2)} {baseCurrency} ({baseRegion})</p>
                                  <p>2. Relative Adjustment: {calculated.multiplier.toFixed(2)}×</p>
                                  <p>3. Adjusted Price: {(basePriceNum * calculated.multiplier).toFixed(2)} {baseCurrency}</p>
                                  {baseCurrency !== calculated.currencyCode && (
                                    <p>4. Exchange Rate ({baseCurrency}→{calculated.currencyCode}): {(calculated.rawPrice / (basePriceNum * calculated.multiplier)).toFixed(4)}</p>
                                  )}
                                  <p>{baseCurrency !== calculated.currencyCode ? '5' : '4'}. Target Price: {calculated.rawPrice.toFixed(2)} {calculated.currencyCode}</p>
                                  {platform === 'apple' && (calculated as CalculatedPriceWithTier).tierId && (
                                    <p>{baseCurrency !== calculated.currencyCode ? '6' : '5'}. Apple Tier: Tier {(calculated as CalculatedPriceWithTier).tierId} ({formatMoney(calculated.price)})</p>
                                  )}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                          {platform === 'apple' && (
                            <TableCell className="text-right text-xs">
                              <div className="flex flex-col items-end">
                                <span className="text-muted-foreground">
                                  {(calculated as CalculatedPriceWithTier).tierId ? `Tier ${(calculated as CalculatedPriceWithTier).tierId}` : 'No tier'}
                                </span>
                                {Math.abs((calculated as CalculatedPriceWithTier).tierDifference ?? 0) > 0.1 && (
                                  <span className={((calculated as CalculatedPriceWithTier).tierDifference ?? 0) > 0 ? "text-orange-600" : "text-blue-600"}>
                                    {(((calculated as CalculatedPriceWithTier).tierDifference ?? 0) > 0 ? "+" : "") + ((calculated as CalculatedPriceWithTier).tierDifference ?? 0).toFixed(1)}% vs ideal
                                  </span>
                                )}
                              </div>
                            </TableCell>
                          )}
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
                </TooltipProvider>
              </ScrollArea>
            </div>
          </div>
        </div>
        </ScrollArea>

        <DialogFooter className="flex-shrink-0 border-t pt-4 gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleApplyClick}
            disabled={previewPrices.length === 0 || isApplying}
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
                  {platform === 'apple' && (
                    <div className="mt-2 text-amber-600 dark:text-amber-500 font-medium italic">
                      Note: For Apple Products, any regions NOT selected will revert to automatic pricing.
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
                          <div className="flex flex-col">
                            <span className="font-medium">{item.name} ({item.regionCode})</span>
                            {item.isRequired && (
                              <span className="text-[10px] text-amber-600 dark:text-amber-400 font-bold uppercase">Required Base Region</span>
                            )}
                          </div>
                          <span className="font-mono self-center">
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
