'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { ROUTES } from '@/config/site';

const GROUPS = [
  {
    title: 'Setup guide',
    items: [
      { label: 'Overview', href: '/setup-guide' },
      { label: 'App Store Connect', href: '/setup-guide/apple' },
      { label: 'Google Play', href: '/setup-guide/google' },
    ],
  },
  {
    title: 'Next',
    items: [
      { label: 'Connect a store', href: ROUTES.setup },
      { label: 'Index checker', href: ROUTES.indexChecker },
      { label: 'Docs', href: ROUTES.docs },
    ],
  },
] as const;

/** The docs-style side navigation for the setup guide pages. */
export function GuideNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Setup guide" className="text-[15px]">
      {GROUPS.map((g) => (
        <div key={g.title} className="mb-6 last:mb-0">
          <p className="mb-2 text-[13px] font-bold text-foreground">{g.title}</p>
          <ul className="space-y-0.5">
            {g.items.map((item) => {
              const current = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'block rounded-lg px-2.5 py-1.5 transition-colors',
                      current ? 'bg-accent font-semibold text-accent-foreground' : 'text-soft hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
