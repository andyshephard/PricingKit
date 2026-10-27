'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ReviewDialog, type ReviewChange } from '@/components/pricing/review-dialog';
import { countChanges } from '@/components/pricing/review-summary';
import { getTerritoryByAlpha2 } from '@/lib/apple-connect/territories';
import { defaultOfferBasis, serializeChangeSet, serializeRun, type OfferPlanEntry, type OfferPreviewRow, type StoreOffer } from '@/lib/pricing';
import {
  useApplyAppleOfferPlan,
  usePlanAppleOffer,
  type OfferPlanRequest,
  type OfferRuleInput,
} from '@/hooks/use-apple-subscription-offers';

const DURATIONS: Array<[string, string]> = [
  ['P1W', '1 week'],
  ['P2W', '2 weeks'],
  ['P1M', '1 month'],
  ['P2M', '2 months'],
  ['P3M', '3 months'],
  ['P6M', '6 months'],
  ['P1Y', '1 year'],
];

export type OfferRuleDialogTarget = { kind: 'create' } | { kind: 'update'; offer: StoreOffer };

function RuleFields({ rule, onChange, idPrefix }: { rule: OfferRuleInput; onChange: (rule: OfferRuleInput) => void; idPrefix: string }) {
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-pct`}>Percent of current price</Label>
        <Input id={`${idPrefix}-pct`} className="w-24" inputMode="decimal" value={rule.percent} onChange={(e) => onChange({ ...rule, percent: e.target.value.trim() })} />
      </div>
      <div className="space-y-1">
        <Label>Basis</Label>
        <Select value={rule.basis} onValueChange={(v) => onChange({ ...rule, basis: v as OfferRuleInput['basis'] })}>
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
        <Select value={rule.snap} onValueChange={(v) => onChange({ ...rule, snap: v as OfferRuleInput['snap'] })}>
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
    </>
  );
}

function PreviewTable({ rows, changed }: { rows: OfferPreviewRow[]; changed: Set<string> }) {
  return (
    <div className="max-h-72 overflow-auto rounded-xl border border-line">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Region</TableHead>
            <TableHead>Current</TableHead>
            <TableHead>Exact target</TableHead>
            <TableHead>Offer price</TableHead>
            <TableHead>Deviation</TableHead>
            <TableHead>Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.territory} className={changed.has(r.territory) ? '' : 'text-muted-foreground'}>
              <TableCell className="font-mono">{r.territory}</TableCell>
              <TableCell>{r.currentPrice ? `${r.currentPrice} ${r.currency}` : '–'}</TableCell>
              <TableCell>{r.exactTarget ?? '–'}</TableCell>
              <TableCell>{r.snappedPrice ? `${r.snappedPrice} ${r.currency}` : '–'}</TableCell>
              <TableCell>{r.deviationRatio ? `${(Number(r.deviationRatio) * 100).toFixed(2)}%` : '–'}</TableCell>
              <TableCell className="text-xs">
                {r.flags.map((f) => (
                  <span key={f.code} className={f.severity === 'error' ? 'text-destructive' : 'text-change'}>
                    {f.message}{' '}
                  </span>
                ))}
                {r.ok && !changed.has(r.territory) && 'unchanged'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** A 32-digit confirm hash, the only shape the apply route accepts */
const CONFIRM_HASH = /^[0-9a-f]{32}$/;

/** The plan's per-territory offer prices as review rows (same currency before and after) */
function offerReviewChanges(entry: OfferPlanEntry): ReviewChange[] {
  return entry.changes.map(({ territory, before, after }) => {
    const sameCurrency = before && before.currency === after.currency;
    return {
      id: territory,
      label: getTerritoryByAlpha2(territory)?.name ?? territory,
      before: before ? `${before.amount} ${before.currency}` : 'none',
      after: `${after.amount} ${after.currency}`,
      beforeAmount: sameCurrency ? Number(before.amount) : null,
      afterAmount: Number(after.amount),
    };
  });
}

function downloadText(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Create a promotional offer from a percent-of-current rule, or re-price an
 * existing one to a rule: preview every territory, review the changes
 * (ReviewDialog: counts, every territory before and after, Download plan
 * for the plan JSON), apply with the plan's hash, then show the run with its
 * log to download.
 */
export function AppleOfferRuleDialog({
  subscriptionId,
  target,
  open,
  onOpenChange,
}: {
  subscriptionId: string;
  target: OfferRuleDialogTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updating = target.kind === 'update';
  const [name, setName] = useState('');
  const [offerCode, setOfferCode] = useState('');
  const [mode, setMode] = useState<'PAY_UP_FRONT' | 'PAY_AS_YOU_GO'>('PAY_UP_FRONT');
  const [duration, setDuration] = useState('P1Y');
  const [periods, setPeriods] = useState('1');
  const [rule, setRule] = useState<OfferRuleInput>(
    target.kind === 'update' ? { percent: '50', basis: defaultOfferBasis(target.offer.mode), snap: 'nearest' } : { percent: '50', basis: 'totalOverDuration', snap: 'nearest' }
  );
  const [confirming, setConfirming] = useState(false);
  const plan = usePlanAppleOffer(subscriptionId);
  const apply = useApplyAppleOfferPlan(subscriptionId);

  // A changed form invalidates the preview: nothing is applied that wasn't shown
  const { reset: resetPlan } = plan;
  const { reset: resetApply } = apply;
  useEffect(() => {
    resetPlan();
    resetApply();
  }, [name, offerCode, mode, duration, periods, rule, resetPlan, resetApply]);

  const request: OfferPlanRequest =
    target.kind === 'update'
      ? { action: 'updatePrices', offer: target.offer.storeId, ...rule }
      : { action: 'create', name: name.trim(), offerCode: offerCode.trim(), mode, duration, ...(mode === 'PAY_AS_YOU_GO' ? { periods: Number(periods) } : {}), ...rule };
  const formValid =
    /^\d+(\.\d{1,4})?$/.test(rule.percent) && (updating || (name.trim() !== '' && offerCode.trim() !== '' && (mode !== 'PAY_AS_YOU_GO' || /^\d+$/.test(periods))));

  const result = plan.data;
  const entry = result?.entry;
  const changed = useMemo(() => new Set(entry?.changes.map((c) => c.territory) ?? []), [entry]);
  const skipped = result?.changeSet.skipped?.filter((s) => s.reason !== 'ALREADY_AT_TARGET') ?? [];
  const run = apply.data?.run;
  const runUrl = useMemo(() => (run ? URL.createObjectURL(new Blob([serializeRun(run)], { type: 'application/json' })) : undefined), [run]);
  useEffect(() => () => (runUrl ? URL.revokeObjectURL(runUrl) : undefined), [runUrl]);
  const planUrl = useMemo(() => (result ? URL.createObjectURL(new Blob([serializeChangeSet(result.changeSet)], { type: 'application/json' })) : undefined), [result]);
  useEffect(() => () => (planUrl ? URL.revokeObjectURL(planUrl) : undefined), [planUrl]);
  // File names the CLI's defaults expect: <plan>.json, <plan>.run.json, <plan>.undo.json
  const planFile = result ? `${result.changeSet.id}.json` : 'plan.json';
  const runFile = result ? `${result.changeSet.id}.run.json` : 'run.json';
  const reviewChanges = useMemo(() => (entry ? offerReviewChanges(entry) : []), [entry]);
  const reviewCounts = useMemo(() => countChanges(reviewChanges), [reviewChanges]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{updating ? 'Update prices to rule' : 'Create offer from rule'}</DialogTitle>
          <DialogDescription>
            {updating
              ? `Re-price the promotional offer "${target.offer.name ?? target.offer.key}" to a percent of each territory's current price. Its terms stay as they are.`
              : "A promotional offer priced at a percent of each territory's own current price, snapped to that territory's price points."}
          </DialogDescription>
          <p className="text-xs text-muted-foreground">
            The web app only creates and re-prices promotional offers, and keeps nothing: it can&apos;t resume or undo a run. Download the plan and,
            after applying, the run log; the <span className="font-mono">pricingkit</span> CLI can then resume the run or undo it (see the run result).
          </p>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-3">
          {!updating && (
            <>
              <div className="space-y-1">
                <Label htmlFor="offer-name">Name</Label>
                <Input id="offer-name" className="w-48" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="offer-code">Offer code</Label>
                <Input id="offer-code" className="w-48 font-mono" value={offerCode} onChange={(e) => setOfferCode(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Mode</Label>
                <Select
                  value={mode}
                  onValueChange={(v) => {
                    setMode(v as typeof mode);
                    setRule({ ...rule, basis: defaultOfferBasis(v as typeof mode) });
                  }}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PAY_UP_FRONT">Pay up front</SelectItem>
                    <SelectItem value="PAY_AS_YOU_GO">Pay as you go</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Duration</Label>
                <Select value={duration} onValueChange={setDuration}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {mode === 'PAY_AS_YOU_GO' && (
                <div className="space-y-1">
                  <Label htmlFor="offer-periods">Periods</Label>
                  <Input id="offer-periods" className="w-20" inputMode="numeric" value={periods} onChange={(e) => setPeriods(e.target.value.trim())} />
                </div>
              )}
            </>
          )}
          <RuleFields rule={rule} onChange={setRule} idPrefix="offer-rule" />
          <Button variant="outline" disabled={!formValid || plan.isPending} onClick={() => plan.mutate(request)}>
            {plan.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Preview
          </Button>
        </div>

        {plan.error && <p className="text-sm text-destructive">{plan.error.message}</p>}
        {entry && (
          <div className="space-y-2">
            {entry.refusals.map((r) => (
              <p key={r.code} className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {r.message}
              </p>
            ))}
            {entry.action === 'none' && <p className="text-sm text-muted-foreground">The offer already matches the rule in every territory. Nothing to apply.</p>}
            {entry.warnings.map((w) => (
              <p key={w} className="text-xs text-muted-foreground">
                {w}
              </p>
            ))}
            {(entry.action === 'create' || entry.action === 'updatePrices') && (
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge>{entry.action === 'create' ? 'Create' : 'Update prices'}</Badge>
                <Badge variant="secondary">{entry.changes.length} territories change</Badge>
                {skipped.length > 0 && <Badge variant="outline">{skipped.length} skipped</Badge>}
                {planUrl && (
                  <a className="inline-flex items-center gap-1 text-sm underline" href={planUrl} download={planFile}>
                    <Download className="h-4 w-4" />
                    Download plan
                  </a>
                )}
              </div>
            )}
            {entry.derivation && <PreviewTable rows={entry.derivation.rows} changed={changed} />}
          </div>
        )}

        {run && (
          <div className="space-y-2 rounded-xl border border-line p-3.5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={run.status === 'completed' ? 'secondary' : 'destructive'}>{run.status === 'completed' ? 'Applied' : 'Incomplete'}</Badge>
              {Object.entries(apply.data!.summary)
                .filter(([, n]) => n > 0)
                .map(([status, n]) => (
                  <Badge key={status} variant="outline">
                    {n} {status}
                  </Badge>
                ))}
              {planUrl && (
                <a className="inline-flex items-center gap-1 text-sm underline" href={planUrl} download={planFile}>
                  <Download className="h-4 w-4" />
                  Download plan
                </a>
              )}
              {runUrl && (
                <a className="inline-flex items-center gap-1 text-sm underline" href={runUrl} download={runFile}>
                  <Download className="h-4 w-4" />
                  Download run log
                </a>
              )}
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>Save both files now: nothing is kept after this dialog closes. With them, the CLI (App Store Connect key in the environment) can:</p>
              {run.status !== 'completed' && (
                <p>
                  Resume: <span className="font-mono">pricingkit apply {planFile} --confirm {result?.hash} --resume {runFile}</span>
                </p>
              )}
              <p>
                Undo: <span className="font-mono">pricingkit undo {planFile} {runFile}</span>, review the undo plan it writes, then{' '}
                <span className="font-mono">pricingkit apply {result?.changeSet.id}.undo.json --confirm &lt;its hash&gt; --force-delete</span>
              </p>
            </div>
            {run.stoppedDetail && <p className="text-sm text-destructive">{run.stoppedDetail}</p>}
            {run.ops
              .filter((r) => r.error || r.warning)
              .map((r) => (
                <p key={r.opId} className="text-sm text-destructive">
                  {r.opId}: {r.error?.message ?? r.warning}
                </p>
              ))}
          </div>
        )}
        {apply.error && <p className="text-sm text-destructive">{apply.error.message}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button disabled={!result || result.changeSet.ops.length === 0 || !!run || apply.isPending} onClick={() => setConfirming(true)}>
            Review and apply…
          </Button>
        </DialogFooter>
      </DialogContent>

      {entry && result && (
        <ReviewDialog
          open={confirming}
          onOpenChange={setConfirming}
          context={
            <>
              Promotional offer <span className="font-mono">{entry.key}</span> · subscription {subscriptionId}
            </>
          }
          noun={{ one: 'offer price', other: 'offer prices' }}
          changes={reviewChanges}
          stats={
            entry.action === 'create'
              ? [
                  { label: 'New prices', value: reviewCounts.added },
                  { label: 'Left out', value: skipped.length },
                  { label: 'Offers created', value: 1 },
                ]
              : [
                  { label: 'Decreases', value: reviewCounts.decreases },
                  { label: 'Increases', value: reviewCounts.increases },
                  { label: 'Offers re-priced', value: 1 },
                ]
          }
          warning={
            skipped.length > 0 || (result.changeSet.warnings?.length ?? 0) > 0 ? (
              <>
                {skipped.length > 0 && <>{skipped.length} {skipped.length === 1 ? 'territory is' : 'territories are'} left out (no usable price). </>}
                {(result.changeSet.warnings?.length ?? 0) > 0 && <>{result.changeSet.warnings!.length} {result.changeSet.warnings!.length === 1 ? 'warning' : 'warnings'}: see the preview.</>}
              </>
            ) : undefined
          }
          note={
            <>
              Exactly what the preview showed is applied, confirmed with the plan&apos;s hash. Each territory is checked against App Store Connect first
              and skipped if already done. The web app can&apos;t resume or undo: download the plan now and the run log afterwards, and use the CLI for
              either.
            </>
          }
          onDownloadPlan={() => downloadText(serializeChangeSet(result.changeSet), planFile)}
          applying={apply.isPending}
          applyDisabled={!CONFIRM_HASH.test(result.hash) || !!run}
          onApply={() => apply.mutate({ changeSet: result.changeSet, confirm: result.hash }, { onSettled: () => setConfirming(false) })}
        />
      )}
    </Dialog>
  );
}
