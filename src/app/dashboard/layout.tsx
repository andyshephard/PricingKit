'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Sidebar, Footer } from '@/components/layout';
import { useAuthStore } from '@/store/auth-store';
import { isPlatformRoute } from '@/lib/utils/platform-routes';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const isGoogleAuthenticated = useAuthStore(
    (state) => state.isGoogleAuthenticated
  );
  const isAppleAuthenticated = useAuthStore(
    (state) => state.isAppleAuthenticated
  );
  const clearAuth = useAuthStore((state) => state.clearAuth);
  const setGoogleAuthenticated = useAuthStore(
    (state) => state.setGoogleAuthenticated
  );
  const setAppleAuthenticated = useAuthStore(
    (state) => state.setAppleAuthenticated
  );
  const [isVerifying, setIsVerifying] = useState(true);

  // Use refs to track auth verification state and previous values
  // This prevents the useEffect from re-running when store values change
  const hasVerifiedAuth = useRef(false);
  const prevBundleId = useRef<string | null>(null);
  const prevPackageName = useRef<string | null>(null);

  useEffect(() => {
    // Only verify auth once on mount
    if (hasVerifiedAuth.current) return;
    hasVerifiedAuth.current = true;

    // Verify auth with server on mount
    async function verifyAuth() {
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

        let hasValidAuth = false;

        // Sync Google auth state
        if (googleData.authenticated) {
          // Invalidate queries if packageName changed (prevents stale data)
          if (prevPackageName.current && prevPackageName.current !== googleData.packageName) {
            queryClient.invalidateQueries();
          }
          prevPackageName.current = googleData.packageName;
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
          if (prevBundleId.current && prevBundleId.current !== appleData.bundleId) {
            queryClient.invalidateQueries();
          }
          prevBundleId.current = appleData.bundleId;
          setAppleAuthenticated({
            bundleId: appleData.bundleId,
            keyId: appleData.keyId,
            issuerId: appleData.issuerId,
          });
          hasValidAuth = true;
        }

        if (hasValidAuth) {
          setIsVerifying(false);
        } else {
          // No valid auth - clear client state and redirect
          console.log('No valid authentication, redirecting to home');
          clearAuth();
          router.push('/');
        }
      } catch (error) {
        console.error('Auth verification failed:', error);
        clearAuth();
        router.push('/');
      }
    }

    verifyAuth();
  }, [
    clearAuth,
    setGoogleAuthenticated,
    setAppleAuthenticated,
    router,
    queryClient,
  ]);

  if (isVerifying) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isGoogleAuthenticated && !isAppleAuthenticated) {
    return null;
  }

  // Check if we're on a platform-specific route - if so, show sidebar
  // If we're on the root /dashboard (platform selector), don't show sidebar
  const showSidebar = isPlatformRoute(pathname) || pathname.startsWith('/dashboard/settings');

  if (!showSidebar) {
    // Platform selector page doesn't need sidebar
    return (
      <main className="h-screen overflow-auto flex flex-col">
        <div className="flex-1">{children}</div>
        <Footer />
      </main>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-auto flex flex-col">
        <div className="flex-1">{children}</div>
        <Footer />
      </main>
    </div>
  );
}
