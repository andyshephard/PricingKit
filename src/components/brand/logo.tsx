import Link from 'next/link';
import { cn } from '@/lib/utils';

/** The PricingKit globe mark. Decorative: the wordmark beside it names it. */
export function GlobeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className={cn('size-5 text-primary', className)}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </svg>
  );
}

/** The mark and wordmark as a link, home by default. */
export function Logo({
  href = '/',
  className,
  suffix,
}: {
  href?: string;
  className?: string;
  suffix?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center gap-2.5 rounded-md text-[17px] font-extrabold tracking-tight text-foreground',
        className
      )}
    >
      <GlobeMark className="size-[22px]" />
      <span>
        PricingKit
        {suffix && <span className="ml-1.5 font-medium text-muted-foreground">{suffix}</span>}
      </span>
    </Link>
  );
}
