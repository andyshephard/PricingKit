'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Sidebar, Footer } from '@/components/layout';
import { DASHBOARD_AUTH_VERIFIED_KEY, useAuthStore, useHasHydrated } from '@/store/auth-store';
import { isPlatformRoute } from '@/lib/utils/platform-routes';

const AUTH_VERIFIED_KEY = DASHBOARD_AUTH_VERIFIED_KEY;

let prevBundleId: string | null = null;
let prevPackageName: string | null = null;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const hasHydrated = useHasHydrated();
  const clearAuth = useAuthStore((state) => state.clearAuth);
  const setGoogleAuthenticated = useAuthStore(
    (state) => state.setGoogleAuthenticated
  );
  const setAppleAuthenticated = useAuthStore(
    (state) => state.setAppleAuthenticated
  );
  const [isVerifying, setIsVerifying] = useState(true);

  useEffect(() => {
    if (!hasHydrated) return;

    // Check sessionStorage for prior verification (survives HMR, resets on full reload)
    if (typeof window !== 'undefined' && sessionStorage.getItem(AUTH_VERIFIED_KEY) === 'true') {
      setIsVerifying(false);
      return;
    }

    let cancelled = false;

    // Verify auth with server on mount
    (async () => {
      try {
        // Check both platforms in parallel
        const [googleResponse, appleResponse] = await Promise.all([
          fetch('/api/auth'),
          fetch('/api/apple/auth'),
        ]);

        const [googleData, appleData] = await Promise.all([
          googleResponse.json(),
          appleResponse.json(),
        ]);

        if (cancelled) return;

        let hasValidAuth = false;

        // Sync Google auth state
        if (googleData.authenticated) {
          // Invalidate queries if packageName changed (prevents stale data)
          if (prevPackageName && prevPackageName !== googleData.packageName) {
            queryClient.invalidateQueries();
          }
          prevPackageName = googleData.packageName;
          setGoogleAuthenticated({
            packageName: googleData.packageName,
            projectId: googleData.projectId,
            clientEmail: googleData.clientEmail,
          });
          hasValidAuth = true;
        }

        // Sync Apple auth state
        if (appleData.authenticated) {
          // Invalidate queries if bundleId changed (prevents stale data)
          if (prevBundleId && prevBundleId !== appleData.bundleId) {
            queryClient.invalidateQueries();
          }
          prevBundleId = appleData.bundleId ?? null;
          setAppleAuthenticated({
            bundleId: appleData.bundleId ?? null,
            keyId: appleData.keyId ?? '',
            issuerId: appleData.issuerId ?? '',
          });
          hasValidAuth = true;

          // Authenticated but no app picked yet → force the selector
          if (!appleData.bundleId) {
            if (typeof window !== 'undefined') {
              sessionStorage.removeItem(AUTH_VERIFIED_KEY);
            }
            router.replace('/setup/apple/select-app');
            return;
          }
        }

        if (hasValidAuth) {
          if (typeof window !== 'undefined') {
            sessionStorage.setItem(AUTH_VERIFIED_KEY, 'true');
          }
          setIsVerifying(false);
        } else {
          // No valid auth - clear client state and redirect
          console.log('No valid authentication, redirecting to home');
          clearAuth();
          router.push('/setup');
        }
      } catch (error) {
        console.error('Auth verification failed:', error);
        if (!cancelled) {
          clearAuth();
          router.push('/');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasHydrated]);

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
