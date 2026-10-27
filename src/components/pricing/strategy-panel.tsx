import { cn } from '@/lib/utils';

const STRATEGIES = ['PPP', 'Big Mac', 'Netflix', 'Direct', 'Custom'] as const;

/** A side-panel card: Atlas card chrome with a heading. */
export function PanelCard({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('min-w-0 rounded-2xl border bg-card p-5', className)}>
      <div className="mb-3.5 flex items-center gap-2">
        <h2 className="flex-1 text-[17px] font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A note in the Atlas info style (existing subscribers, effective dates…). */
export function InfoNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl bg-info px-3.5 py-3 text-[13px] leading-normal text-info-foreground', className)}>
      {children}
    </div>
  );
}

/**
 * The Strategy panel beside a price table. Choosing the strategy, base price
 * and countries happens in the existing pricing dialog, which `children`
 * (the action buttons) opens; the panel explains it and carries the note
 * about existing subscribers.
 */
export function StrategyPanel({ note, children }: { note: React.ReactNode; children: React.ReactNode }) {
  return (
    <PanelCard title="Strategy">
      <ul aria-label="Available strategies" className="flex flex-wrap gap-2">
        {STRATEGIES.map((s) => (
          <li key={s} className="rounded-full bg-chip px-3 py-1.5 text-[13px] text-chip-foreground">
            {s}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm leading-relaxed text-soft">
        Pick a strategy and a base price. PricingKit works out every country, snaps each price to a real store price
        point and shows you the changes before anything is applied.
      </p>
      <InfoNote className="mt-3.5">{note}</InfoNote>
      <div className="mt-4 flex flex-col gap-2">{children}</div>
    </PanelCard>
  );
}

/** Label/value rows for a details card. */
export function DetailList({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[13px] text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 truncate font-semibold">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
