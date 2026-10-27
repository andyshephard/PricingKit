'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { ROUTES } from '@/config/site';
import { useAuthStore } from '@/store/auth-store';
import { PlatformSelector } from './platform-selector';
import { AppSwitcher } from './app-switcher';
import { getPlatformFromPath, type Platform } from '@/lib/utils/platform-routes';

interface NavItem {
  name: string;
  href: string;
  /** Only this exact path counts as current (section roots). */
  exact?: boolean;
}

function pricingItems(platform: Platform | null): NavItem[] {
  if (!platform) return [{ name: 'Overview', href: ROUTES.dashboard, exact: true }];
  const base = `/dashboard/${platform}`;
  const items: NavItem[] = [
    { name: 'Overview', href: base, exact: true },
    { name: 'Subscriptions', href: `${base}/subscriptions` },
    { name: 'In-app purchases', href: `${base}/products` },
  ];
  if (platform === 'apple') items.push({ name: 'App price', href: `${base}/app-price` });
  return items;
}

const TOOL_ITEMS: NavItem[] = [
  { name: 'Index checker', href: ROUTES.indexChecker },
  { name: 'Settings', href: ROUTES.settings },
  { name: 'Docs', href: ROUTES.docs },
];

function isCurrent(pathname: string, item: NavItem) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * The app shell's sidebar: logo, theme toggle, app switcher, then Pricing and
 * Tools. On phones it stacks above the page and the navigation folds behind
 * a Menu button.
 */
export function Sidebar() {
  const pathname = usePathname();
  const storePlatform = useAuthStore((s) => s.platform);
  // Settings has no platform in its path: keep the last store's links.
  const currentPlatform = getPlatformFromPath(pathname);
  const navPlatform = currentPlatform ?? storePlatform;
  const [open, setOpen] = useState(false);

  const group = (label: string, items: NavItem[]) => (
    <div className="mt-5 first:mt-0">
      <p className="mx-2 mb-1.5 text-xs font-bold text-muted-foreground">{label}</p>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const current = isCurrent(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                onClick={() => setOpen(false)}
                className={cn(
                  'block rounded-lg px-2.5 py-2 text-sm transition-colors',
                  current
                    ? 'bg-sidebar-accent font-bold text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {item.name}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <aside className="flex shrink-0 flex-col border-b bg-sidebar md:h-full md:w-[260px] md:border-r md:border-b-0">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3 md:px-5 md:pt-5">
        <Logo href={ROUTES.dashboard} />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-full border border-line-strong text-soft hover:bg-accent hover:text-accent-foreground md:hidden"
            aria-expanded={open}
            aria-controls="app-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="size-4" aria-hidden="true" /> : <Menu className="size-4" aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div className="px-4 pb-3 md:px-4">
        <AppSwitcher />
      </div>

      <nav
        id="app-nav"
        aria-label="App"
        className={cn('flex-1 overflow-y-auto px-4 pt-2 pb-5 md:block', open ? 'block' : 'hidden')}
      >
        {group('Pricing', pricingItems(navPlatform))}
        {group('Tools', TOOL_ITEMS)}
        <div className="mt-6 border-t border-line pt-4">
          <PlatformSelector currentPlatform={currentPlatform} />
        </div>
      </nav>
    </aside>
  );
}
