'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Home } from 'lucide-react';
import { getPlatformFromPath } from '@/lib/utils/platform-routes';
import { cn } from '@/lib/utils';

const pathNames: Record<string, string> = {
  dashboard: 'Dashboard',
  google: 'Google Play',
  apple: 'App Store',
  products: 'In-app purchases',
  subscriptions: 'Subscriptions',
  'app-price': 'App price',
  settings: 'Settings',
};

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);
  const currentPlatform = getPlatformFromPath(pathname);

  if (segments.length === 0) return null;

  // Determine home link based on current platform
  const homeHref = currentPlatform ? `/dashboard/${currentPlatform}` : '/dashboard';

  const breadcrumbs = segments.map((segment, index) => {
    const href = '/' + segments.slice(0, index + 1).join('/');
    const isLast = index === segments.length - 1;
    const name = pathNames[segment] || decodeURIComponent(segment);

    return {
      name,
      href,
      isLast,
    };
  });

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 overflow-hidden text-sm">
      <Link
        href={homeHref}
        aria-label="Overview"
        className="rounded-md text-muted-foreground hover:text-foreground transition-colors"
      >
        <Home className="h-4 w-4" aria-hidden="true" />
      </Link>

      {breadcrumbs.map((crumb, index) => (
        // Phones show only the last two levels
        <span key={crumb.href} className={cn('flex min-w-0 items-center gap-1', index < breadcrumbs.length - 2 && 'hidden sm:flex')}>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {crumb.isLast ? (
            <span aria-current="page" className="truncate font-semibold">{crumb.name}</span>
          ) : (
            <Link
              href={crumb.href}
              className="truncate rounded-md text-muted-foreground hover:text-foreground transition-colors"
            >
              {crumb.name}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
