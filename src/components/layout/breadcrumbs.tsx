'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Home } from 'lucide-react';
import { getPlatformFromPath } from '@/lib/utils/platform-routes';

const pathNames: Record<string, string> = {
  dashboard: 'Dashboard',
  google: 'Google Play',
  apple: 'App Store',
  products: 'Products',
  subscriptions: 'Subscriptions',
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
    <nav className="flex items-center gap-1 text-sm">
      <Link
        href={homeHref}
        className="text-muted-foreground hover:text-foreground transition-colors"
      >
        <Home className="h-4 w-4" />
      </Link>

      {breadcrumbs.map((crumb) => (
        <span key={crumb.href} className="flex items-center gap-1">
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          {crumb.isLast ? (
            <span className="font-medium">{crumb.name}</span>
          ) : (
            <Link
              href={crumb.href}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {crumb.name}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
