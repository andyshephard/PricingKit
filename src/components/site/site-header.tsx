import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { GITHUB_URL, ROUTES } from '@/config/site';
import { cn } from '@/lib/utils';
import { OpenAppLink } from './open-app-link';

export const pillPrimary =
  'inline-flex items-center justify-center gap-2 rounded-full bg-primary px-[18px] py-2.5 text-[15px] font-bold text-primary-foreground transition-colors hover:bg-primary/90';
export const pillSecondary =
  'inline-flex items-center justify-center gap-2 rounded-full border border-line-strong bg-card px-[22px] py-[13px] font-semibold text-foreground transition-colors hover:bg-accent hover:text-accent-foreground';

const navLink = 'rounded-md text-[15px] text-soft transition-colors hover:text-foreground';

/**
 * The public header: landing, connect, index checker and setup guides.
 * `compact` swaps the marketing links for setup help on task screens.
 */
export function SiteHeader({ compact = false, current }: { compact?: boolean; current?: 'docs' | 'index-checker' | 'setup-guide' }) {
  return (
    <header className="border-b bg-header">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-8 sm:py-[18px]"
      >
        <Logo className="text-lg" />
        {compact ? (
          <div className="flex flex-1 flex-wrap items-center justify-end gap-x-5 gap-y-2 text-sm">
            <Link href={ROUTES.setupGuide} className={cn(navLink, 'text-sm')} aria-current={current === 'setup-guide' ? 'page' : undefined}>
              Setup guide
            </Link>
            <Link href={ROUTES.docs} className={cn(navLink, 'text-sm')}>
              Docs
            </Link>
            <ThemeToggle />
          </div>
        ) : (
          <>
            <ul className="order-last flex w-full flex-wrap gap-x-6 gap-y-2 md:order-none md:w-auto md:flex-1">
              <li>
                <Link href={ROUTES.docs} className={navLink} aria-current={current === 'docs' ? 'page' : undefined}>
                  Docs
                </Link>
              </li>
              <li>
                <Link href="/#how-it-works" className={navLink}>
                  How it works
                </Link>
              </li>
              <li>
                <Link
                  href={ROUTES.indexChecker}
                  className={cn(navLink, current === 'index-checker' && 'font-semibold text-foreground')}
                  aria-current={current === 'index-checker' ? 'page' : undefined}
                >
                  Index checker
                </Link>
              </li>
            </ul>
            <div className="ml-auto flex items-center gap-4 sm:gap-6 md:ml-0">
              <ThemeToggle />
              <a href={GITHUB_URL} className={cn(navLink, 'hidden sm:inline')} rel="noopener noreferrer">
                GitHub
              </a>
              <OpenAppLink className={pillPrimary} />
            </div>
          </>
        )}
      </nav>
    </header>
  );
}
