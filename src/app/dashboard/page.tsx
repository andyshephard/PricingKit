'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useAuthStore } from '@/store/auth-store';

// Platform icons as SVG components
function GooglePlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 0 1-.61-.92V2.734a1 1 0 0 1 .609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.198l2.807 1.626a1 1 0 0 1 0 1.73l-2.808 1.626L15.206 12l2.492-2.491zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z" />
    </svg>
  );
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

export default function DashboardPage() {
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
  return (
    <div className="flex flex-col h-full">
      <div className="flex h-14 items-center border-b px-6">
        <span className="font-semibold">PricingKit</span>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-2xl w-full space-y-6">
          <div className="text-center">
            <h1 className="text-3xl font-bold">Select Platform</h1>
            <p className="text-muted-foreground mt-2">
              Choose which platform dashboard you&apos;d like to manage
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Link href="/dashboard/google">
              <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                      <GooglePlayIcon className="h-6 w-6 text-primary" />
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-lg">Google Play</CardTitle>
                      <CardDescription className="font-mono text-xs">
                        {packageName}
                      </CardDescription>
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    Manage in-app products and subscriptions for the Google Play Store
                  </p>
                </CardContent>
              </Card>
            </Link>

            <Link href="/dashboard/apple">
              <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                      <AppleIcon className="h-6 w-6 text-primary" />
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-lg">App Store</CardTitle>
                      <CardDescription className="font-mono text-xs">
                        {bundleId}
                      </CardDescription>
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    Manage in-app purchases and subscriptions for the Apple App Store
                  </p>
                </CardContent>
              </Card>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
