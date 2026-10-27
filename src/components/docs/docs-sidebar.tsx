'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DocsNavGroup {
  title: string;
  links: Array<{ href: string; label: string }>;
}

/**
 * The docs navigation: groups of page links, the current page highlighted.
 * Below the lg breakpoint it folds behind a "Docs menu" button.
 */
export function DocsSidebar({ groups }: { groups: DocsNavGroup[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = pathname.replace(/\/$/, '') || '/docs';
  const currentLabel = groups.flatMap((g) => g.links).find((l) => l.href === current)?.label;

  return (
    <aside className="border-b bg-docs-aside lg:w-[272px] lg:shrink-0 lg:border-r lg:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3 sm:px-6 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls="docs-nav"
          className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-card px-3.5 py-2 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {open ? <X className="size-4" aria-hidden="true" /> : <Menu className="size-4" aria-hidden="true" />}
          Docs menu
        </button>
        {currentLabel && <span className="min-w-0 truncate text-sm text-muted-foreground">{currentLabel}</span>}
      </div>
      <nav
        id="docs-nav"
        aria-label="Docs"
        className={cn('px-4 pb-6 text-[15px] sm:px-6 lg:sticky lg:top-0 lg:block lg:max-h-screen lg:overflow-y-auto lg:py-8', open ? 'block' : 'hidden')}
      >
        {groups.map((g) => (
          <div key={g.title} className="mb-6 last:mb-0">
            <p className="mb-2 px-2.5 text-[13px] font-bold text-foreground">{g.title}</p>
            <ul>
              {g.links.map((l) => {
                const isCurrent = l.href === current;
                return (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      onClick={() => setOpen(false)}
                      aria-current={isCurrent ? 'page' : undefined}
                      className={cn(
                        'block rounded-lg px-2.5 py-1.5 transition-colors',
                        isCurrent ? 'bg-accent font-semibold text-accent-foreground' : 'text-soft hover:bg-accent/60 hover:text-foreground'
                      )}
                    >
                      {l.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
