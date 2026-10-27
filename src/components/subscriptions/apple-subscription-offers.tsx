'use client';

import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
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

function OfferPrices({ offer }: { offer: StoreOffer }) {
  const territories = [...new Set([...Object.keys(offer.prices), ...Object.keys(offer.territoryProblems ?? {})])].sort();
  if (territories.length === 0) return <p className="text-sm text-muted-foreground">No prices.</p>;
  return (
    <div className="max-h-80 overflow-auto rounded border">
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
                <TableCell>
                  {problem ? (
                    <span className="text-destructive">{problem}</span>
                  ) : price?.free ? (
                    'Free'
                  ) : (
                    `${price.amount} ${price.currency}`
                  )}
                </TableCell>
                <TableCell>{price?.proceeds ? `${price.proceeds} ${price.currency}` : '–'}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Re-price a promotional offer to "X% of each territory's current price".
 * The dialog asks for the rule, previews every territory (a dry-run plan) and
 * applies only after a confirm step.
 */
function UpdateToRule({ subscriptionId, offer }: { subscriptionId: string; offer: StoreOffer }) {
  const [updating, setUpdating] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded border p-3">
      <p className="text-sm text-muted-foreground">Re-price this promotional offer to a percent of each territory&apos;s current price.</p>
      <Button size="sm" variant="outline" onClick={() => setUpdating(true)}>
        Update prices to rule
      </Button>
      {updating && <AppleOfferRuleDialog subscriptionId={subscriptionId} target={{ kind: 'update', offer }} open={updating} onOpenChange={setUpdating} />}
    </div>
  );
}

function OfferRow({ subscriptionId, offer }: { subscriptionId: string; offer: StoreOffer }) {
  const [open, setOpen] = useState(false);
  const priced = Object.values(offer.prices).length;
  const problems = (offer.problems?.length ?? 0) + Object.keys(offer.territoryProblems ?? {}).length;
  const canReprice = offer.kind === 'apple.promo' && offer.mode !== null && offer.mode !== 'FREE_TRIAL' && offer.duration !== null;
  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen(!open)}>
        <TableCell>{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
        <TableCell>
          <Badge variant="outline">{KIND_LABELS[offer.kind] ?? offer.kind}</Badge>
        </TableCell>
        <TableCell>
          <div className="font-medium">{offer.name ?? offer.key}</div>
          {offer.name && offer.kind !== 'apple.intro' && <div className="font-mono text-xs text-muted-foreground">{offer.key}</div>}
        </TableCell>
        <TableCell>
          {offer.mode ? MODE_LABELS[offer.mode] : 'Unknown'}
          {offer.duration ? `, ${DURATION_LABELS[offer.duration] ?? offer.duration}` : ''}
          {offer.periods && offer.periods > 1 ? ` x ${offer.periods}` : ''}
        </TableCell>
        <TableCell>{priced}</TableCell>
        <TableCell>
          {problems > 0 && (
            <span className="inline-flex items-center gap-1 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" />
              {problems}
            </span>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={6} className="space-y-3 bg-muted/30">
            {offer.problems?.map((p) => (
              <p key={p} className="text-sm text-destructive">
                {p}
              </p>
            ))}
            {offer.schedule && (
              <p className="text-sm text-muted-foreground">
                {offer.schedule.start ? `From ${offer.schedule.start}` : ''} {offer.schedule.end ? `until ${offer.schedule.end}` : ''}
              </p>
            )}
            {offer.status && (
              <p className="text-sm text-muted-foreground">
                {Object.entries(offer.status)
                  .map(([k, v]) => `${k}: ${String(v)}`)
                  .join(' · ')}
              </p>
            )}
            <OfferPrices offer={offer} />
            {canReprice && <UpdateToRule subscriptionId={subscriptionId} offer={offer} />}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * A subscription's offers. Promotional offers can be created from a
 * percent-of-current rule, and an existing one re-priced to a rule; every
 * write is previewed first and applied behind a confirm dialog.
 */
export function AppleSubscriptionOffers({ subscriptionId }: { subscriptionId: string }) {
  const { data, isLoading, error, refetch } = useAppleSubscriptionOffers(subscriptionId);
  const [creating, setCreating] = useState(false);
  const offers = data?.offers ?? [];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg flex items-center gap-2">
          <Tag className="h-5 w-5" />
          Offers
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create offer from rule
        </Button>
        {creating && <AppleOfferRuleDialog subscriptionId={subscriptionId} target={{ kind: 'create' }} open={creating} onOpenChange={setCreating} />}
      </CardHeader>
      <CardContent>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Type</TableHead>
                <TableHead>Offer</TableHead>
                <TableHead>Terms</TableHead>
                <TableHead>Regions</TableHead>
                <TableHead>Problems</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {offers.map((offer) => (
                <OfferRow key={`${offer.kind}:${offer.storeId}`} subscriptionId={subscriptionId} offer={offer} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
