'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowUpDown, ChevronUp, ChevronDown, Hamburger, Globe, RefreshCw, Tv } from 'lucide-react';
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  calculateBulkPrices,
  getAllRegionCodes,
  type DynamicPPPData,
  type DynamicExchangeRates,
} from '@/lib/google-play/currency';
import { GOOGLE_PLAY_REGIONS, formatMoney } from '@/lib/google-play/types';
import { getCurrencySymbol } from '@/lib/utils/currency';

interface PPPApiResponse {
  success: boolean;
  data: DynamicPPPData;
  metadata?: {
    exchangeRatesSource?: 'live' | 'fallback';
    exchangeRatesSnapshotDate?: string;
    warning?: string;
  };
}

interface PPPMetadata {
  exchangeRatesSource?: 'live' | 'fallback';
  exchangeRatesSnapshotDate?: string;
  warning?: string;
}

interface ExchangeRatesApiResponse {
  success: boolean;
  data: {
    base: string;
    rates: Record<string, number>;
    fetchedAt: string;
  };
}

type SortKey = 'region' | 'name' | 'currency' | 'multiplier' | 'price';
type SortDirection = 'asc' | 'desc' | null;

export default function IndexCheckerPage() {
  const [strategy, setStrategy] = useState<'ppp' | 'bigmac' | 'netflix'>('ppp');
  const [baseRegion, setBaseRegion] = useState<string>('US');
  const [baseAmount, setBaseAmount] = useState<string>('49.99');
  const [pppData, setPppData] = useState<DynamicPPPData | null>(null);
  const [pppMetadata, setPppMetadata] = useState<PPPMetadata | null>(null);
  const [exchangeRates, setExchangeRates] = useState<DynamicExchangeRates | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'name',
    direction: 'asc',
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/ppp').then((r) => r.json() as Promise<PPPApiResponse>),
      fetch('/api/exchange-rates').then((r) => r.json() as Promise<ExchangeRatesApiResponse>),
    ])
      .then(([ppp, rates]) => {
        if (cancelled) return;
        if (ppp.success) {
          setPppData(ppp.data);
          if (ppp.metadata) setPppMetadata(ppp.metadata);
        }
        if (rates.success) {
          setExchangeRates({
            base: rates.data.base,
            rates: rates.data.rates,
            fetchedAt: rates.data.fetchedAt,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const baseCurrency = useMemo(
    () => GOOGLE_PLAY_REGIONS.find((r) => r.code === baseRegion)?.currency || 'USD',
    [baseRegion]
  );

  const baseAmountNum = parseFloat(baseAmount) || 0;

  const calculations = useMemo(() => {
    if (baseAmountNum <= 0) return [];
    const allRegions = getAllRegionCodes();
    return calculateBulkPrices(
      baseAmountNum,
      allRegions,
      strategy,
      'none',
      undefined,
      pppData ?? undefined,
      undefined,
      exchangeRates ?? undefined,
      baseCurrency,
      baseRegion
    ).map((calc) => {
      const region = GOOGLE_PLAY_REGIONS.find((r) => r.code === calc.regionCode);
      return {
        ...calc,
        countryName: region?.name || calc.regionCode,
      };
    });
  }, [baseAmountNum, strategy, pppData, exchangeRates, baseCurrency, baseRegion]);

  const sortedCalculations = useMemo(() => {
    if (!sortConfig.direction) return calculations;
    const items = [...calculations];
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
        case 'price':
          aValue = a.rawPrice;
          bValue = b.rawPrice;
          break;
        default:
          return 0;
      }
      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
    return items;
  }, [calculations, sortConfig]);

  const requestSort = (key: SortKey) => {
    let direction: SortDirection = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') direction = 'desc';
    else if (sortConfig.key === key && sortConfig.direction === 'desc') direction = null;
    setSortConfig({ key, direction });
  };

  const sortIcon = (key: SortKey) => {
    if (sortConfig.key !== key || !sortConfig.direction) {
      return <ArrowUpDown className="ml-1 h-3 w-3 inline text-muted-foreground" />;
    }
    return sortConfig.direction === 'asc' ? (
      <ChevronUp className="ml-1 h-3 w-3 inline" />
    ) : (
      <ChevronDown className="ml-1 h-3 w-3 inline" />
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <div className="mb-8">
          <Button variant="ghost" asChild className="mb-4">
            <Link href="/">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Link>
          </Button>
          <h1 className="text-3xl font-bold mb-2">Index Checker</h1>
          <p className="text-muted-foreground">
            Calculate equivalent prices across countries using PPP (World Bank), Big Mac Index, or Netflix Index data.
          </p>
        </div>

        {pppMetadata?.warning && (
          <div
            role="status"
            className="mb-6 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900 dark:border-yellow-900/40 dark:bg-yellow-900/20 dark:text-yellow-100"
          >
            <strong className="font-medium">Heads up: </strong>
            {pppMetadata.warning}
            {pppMetadata.exchangeRatesSnapshotDate && (
              <>
                {' '}Add an Open Exchange Rates API key in{' '}
                <Link href="/dashboard/settings" className="underline">
                  Settings
                </Link>{' '}
                for live rates.
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {/* Strategy */}
          <div className="space-y-2">
            <Label>Index</Label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <label
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer flex-1 transition-colors ${
                  strategy === 'ppp' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                <input
                  type="radio"
                  name="strategy"
                  value="ppp"
                  checked={strategy === 'ppp'}
                  onChange={() => setStrategy('ppp')}
                  className="sr-only"
                />
                <Globe className="h-4 w-4" />
                <span className="text-sm">PPP (World Bank)</span>
              </label>
              <label
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer flex-1 transition-colors ${
                  strategy === 'bigmac' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                <input
                  type="radio"
                  name="strategy"
                  value="bigmac"
                  checked={strategy === 'bigmac'}
                  onChange={() => setStrategy('bigmac')}
                  className="sr-only"
                />
                <Hamburger className="h-4 w-4" />
                <span className="text-sm">Big Mac Index</span>
              </label>
              <label
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer flex-1 transition-colors ${
                  strategy === 'netflix' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                <input
                  type="radio"
                  name="strategy"
                  value="netflix"
                  checked={strategy === 'netflix'}
                  onChange={() => setStrategy('netflix')}
                  className="sr-only"
                />
                <Tv className="h-4 w-4" />
                <span className="text-sm">Netflix Index</span>
              </label>
            </div>
          </div>

          {/* Base region */}
          <div className="space-y-2">
            <Label htmlFor="base-region">Base Country / Region</Label>
            <Select value={baseRegion} onValueChange={setBaseRegion}>
              <SelectTrigger id="base-region">
                <SelectValue placeholder="Select region" />
              </SelectTrigger>
              <SelectContent>
                {[...GOOGLE_PLAY_REGIONS]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((r) => (
                    <SelectItem key={r.code} value={r.code}>
                      {r.code} — {r.name} ({r.currency})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {/* Base amount */}
          <div className="space-y-2">
            <Label htmlFor="base-amount">Base Amount ({baseCurrency})</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                {getCurrencySymbol(baseCurrency)}
              </span>
              <Input
                id="base-amount"
                type="number"
                step="0.01"
                min="0"
                placeholder="49.99"
                value={baseAmount}
                onChange={(e) => setBaseAmount(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading PPP and exchange-rate data…
          </div>
        ) : baseAmountNum <= 0 ? (
          <div className="text-center text-sm text-muted-foreground py-8">
            Enter a base amount to see equivalent prices.
          </div>
        ) : (
          <div className="border rounded-lg">
            <ScrollArea className="h-[60vh]">
              <TooltipProvider delayDuration={100}>
                <Table>
                  <TableHeader className="sticky top-0 bg-background z-10 shadow-sm">
                    <TableRow>
                      <TableHead
                        className="w-20 cursor-pointer hover:bg-muted/50"
                        onClick={() => requestSort('region')}
                      >
                        Region {sortIcon('region')}
                      </TableHead>
                      <TableHead
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => requestSort('name')}
                      >
                        Country {sortIcon('name')}
                      </TableHead>
                      <TableHead
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => requestSort('currency')}
                      >
                        Currency {sortIcon('currency')}
                      </TableHead>
                      <TableHead
                        className="text-right cursor-pointer hover:bg-muted/50"
                        onClick={() => requestSort('multiplier')}
                      >
                        Multiplier {sortIcon('multiplier')}
                      </TableHead>
                      <TableHead
                        className="text-right cursor-pointer hover:bg-muted/50"
                        onClick={() => requestSort('price')}
                      >
                        Calculated Price {sortIcon('price')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedCalculations.map((calc) => (
                      <TableRow key={calc.regionCode}>
                        <TableCell>
                          <Badge variant="outline">{calc.regionCode}</Badge>
                        </TableCell>
                        <TableCell className="text-sm">{calc.countryName}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {calc.currencyCode}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                className={
                                  calc.multiplier < 1
                                    ? 'text-green-600 cursor-help'
                                    : calc.multiplier > 1
                                      ? 'text-orange-600 cursor-help'
                                      : 'text-muted-foreground cursor-help'
                                }
                              >
                                {calc.multiplier.toFixed(2)}×
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              <p className="text-xs">
                                {calc.multiplierSource === 'world-bank' && 'World Bank PPP data'}
                                {calc.multiplierSource === 'big-mac' && 'Big Mac Index'}
                                {calc.multiplierSource === 'netflix' && 'Netflix Price Index'}
                                {calc.multiplierSource === 'static' && 'Static fallback data'}
                                {calc.multiplierSource === 'direct' && 'Direct conversion (1:1)'}
                                {calc.multiplierSource === 'custom' && 'Custom multiplier'}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Relative to {baseRegion}: {calc.multiplier.toFixed(4)}×
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatMoney(calc.price)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TooltipProvider>
            </ScrollArea>
          </div>
        )}

        <div className="text-xs text-muted-foreground mt-4">
          PPP data source: World Bank Open Data (PA.NUS.PPP indicator). Big Mac Index source: The Economist. Netflix Index source: tompec/netflix-prices (CC-BY-4.0).
          Calculations are estimates — actual store pricing may apply rounding, tier snapping, or local rules
          that this tool does not.
        </div>
      </div>
    </div>
  );
}
