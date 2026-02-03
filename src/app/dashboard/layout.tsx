'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Sidebar } from '@/components/layout';
import { useAuthStore } from '@/store/auth-store';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isGoogleAuthenticated = useAuthStore(
    (state) => state.isGoogleAuthenticated
  );
  const isAppleAuthenticated = useAuthStore(
    (state) => state.isAppleAuthenticated
  );
  const platform = useAuthStore((state) => state.platform);
  const clearAuth = useAuthStore((state) => state.clearAuth);
  const setGoogleAuthenticated = useAuthStore(
    (state) => state.setGoogleAuthenticated
  );
  const setAppleAuthenticated = useAuthStore(
    (state) => state.setAppleAuthenticated
  );
  const setPlatform = useAuthStore((state) => state.setPlatform);
  const currentBundleId = useAuthStore((state) => state.bundleId);
  const currentPackageName = useAuthStore((state) => state.packageName);
  const [isVerifying, setIsVerifying] = useState(true);

  useEffect(() => {
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
        let defaultPlatform: 'google' | 'apple' | null = null;

        // Sync Google auth state
        if (googleData.authenticated) {
          // Invalidate queries if packageName changed (prevents stale data)
          if (currentPackageName && currentPackageName !== googleData.packageName) {
            queryClient.invalidateQueries();
          }
          setGoogleAuthenticated({
            packageName: googleData.packageName,
            projectId: googleData.projectId,
            clientEmail: googleData.clientEmail,
          });
          hasValidAuth = true;
          defaultPlatform = 'google';
        }

        // Sync Apple auth state
        if (appleData.authenticated) {
          // Invalidate queries if bundleId changed (prevents stale data)
          if (currentBundleId && currentBundleId !== appleData.bundleId) {
            queryClient.invalidateQueries();
          }
          setAppleAuthenticated({
            bundleId: appleData.bundleId,
            keyId: appleData.keyId,
            issuerId: appleData.issuerId,
          });
          hasValidAuth = true;
          // Prefer Apple if Google not connected, or keep current platform
          if (!defaultPlatform) {
            defaultPlatform = 'apple';
          }
        }

        if (hasValidAuth) {
          // Set platform if not already set
          if (!platform && defaultPlatform) {
            setPlatform(defaultPlatform);
          }
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
    setPlatform,
    platform,
    router,
    queryClient,
    currentBundleId,
    currentPackageName,
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

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
