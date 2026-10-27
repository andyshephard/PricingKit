'use client';

// The "Custom" pricing strategy in the bulk pricing modals: a per-territory
// multiplier table the user types or pastes (GB=0.9 lines, or CSV with
// territory and multiplier columns, e.g. a price export with a multiplier
// column added). Territories without a multiplier are left out of the
// preview, so nothing is priced at a silent 1.0.

import { useMemo, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MultiplierCsvError, parseMultiplierText, relativeMultipliers } from '@/lib/pricing';
import { alpha2ToAlpha3, alpha3ToAlpha2 } from '@/lib/apple-connect/territories';

export interface CustomMultipliers {
  text: string;
  setText: (text: string) => void;
  /** Parsed table (alpha-2 -> multiplier), undefined while empty or invalid */
  table?: Record<string, string>;
  errors: string[];
  /** Multiplier per region code (alpha-2 and alpha-3), relative to the base region; for calculateBulkPrices */
  relative?: Record<string, number>;
  /** Keep only the regions that have a multiplier (and the base region) */
  filterRegions: (codes: string[]) => string[];
}

const toAlpha2 = (code: string) => (code.length === 3 ? (alpha3ToAlpha2(code) ?? code) : code);

export function useCustomMultipliers(baseRegion: string): CustomMultipliers {
  const [text, setText] = useState('');
  return useMemo(() => {
    let table: Record<string, string> | undefined;
    let errors: string[] = [];
    if (text.trim() !== '') {
      try {
        table = parseMultiplierText(text);
      } catch (error) {
        errors = error instanceof MultiplierCsvError ? error.issues : ['the table could not be read'];
      }
    }
    const base = toAlpha2(baseRegion);
    let relative: Record<string, number> | undefined;
    if (table) {
      relative = {};
      for (const [alpha2, m] of Object.entries(relativeMultipliers(table, base))) {
        relative[alpha2] = m;
        const alpha3 = alpha2ToAlpha3(alpha2);
        if (alpha3) relative[alpha3] = m;
      }
    }
    const filterRegions = (codes: string[]) => (table ? codes.filter((code) => toAlpha2(code) in table! || toAlpha2(code) === base) : []);
    return { text, setText, table, errors, relative, filterRegions };
  }, [text, baseRegion]);
}

/** The strategy radio option, styled like the others in the modals */
export function CustomStrategyOption({ checked, onSelect }: { checked: boolean; onSelect: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label className="flex items-center gap-2 p-3 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <input type="radio" name="strategy" value="custom" checked={checked} onChange={onSelect} className="sr-only" />
          <SlidersHorizontal className="h-4 w-4 shrink-0" />
          <span className="text-sm font-medium truncate">Custom</span>
        </label>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <p className="font-medium">Custom multipliers</p>
        <p className="text-xs text-muted-foreground">
          Your own multiplier per territory, relative to the base region. Only territories in your table are priced.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/** The table input with its parse result */
export function CustomMultipliersInput({ custom, baseRegion }: { custom: CustomMultipliers; baseRegion: string }) {
  const count = custom.table ? Object.keys(custom.table).length : 0;
  return (
    <div className="space-y-2">
      <Label htmlFor="custom-multipliers">Custom multipliers</Label>
      <textarea
        id="custom-multipliers"
        value={custom.text}
        onChange={(e) => custom.setText(e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={'GB=0.9\nIN=0.4\nBR=0.55\n\nor paste CSV with "territory" and "multiplier" columns'}
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-invalid={custom.errors.length > 0}
      />
      {custom.errors.length > 0 ? (
        <ul className="text-xs text-destructive space-y-0.5" role="alert">
          {custom.errors.slice(0, 5).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {count > 0
            ? `${count} territories. Prices are the base price converted to each currency times its multiplier divided by ${toAlpha2(baseRegion)}'s (1 if not listed). Multipliers 0.01 to 10.`
            : 'One territory per line (alpha-2 code and multiplier). Territories you leave out are not priced.'}
        </p>
      )}
    </div>
  );
}
