'use client';

import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { changePercent, countChanges, planCsv, planFileName, type ReviewChange } from './review-summary';

export type { ReviewChange } from './review-summary';

export interface ReviewStat {
  label: string;
  value: number | string;
}

export interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Small context line above the title, e.g. "com.example.app · Annual". */
  context?: React.ReactNode;
  /** The changes to apply. */
  changes: readonly ReviewChange[];
  /**
   * The three figures under the title. Defaults to decreases, increases and
   * new prices, or `unchangedCount` when nothing is new.
   */
  stats?: ReviewStat[];
  /** How many items stay as they are, for the default third figure. */
  unchangedCount?: number;
  /** The existing-subscriber (or other) note, in the info style. */
  note?: React.ReactNode;
  /** A warning shown above the note, e.g. about regions reverting. */
  warning?: React.ReactNode;
  /** Name used in the downloaded plan's file name. Download is hidden when omitted. */
  planSubject?: string;
  /** Replace the default CSV download with your own (e.g. a plan JSON). */
  onDownloadPlan?: () => void;
  onApply: () => void;
  applying?: boolean;
  /** Disable Apply, e.g. while a plan hash is missing. */
  applyDisabled?: boolean;
  noun?: { one: string; other: string };
}

function downloadCsv(changes: readonly ReviewChange[], subject: string) {
  const blob = new Blob([planCsv(changes)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = planFileName(subject);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The Atlas review step before prices are applied: counts, the list of
 * changes, a note about existing subscribers, Download plan, Cancel and Apply.
 * It only presents and confirms; the caller does the work in `onApply`.
 */
export function ReviewDialog({
  open,
  onOpenChange,
  context,
  changes,
  stats,
  unchangedCount,
  note,
  warning,
  planSubject,
  onDownloadPlan,
  onApply,
  applying = false,
  applyDisabled = false,
  noun = { one: 'price change', other: 'price changes' },
}: ReviewDialogProps) {
  const counts = useMemo(() => countChanges(changes), [changes]);
  const n = changes.length;
  const label = n === 1 ? noun.one : noun.other;
  const figures: ReviewStat[] = stats ?? [
    { label: 'Decreases', value: counts.decreases },
    { label: 'Increases', value: counts.increases },
    // New prices matter more than untouched ones when there are any.
    counts.added === 0 && unchangedCount !== undefined
      ? { label: 'Not changing', value: unchangedCount }
      : { label: 'New prices', value: counts.added },
  ];
  const canDownload = Boolean(onDownloadPlan || planSubject) && n > 0;

  return (
    <Dialog open={open} onOpenChange={applying ? undefined : onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[680px]">
        <div className="px-6 pt-6 pb-2 sm:px-7">
          {context && <p className="pr-8 text-[13px] text-muted-foreground">{context}</p>}
          <DialogTitle className="mt-1 pr-8 text-2xl font-extrabold tracking-[-0.01em]">
            Review {n} {label}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Check the changes below, then apply them or cancel.
          </DialogDescription>
        </div>

        <div className="grid grid-cols-3 gap-3 px-6 py-4 sm:px-7">
          {figures.map((f) => (
            <div key={f.label} className="min-w-0 rounded-xl bg-background p-3.5">
              <p className="truncate text-xs text-muted-foreground">{f.label}</p>
              <p className="mt-1 text-[22px] font-extrabold">{f.value}</p>
            </div>
          ))}
        </div>

        <div className="mx-6 min-h-0 flex-1 overflow-auto rounded-xl border border-line sm:mx-7 sm:max-h-[260px]">
          {n === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing to change.</p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Changes to apply</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Before and after</th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => {
                  const pct = changePercent(c);
                  return (
                    <tr key={c.id} className="border-b border-line last:border-b-0">
                      <th scope="row" className="px-3.5 py-2.5 text-left font-semibold">
                        {c.label}
                        {c.note && (
                          <span className="ml-2 rounded-full bg-warn px-2 py-0.5 text-[11px] font-semibold text-warn-foreground">
                            {c.note}
                          </span>
                        )}
                      </th>
                      <td className="px-3.5 py-2.5 font-mono whitespace-nowrap text-muted-foreground">
                        {c.before} <span aria-label="to">→</span> <span className="text-foreground">{c.after}</span>
                      </td>
                      <td className={cn('px-3.5 py-2.5 text-right font-mono whitespace-nowrap', pct.startsWith('-') ? 'text-change' : 'text-soft')}>
                        {pct}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {warning && (
          <div className="mx-6 mt-4 rounded-xl border border-warn-border bg-warn px-3.5 py-3 text-[13px] leading-normal text-warn-foreground sm:mx-7">
            {warning}
          </div>
        )}
        {note && (
          <div className="mx-6 mt-4 rounded-xl bg-info px-3.5 py-3 text-[13px] leading-normal text-info-foreground sm:mx-7">
            {note}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2.5 px-6 pt-5 pb-6 sm:px-7">
          {canDownload && (
            <Button
              variant="link"
              className="mr-auto px-0"
              onClick={() => (onDownloadPlan ? onDownloadPlan() : downloadCsv(changes, planSubject ?? 'changes'))}
            >
              Download plan
            </Button>
          )}
          <Button variant="outline" size="lg" onClick={() => onOpenChange(false)} disabled={applying}>
            Cancel
          </Button>
          <Button size="lg" onClick={onApply} disabled={applying || applyDisabled || n === 0}>
            {applying && <Loader2 className="animate-spin" aria-hidden="true" />}
            Apply {n} {n === 1 ? 'change' : 'changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
