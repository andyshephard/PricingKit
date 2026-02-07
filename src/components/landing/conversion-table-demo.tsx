'use client';

import { useState, useMemo } from 'react';
import { ArrowUp, ArrowDown, Upload } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';

const COUNTRIES = [
  { code: 'US', name: 'United States', currency: 'USD', symbol: '$', rate: 1, ppp: 1.0 },
  { code: 'IN', name: 'India', currency: 'INR', symbol: '₹', rate: 91.69, ppp: 0.22 },
  { code: 'BR', name: 'Brazil', currency: 'BRL', symbol: 'R$', rate: 5.26, ppp: 0.48 },
  { code: 'TR', name: 'Turkey', currency: 'TRY', symbol: '₺', rate: 43.41, ppp: 0.26 },
  { code: 'DE', name: 'Germany', currency: 'EUR', symbol: '€', rate: 0.84, ppp: 0.83 },
  { code: 'CH', name: 'Switzerland', currency: 'CHF', symbol: 'CHF', rate: 0.77, ppp: 1.23 },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', symbol: '£', rate: 0.73, ppp: 0.91 },
] as const;

const FLAG_EMOJI: Record<string, string> = {
  US: '🇺🇸',
  IN: '🇮🇳',
  BR: '🇧🇷',
  TR: '🇹🇷',
  DE: '🇩🇪',
  CH: '🇨🇭',
  GB: '🇬🇧',
};

function formatPrice(value: number, symbol: string) {
  return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ConversionTableDemo() {
  const [basePrice, setBasePrice] = useState('9.99');

  const rows = useMemo(() => {
    const price = parseFloat(basePrice) || 0;
    return COUNTRIES.map((c) => {
      const applePrice = price * c.rate;
      const pricekitPrice = price * c.rate * c.ppp;
      const diff = pricekitPrice - applePrice;
      return {
        ...c,
        applePrice,
        pricekitPrice,
        diff,
      };
    });
  }, [basePrice]);

  const changedCount = rows.filter((r) => r.code !== 'US').length;

  return (
    <div className="rounded-xl border bg-card shadow-lg overflow-hidden">
      <div className="border-b bg-muted/30 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="text-muted-foreground">Base price (USD):</span>
          <div className="relative w-24">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
            <Input
              type="number"
              value={basePrice}
              onChange={(e) => setBasePrice(e.target.value)}
              className="pl-6 h-8 text-sm"
              step="0.01"
              min="0"
            />
          </div>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Country</TableHead>
            <TableHead className="text-right">
              <span className="text-muted-foreground line-through decoration-muted-foreground/50">Store Default</span>
            </TableHead>
            <TableHead className="text-right pr-4">
              <span className="text-primary font-semibold">PricingKit</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.code}>
              <TableCell className="pl-4">
                <div className="flex items-center gap-2">
                  <span>{FLAG_EMOJI[row.code]}</span>
                  <span className="font-medium">{row.name}</span>
                  <span className="text-xs text-muted-foreground">{row.currency}</span>
                </div>
              </TableCell>
              <TableCell className="text-right">
                <span className="text-muted-foreground line-through decoration-muted-foreground/40">
                  {formatPrice(row.applePrice, row.symbol)}
                </span>
              </TableCell>
              <TableCell className="text-right pr-4">
                <div className="flex items-center justify-end gap-1.5">
                  <span className="font-medium">
                    {formatPrice(row.pricekitPrice, row.symbol)}
                  </span>
                  {row.code !== 'US' && (
                    row.diff < 0 ? (
                      <ArrowDown className="h-3.5 w-3.5 text-primary" />
                    ) : (
                      <ArrowUp className="h-3.5 w-3.5 text-amber-500" />
                    )
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="border-t bg-muted/30 px-4 py-3 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {changedCount} prices to update
        </span>
        <Button size="sm" disabled>
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          Push Prices
        </Button>
      </div>
    </div>
  );
}
