'use client';

import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { describePlayPhase, describePlayRegionPrice, describePlayTargeting, type StoreOffer } from '@/lib/pricing';
import { usePlaySubscriptionOffers } from '@/hooks/use-play-subscription-offers';

const STATE_VARIANTS: Record<string, 'default' | 'secondary' | 'outline'> = { ACTIVE: 'default', DRAFT: 'outline', INACTIVE: 'secondary' };

function OfferRegions({ offer }: { offer: StoreOffer }) {
  const play = offer.play!;
  const regions = [...new Set([...Object.keys(play.offer.regions), ...Object.keys(offer.territoryProblems ?? {})])].sort();
  if (regions.length === 0) return <p className="text-sm text-muted-foreground">No regions.</p>;
  return (
    <div className="max-h-80 overflow-auto rounded border">
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
                <TableCell key={i}>{describePlayRegionPrice(phase.regions[region])}</TableCell>
              ))}
              <TableCell>
                {offer.territoryProblems?.[region] ? (
                  <span className="text-destructive text-sm">{offer.territoryProblems[region]}</span>
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

function OfferRow({ offer }: { offer: StoreOffer }) {
  const [open, setOpen] = useState(false);
  const play = offer.play;
  if (!play) return null;
  const o = play.offer;
  return (
    <div className="border rounded-md p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOpen(!open)} aria-label={open ? 'Hide regions' : 'Show regions'}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
        <span className="font-mono font-medium">{offer.key}</span>
        <Badge variant={STATE_VARIANTS[o.state] ?? 'outline'}>{o.state}</Badge>
        <span className="text-sm text-muted-foreground">base plan {play.basePlanId}</span>
        {o.tags.map((tag) => (
          <Badge key={tag} variant="outline" className="gap-1">
            <Tag className="h-3 w-3" />
            {tag}
          </Badge>
        ))}
      </div>
      <p className="text-sm">{describePlayTargeting(o.targeting)}</p>
      <p className="text-sm text-muted-foreground">{o.phases.map((p, i) => `Phase ${i + 1}: ${describePlayPhase(p)}`).join(' · ')}</p>
      {(offer.problems?.length ?? 0) > 0 && (
        <div className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 mt-0.5" />
          <span>{offer.problems!.join('; ')}</span>
        </div>
      )}
      {open && <OfferRegions offer={offer} />}
    </div>
  );
}

/**
 * Read-only: a subscription's Google Play offers with their state,
 * eligibility, tags, phases and prices per region. Create and change them
 * with `pricingkit plan` and `pricingkit apply` (README).
 */
export function PlaySubscriptionOffers({ productId }: { productId: string }) {
  const { data, isLoading, error } = usePlaySubscriptionOffers(productId);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Offers</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : !data?.offers.length ? (
          <p className="text-sm text-muted-foreground">No offers on this subscription&apos;s base plans.</p>
        ) : (
          data.offers.map((offer) => <OfferRow key={offer.storeId} offer={offer} />)
        )}
        <p className="text-xs text-muted-foreground">Read-only. Plan and apply offer changes with the pricingkit CLI (plan, diff, apply).</p>
      </CardContent>
    </Card>
  );
}
