'use client';

import { useState } from 'react';
import { AlertTriangle, ChevronDown, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PanelCard } from '@/components/pricing/strategy-panel';
import { cn } from '@/lib/utils';
import { describePlayPhase, describePlayRegionPrice, describePlayTargeting, type StoreOffer } from '@/lib/pricing';
import { usePlaySubscriptionOffers } from '@/hooks/use-play-subscription-offers';
import { offerOutline } from './apple-subscription-offers';

const STATE_VARIANTS: Record<string, 'success' | 'secondary' | 'outline'> = { ACTIVE: 'success', DRAFT: 'outline', INACTIVE: 'secondary' };
const STATE_LABELS: Record<string, string> = { ACTIVE: 'Active', DRAFT: 'Draft', INACTIVE: 'Inactive' };

function OfferRegions({ offer }: { offer: StoreOffer }) {
  const play = offer.play!;
  const regions = [...new Set([...Object.keys(play.offer.regions), ...Object.keys(offer.territoryProblems ?? {})])].sort();
  if (regions.length === 0) return <p className="text-sm text-muted-foreground">No regions.</p>;
  return (
    <div className="max-h-80 overflow-auto rounded-xl border border-line">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Region</TableHead>
            {play.offer.phases.map((_, i) => (
              <TableHead key={i}>Phase {i + 1}</TableHead>
            ))}
            <TableHead>New subscribers</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {regions.map((region) => (
            <TableRow key={region}>
              <TableCell className="font-mono">{region}</TableCell>
              {play.offer.phases.map((phase, i) => (
                <TableCell key={i} className="font-mono">
                  {describePlayRegionPrice(phase.regions[region])}
                </TableCell>
              ))}
              <TableCell>
                {offer.territoryProblems?.[region] ? (
                  <span className="text-sm text-destructive">{offer.territoryProblems[region]}</span>
                ) : play.offer.regions[region]?.newSubscriberAvailability ? (
                  'Yes'
                ) : (
                  'No'
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function OfferItem({ offer }: { offer: StoreOffer }) {
  const [open, setOpen] = useState(false);
  const play = offer.play;
  if (!play) return null;
  const o = play.offer;
  const regionCount = Object.keys(o.regions).length;
  const regionsId = `play-offer-regions-${play.basePlanId}-${offer.key}`.replace(/[^A-Za-z0-9_-]/g, '-');
  return (
    <li className="rounded-xl border border-line p-3.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="font-mono font-bold break-all">{offer.key}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Base plan {play.basePlanId} · {regionCount} {regionCount === 1 ? 'region' : 'regions'}
          </p>
        </div>
        <Badge variant={STATE_VARIANTS[o.state] ?? 'outline'}>{STATE_LABELS[o.state] ?? o.state}</Badge>
      </div>
      <p className="mt-2 text-[13px] text-soft">{describePlayTargeting(o.targeting)}</p>
      <p className="mt-1 text-[13px] text-soft">{o.phases.map((p, i) => `Phase ${i + 1}: ${describePlayPhase(p)}`).join(' · ')}</p>
      {o.tags.length > 0 && (
        <ul aria-label="Offer tags" className="mt-2 flex flex-wrap gap-1.5">
          {o.tags.map((tag) => (
            <li key={tag}>
              <Badge variant="secondary" className="gap-1 font-mono">
                <Tag className="size-3" aria-hidden="true" />
                {tag}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {(offer.problems?.length ?? 0) > 0 && (
        <div className="mt-2 flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{offer.problems!.join('; ')}</span>
        </div>
      )}
      <div className="mt-3">
        <button type="button" className={offerOutline} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={regionsId}>
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
          {open ? 'Hide regions' : 'Show regions'}
        </button>
      </div>
      {open && (
        <div id={regionsId} className="mt-3">
          <OfferRegions offer={offer} />
        </div>
      )}
    </li>
  );
}

/**
 * Read-only: a subscription's Google Play offers with their state,
 * eligibility, tags, phases and prices per region, in the Atlas Offers card.
 * Create and change them with `pricingkit plan` and `pricingkit apply`.
 */
export function PlaySubscriptionOffers({ productId }: { productId: string }) {
  const { data, isLoading, error } = usePlaySubscriptionOffers(productId);
  return (
    <PanelCard title="Offers">
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : error ? (
        <p className="text-sm text-destructive">{error.message}</p>
      ) : !data?.offers.length ? (
        <p className="text-sm text-muted-foreground">No offers on this subscription&apos;s base plans.</p>
      ) : (
        <ul className="space-y-3">
          {data.offers.map((offer) => (
            <OfferItem key={offer.storeId} offer={offer} />
          ))}
        </ul>
      )}
      <p className="mt-3.5 text-xs text-muted-foreground">Read-only. Plan and apply offer changes with the pricingkit CLI (plan, diff, apply).</p>
    </PanelCard>
  );
}
