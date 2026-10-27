'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { useAuthStore } from '@/store/auth-store';

// Platform icons as SVG components
function GooglePlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 0 1-.61-.92V2.734a1 1 0 0 1 .609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.198l2.807 1.626a1 1 0 0 1 0 1.73l-2.808 1.626L15.206 12l2.492-2.491zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z" />
    </svg>
  );
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

/** Shown at /dashboard when both stores are connected. */
export function PlatformChooser() {
  const router = useRouter();
  const isGoogleAuthenticated = useAuthStore((state) => state.isGoogleAuthenticated);
  const isAppleAuthenticated = useAuthStore((state) => state.isAppleAuthenticated);
  const packageName = useAuthStore((state) => state.packageName);
  const bundleId = useAuthStore((state) => state.bundleId);

  useEffect(() => {
    // Auto-redirect based on authentication state
    if (isGoogleAuthenticated && !isAppleAuthenticated) {
      router.replace('/dashboard/google');
    } else if (isAppleAuthenticated && !isGoogleAuthenticated) {
      router.replace('/dashboard/apple');
    }
    // If both or neither are authenticated, show the selector
  }, [isGoogleAuthenticated, isAppleAuthenticated, router]);

  // If only one platform is authenticated, we'll redirect (handled by useEffect above)
  // Show nothing while redirecting to avoid flash
  if ((isGoogleAuthenticated && !isAppleAuthenticated) || (isAppleAuthenticated && !isGoogleAuthenticated)) {
    return null;
  }

  // If neither is authenticated, redirect to home
  if (!isGoogleAuthenticated && !isAppleAuthenticated) {
    router.replace('/');
    return null;
  }

  // Both platforms are authenticated - show the platform selector
  const stores = [
    { href: '/dashboard/apple', name: 'App Store', id: bundleId, icon: AppleIcon, body: 'In-app purchases and subscriptions on the Apple App Store.' },
    { href: '/dashboard/google', name: 'Google Play', id: packageName, icon: GooglePlayIcon, body: 'In-app products and subscriptions on Google Play.' },
  ];
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-header px-4 py-3 sm:px-8">
        <Logo href="/dashboard" />
        <ThemeToggle />
      </header>

      <div className="flex flex-1 items-center justify-center px-4 py-16 sm:px-8">
        <div className="w-full max-w-[920px]">
          <h1 className="text-center text-[32px] font-extrabold tracking-[-0.02em] sm:text-4xl">Choose a store</h1>
          <p className="mx-auto mt-3 max-w-[560px] text-center text-[17px] leading-relaxed text-soft">
            Both stores are connected. Pick the one to work on; you can switch from the sidebar at any time.
          </p>
          <ul className="mt-10 grid gap-5 md:grid-cols-2">
            {stores.map((store) => (
              <li key={store.href}>
                <Link
                  href={store.href}
                  className="group flex h-full items-start gap-4 rounded-2xl border bg-card p-6 transition-colors hover:border-primary sm:p-7"
                >
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                    <store.icon className="size-6" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[22px] font-bold">{store.name}</span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{store.id}</span>
                    <span className="mt-3 block text-[15px] leading-relaxed text-soft">{store.body}</span>
                  </span>
                  <ChevronRight className="mt-1 size-5 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
