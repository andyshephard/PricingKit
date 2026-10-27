'use client';

import Link from 'next/link';
import { useAuthStore, useHasHydrated } from '@/store/auth-store';
import { ROUTES } from '@/config/site';

/**
 * "Open the app": the dashboard for someone already connected, otherwise the
 * connect screen. It renders the connect link until the store has hydrated,
 * so server and client markup match.
 */
export function OpenAppLink({ className, children = 'Open the app' }: { className?: string; children?: React.ReactNode }) {
  const hydrated = useHasHydrated();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const href = hydrated && isAuthenticated ? ROUTES.dashboard : ROUTES.setup;
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
