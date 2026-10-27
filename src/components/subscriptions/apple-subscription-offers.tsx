'use client';

import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getTerritoryByAlpha2 } from '@/lib/apple-connect/territories';
import type { AppleOfferKind, OfferDriftStatus, StoreOffer } from '@/lib/pricing';
import { useAppleOfferDrift, useAppleSubscriptionOffers, type OfferDriftQuery } from '@/hooks/use-apple-subscription-offers';

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

const STATUS_VARIANTS: Record<OfferDriftStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  match: 'secondary',
  mismatch: 'destructive',
  missing: 'destructive',
  extra: 'outline',
  unresolved: 'outline',
  unreadable: 'outline',
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

function DriftCheck({ subscriptionId, offer }: { subscriptionId: string; offer: StoreOffer }) {
  const [percent, setPercent] = useState('50');
  const [basis, setBasis] = useState<OfferDriftQuery['basis']>('perPeriod');
  const [snap, setSnap] = useState<OfferDriftQuery['snap']>('nearest');
  const [query, setQuery] = useState<OfferDriftQuery | null>(null);
  const { data, isFetching, error } = useAppleOfferDrift(subscriptionId, query);
  const report = data?.report;
  const drifted = report?.territories.filter((t) => t.status !== 'match') ?? [];

  return (
    <div className="space-y-3 rounded border p-3">
      <p className="text-sm font-medium">Check against rule</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`pct-${offer.storeId}`}>Percent of current price</Label>
          <Input id={`pct-${offer.storeId}`} className="w-24" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value.trim())} />
        </div>
        <div className="space-y-1">
          <Label>Basis</Label>
          <Select value={basis} onValueChange={(v) => setBasis(v as OfferDriftQuery['basis'])}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="perPeriod">Per billing period</SelectItem>
              <SelectItem value="totalOverDuration">Total over offer duration</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Snap</Label>
          <Select value={snap} onValueChange={(v) => setSnap(v as OfferDriftQuery['snap'])}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="nearest">Nearest</SelectItem>
              <SelectItem value="floor">Round down</SelectItem>
              <SelectItem value="ceil">Round up</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          disabled={isFetching || !/^\d+(\.\d+)?$/.test(percent)}
          onClick={() => setQuery({ kind: offer.kind as AppleOfferKind, offer: offer.storeId, percent, basis, snap })}
        >
          {isFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Check
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {report && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant={report.inSync ? 'secondary' : 'destructive'}>{report.inSync ? 'In step with the rule' : 'Drifted'}</Badge>
            {(Object.entries(report.summary) as Array<[OfferDriftStatus, number]>)
              .filter(([, n]) => n > 0)
              .map(([status, n]) => (
                <Badge key={status} variant={STATUS_VARIANTS[status]}>
                  {n} {status}
                </Badge>
              ))}
          </div>
          {report.problems?.map((p) => (
            <p key={p} className="text-sm text-destructive">
              {p}
            </p>
          ))}
          {drifted.length > 0 && (
            <div className="max-h-80 overflow-auto rounded border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Region</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Offer now</TableHead>
                    <TableHead>Rule gives</TableHead>
                    <TableHead>Current price</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drifted.map((e) => (
                    <TableRow key={e.territory}>
                      <TableCell className="font-mono">{e.territory}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANTS[e.status]}>{e.status}</Badge>
                      </TableCell>
                      <TableCell>{e.actual ? `${e.actual.amount} ${e.actual.currency}` : '–'}</TableCell>
                      <TableCell>{e.expected ? `${e.expected.amount} ${e.expected.currency} (exact ${e.expected.exactTarget})` : '–'}</TableCell>
                      <TableCell>{e.expected ? e.expected.currentPrice : '–'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{e.reason ?? ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {report.warnings && report.warnings.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {report.warnings.length} {report.warnings.length === 1 ? 'territory snaps' : 'territories snap'} more than{' '}
              {Number(report.deviationThreshold) * 100}% from the exact target.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function OfferRow({ subscriptionId, offer }: { subscriptionId: string; offer: StoreOffer }) {
  const [open, setOpen] = useState(false);
  const priced = Object.values(offer.prices).length;
  const problems = (offer.problems?.length ?? 0) + Object.keys(offer.territoryProblems ?? {}).length;
  const canCheck = offer.mode !== null && offer.mode !== 'FREE_TRIAL' && offer.duration !== null;
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
            {canCheck && <DriftCheck subscriptionId={subscriptionId} offer={offer} />}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** Read-only list of a subscription's offers. No create or edit actions (Phase 2a). */
export function AppleSubscriptionOffers({ subscriptionId }: { subscriptionId: string }) {
  const { data, isLoading, error, refetch } = useAppleSubscriptionOffers(subscriptionId);
  const offers = data?.offers ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Tag className="h-5 w-5" />
          Offers
        </CardTitle>
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
