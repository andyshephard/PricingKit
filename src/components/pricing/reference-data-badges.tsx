'use client';

// Freshness badges: how old the data behind a strategy is (PPP year, Big Mac
// edition, Netflix index date, exchange rates). The entries come from
// /api/ppp's metadata.freshness (src/lib/pricing/freshness.ts); stale ones
// are highlighted with their message as the tooltip.

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { FreshnessEntry, ReferenceDataId } from '@/lib/pricing';

const SHORT: Record<ReferenceDataId, string> = {
  ppp: 'PPP',
  bigmac: 'Big Mac',
  netflix: 'Netflix',
  fallbackExchangeRates: 'FX (fallback)',
  exchangeRates: 'FX',
  appleTiers: 'Apple tiers',
};

/** The data sets a strategy uses (exchange rates always; Apple tiers in Apple previews) */
export function referenceDataFor(strategy: string, options: { appleTiers?: boolean } = {}): ReferenceDataId[] {
  const index: ReferenceDataId[] = strategy === 'ppp' ? ['ppp'] : strategy === 'bigmac' ? ['bigmac'] : strategy === 'netflix' ? ['netflix'] : [];
  return [...index, 'exchangeRates', 'fallbackExchangeRates', ...(options.appleTiers ? (['appleTiers'] as const) : [])];
}

function age(days: number | undefined): string {
  if (days === undefined) return 'date unknown';
  if (days < 2) return 'today';
  if (days < 60) return `${days} days`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `${Math.round(days / 365)} years`;
}

export function ReferenceDataBadges({ entries, only }: { entries?: FreshnessEntry[]; only?: ReferenceDataId[] }) {
  const shown = (entries ?? []).filter((e) => !only || only.includes(e.id));
  if (shown.length === 0) return null;
  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Reference data freshness">
        <span className="text-xs text-muted-foreground">Data:</span>
        {shown.map((e) => (
          <Tooltip key={e.id}>
            <TooltipTrigger asChild>
              <Badge
                variant={e.stale ? 'outline' : 'secondary'}
                className={e.stale ? 'cursor-help border-amber-500 text-amber-700 dark:text-amber-400' : 'cursor-help'}
              >
                {SHORT[e.id]} {e.asOf ? e.asOf.slice(0, e.id === 'ppp' ? 4 : 10) : ''} · {age(e.ageDays)}
                {e.stale ? ' · stale' : ''}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <p className="text-xs">{e.message}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
