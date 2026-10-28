'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Sidebar, Footer } from '@/components/layout';
import { useAuthStore, useHasHydrated } from '@/store/auth-store';
import { isPlatformRoute } from '@/lib/utils/platform-routes';
import { browserKeys } from '@/lib/web/client';
import type { KeyInfo } from '@/lib/browser-keys';

/** The stored key's ids for a platform, or null (none stored, or storage unavailable) */
async function storedKey(platform: 'apple' | 'google'): Promise<KeyInfo | null> {
  try {
    return await browserKeys().info(platform);
  } catch {
    return null;
  }
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const hasHydrated = useHasHydrated();
  const [isVerifying, setIsVerifying] = useState(true);

  // The gate is client-side: the dashboard opens when this browser holds a
  // store key (IndexedDB). There is no server session to check; every API
  // call carries a fresh token, and the store refuses a bad one.
  useEffect(() => {
    if (!hasHydrated) return;
    let cancelled = false;

    (async () => {
      const [apple, google] = await Promise.all([storedKey('apple'), storedKey('google')]);
      if (cancelled) return;
      const store = useAuthStore.getState();

      let hasGoogle = false;
      if (google?.platform === 'google' && store.packageName) {
        store.setGoogleAuthenticated({ packageName: store.packageName, projectId: google.projectId, clientEmail: google.clientEmail });
        hasGoogle = true;
      } else if (store.isGoogleAuthenticated) {
        store.clearGoogleAuth();
      }

      let hasApple = false;
      if (apple?.platform === 'apple') {
        store.setAppleAuthenticated({ bundleId: store.bundleId, keyId: apple.keyId, issuerId: apple.issuerId });
        hasApple = true;
      } else if (store.isAppleAuthenticated) {
        store.clearAppleAuth();
      }

      if (!hasGoogle && !hasApple) {
        useAuthStore.getState().clearAuth();
        router.push('/setup');
        return;
      }
      // An Apple key but no app picked yet: the selector first
      if (hasApple && !useAuthStore.getState().bundleId && (useAuthStore.getState().platform === 'apple' || !hasGoogle)) {
        router.replace('/setup/apple/select-app');
        return;
      }
      setIsVerifying(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [hasHydrated, router]);

  if (!hasHydrated || isVerifying) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Check if we're on a platform-specific route - if so, show sidebar
  // If we're on the root /dashboard (platform selector), don't show sidebar
  const showSidebar = isPlatformRoute(pathname) || pathname.startsWith('/dashboard/settings');

  if (!showSidebar) {
    // Platform selector page doesn't need sidebar
    return (
      <main className="flex min-h-screen flex-col bg-background">
        <div className="flex-1">{children}</div>
        <Footer />
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background md:h-screen md:flex-row md:overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col md:overflow-auto">
        <div className="flex-1">{children}</div>
        <Footer />
      </main>
    </div>
  );
}
