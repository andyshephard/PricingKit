'use client';

import { useState } from 'react';
import { AlertTriangle, ChevronDown, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PanelCard } from '@/components/pricing/strategy-panel';
import { cn } from '@/lib/utils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getTerritoryByAlpha2 } from '@/lib/apple-connect/territories';
import type { StoreOffer } from '@/lib/pricing';
import { useAppleSubscriptionOffers } from '@/hooks/use-apple-subscription-offers';
import { AppleOfferRuleDialog } from './apple-offer-rule-dialog';

const KIND_LABELS: Record<string, string> = {
  'apple.intro': 'Introductory',
  'apple.promo': 'Promotional',
  'apple.offerCode': 'Offer code',
  'apple.winBack': 'Win-back',
};

const MODE_LABELS: Record<string, string> = {
  FREE_TRIAL: 'Free trial',
  PAY_AS_YOU_GO: 'Pay as you go',
  PAY_UP_FRONT: 'Pay up front',
};

const DURATION_LABELS: Record<string, string> = {
  P3D: '3 days',
  P1W: '1 week',
  P2W: '2 weeks',
  P1M: '1 month',
  P2M: '2 months',
  P3M: '3 months',
  P6M: '6 months',
  P1Y: '1 year',
};

function territoryName(alpha2: string): string {
  return getTerritoryByAlpha2(alpha2)?.name ?? alpha2;
}

/** Small pill buttons of the Offers card */
export const offerChip =
  'inline-flex items-center gap-1.5 rounded-full bg-chip px-3 py-1.5 text-[13px] font-semibold text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50';
export const offerOutline =
  'inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 py-1.5 text-[13px] font-semibold text-foreground transition-colors hover:bg-accent hover:text-accent-foreground';

function OfferPrices({ offer }: { offer: StoreOffer }) {
  const territories = [...new Set([...Object.keys(offer.prices), ...Object.keys(offer.territoryProblems ?? {})])].sort();
  if (territories.length === 0) return <p className="text-sm text-muted-foreground">No prices.</p>;
  return (
    <div className="max-h-80 overflow-auto rounded-xl border border-line">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Region</TableHead>
            <TableHead>Country</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Proceeds</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {territories.map((t) => {
            const price = offer.prices[t];
            const problem = offer.territoryProblems?.[t];
            return (
              <TableRow key={t}>
                <TableCell className="font-mono">{t}</TableCell>
                <TableCell>{territoryName(t)}</TableCell>
                <TableCell className="font-mono">
                  {problem ? <span className="font-sans text-destructive">{problem}</span> : price?.free ? 'Free' : `${price.amount} ${price.currency}`}
                </TableCell>
                <TableCell className="font-mono">{price?.proceeds ? `${price.proceeds} ${price.currency}` : '–'}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** "Promotional · pay up front · 1 year · 175 countries" */
function offerTerms(offer: StoreOffer): string {
  const parts = [KIND_LABELS[offer.kind] ?? offer.kind, offer.mode ? (MODE_LABELS[offer.mode] ?? offer.mode).toLowerCase() : 'unknown mode'];
  if (offer.duration) parts.push(`${DURATION_LABELS[offer.duration] ?? offer.duration}${offer.periods && offer.periods > 1 ? ` x ${offer.periods}` : ''}`);
  const priced = Object.keys(offer.prices).length;
  parts.push(`${priced} ${priced === 1 ? 'country' : 'countries'}`);
  return parts.join(' · ');
}

function OfferItem({ subscriptionId, offer }: { subscriptionId: string; offer: StoreOffer }) {
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const problems = (offer.problems?.length ?? 0) + Object.keys(offer.territoryProblems ?? {}).length;
  // Only promotional offers with known, paid terms can be re-priced from the web app
  const canReprice = offer.kind === 'apple.promo' && offer.mode !== null && offer.mode !== 'FREE_TRIAL' && offer.duration !== null;
  const pricesId = `offer-prices-${offer.kind}-${offer.storeId}`.replace(/[^A-Za-z0-9_-]/g, '-');
  return (
    <li className="rounded-xl border border-line p-3.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="font-bold break-words">{offer.name ?? offer.key}</p>
          {offer.name && offer.kind !== 'apple.intro' && <p className="font-mono text-xs break-all text-muted-foreground">{offer.key}</p>}
          <p className="mt-1 text-[13px] text-muted-foreground">{offerTerms(offer)}</p>
        </div>
        {problems > 0 && (
          <Badge variant="warning" className="gap-1">
            <AlertTriangle className="size-3" aria-hidden="true" />
            {problems} {problems === 1 ? 'problem' : 'problems'}
          </Badge>
        )}
      </div>
      {offer.problems?.map((p) => (
        <p key={p} className="mt-2 text-sm text-destructive">
          {p}
        </p>
      ))}
      {(offer.schedule?.start || offer.schedule?.end) && (
        <p className="mt-2 text-[13px] text-soft">
          {offer.schedule.start ? `From ${offer.schedule.start}` : ''} {offer.schedule.end ? `until ${offer.schedule.end}` : ''}
        </p>
      )}
      {offer.status && (
        <p className="mt-1 text-[13px] text-soft">
          {Object.entries(offer.status)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(' · ')}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {canReprice && (
          <button type="button" className={offerChip} onClick={() => setUpdating(true)}>
            Update prices to rule
          </button>
        )}
        <button type="button" className={offerOutline} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={pricesId}>
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
          {open ? 'Hide prices' : 'Show prices'}
        </button>
      </div>
      {open && (
        <div id={pricesId} className="mt-3">
          <OfferPrices offer={offer} />
        </div>
      )}
      {updating && <AppleOfferRuleDialog subscriptionId={subscriptionId} target={{ kind: 'update', offer }} open={updating} onOpenChange={setUpdating} />}
    </li>
  );
}

/**
 * A subscription's offers, in the Atlas Offers card. Promotional offers can be
 * created from a percent-of-current rule, and an existing one re-priced to a
 * rule; every write is previewed, reviewed and applied with the plan's hash.
 * Other offer kinds are read-only here (use the CLI).
 */
export function AppleSubscriptionOffers({ subscriptionId }: { subscriptionId: string }) {
  const { data, isLoading, error, refetch } = useAppleSubscriptionOffers(subscriptionId);
  const [creating, setCreating] = useState(false);
  const offers = data?.offers ?? [];
  return (
    <PanelCard
      title="Offers"
      action={
        <button type="button" className={offerOutline} onClick={() => setCreating(true)}>
          <Plus className="size-3.5" aria-hidden="true" />
          Create from rule
        </button>
      }
    >
      {creating && <AppleOfferRuleDialog subscriptionId={subscriptionId} target={{ kind: 'create' }} open={creating} onOpenChange={setCreating} />}
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : error ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive">Could not load offers: {error.message}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : offers.length === 0 ? (
        <p className="text-sm text-muted-foreground">This subscription has no offers.</p>
      ) : (
        <ul className="space-y-3">
          {offers.map((offer) => (
            <OfferItem key={`${offer.kind}:${offer.storeId}`} subscriptionId={subscriptionId} offer={offer} />
          ))}
        </ul>
      )}
      <p className="mt-3.5 text-xs text-muted-foreground">
        The web app creates and re-prices promotional offers only. Introductory offers, offer codes and win-back offers are changed with the
        pricingkit CLI.
      </p>
    </PanelCard>
  );
}
