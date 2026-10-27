'use client';

// What a price change means for people already subscribed, per territory
// (App Store rules in src/lib/pricing/price-increase.ts). Used in the Apple
// subscription preview table; the billing period and price history aren't
// known here, so the stricter reading applies (see the tooltip).

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { classifyPriceChange, currencyScale, decimalFromNumber, isDecimalString, normalizeDecimal, type PriceChangeClass } from '@/lib/pricing';

const LABELS: Record<PriceChangeClass, { text: string; className: string }> = {
  decrease: { text: 'Lower price', className: 'text-green-600' },
  unchanged: { text: 'Unchanged', className: 'text-muted-foreground' },
  'new-price': { text: 'New territory', className: 'text-muted-foreground' },
  'increase-to-new-subscribers-only': { text: 'New subscribers only', className: 'text-muted-foreground' },
  'increase-within-no-consent-threshold': { text: 'Notified', className: 'text-amber-600' },
  'increase-needs-consent': { text: 'Needs consent', className: 'text-red-600 font-medium' },
  'one-time-product': { text: '-', className: 'text-muted-foreground' },
};

export function ExistingSubscribersCell(props: {
  territory: string;
  current: { customerPrice: string; currency: string } | null;
  newPrice: number | null;
  currency: string;
  preserveCurrentPrice: boolean;
}) {
  const { territory, current, newPrice, currency, preserveCurrentPrice } = props;
  if (newPrice === null || !Number.isFinite(newPrice)) return <span className="text-muted-foreground">-</span>;
  const result = classifyPriceChange({
    platform: 'apple',
    productType: 'subscription',
    territory,
    current: current && isDecimalString(current.customerPrice) ? { currency: current.currency, amount: normalizeDecimal(current.customerPrice) } : null,
    after: { currency, amount: decimalFromNumber(newPrice, currencyScale(currency)) },
    effectiveDate: new Date().toISOString().slice(0, 10),
    preserveCurrentPrice,
  });
  const label = LABELS[result.classification];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`cursor-help ${label.className}`}>{label.text}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {result.reasons.map((r) => (
          <p key={r} className="text-xs">
            {r}
          </p>
        ))}
        {result.assumptions.length > 0 && <p className="text-xs text-muted-foreground mt-1">Assumed: {result.assumptions.join('; ')}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
