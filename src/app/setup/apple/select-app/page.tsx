'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAppleApps } from '@/hooks/use-apple-apps';
import { useSetActiveApp } from '@/hooks/use-set-active-app';
import { useAuthStore, useHasHydrated } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SiteHeader } from '@/components/site/site-header';

export default function SelectAppleAppPage() {
  const router = useRouter();
  const hasHydrated = useHasHydrated();
  const isAppleAuthenticated = useAuthStore((s) => s.isAppleAuthenticated);
  const { data: apps, isLoading, error, refetch } = useAppleApps();
  const setActive = useSetActiveApp();

  useEffect(() => {
    if (hasHydrated && !isAppleAuthenticated) {
      router.replace('/setup');
    }
  }, [hasHydrated, isAppleAuthenticated, router]);

  const handlePick = async (bundleId: string) => {
    try {
      await setActive.mutateAsync({ platform: 'apple', bundleId });
      router.push('/dashboard/apple');
    } catch (err) {
      console.error('Failed to set active app', err);
    }
  };

  if (!hasHydrated || isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader compact />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-8 sm:py-[72px]">
        <h1 className="text-center text-[32px] leading-tight font-extrabold tracking-[-0.02em] sm:text-4xl">
          Choose an app
        </h1>
        <p className="mx-auto mt-3 max-w-[520px] text-center text-[17px] leading-relaxed text-soft">
          Pick the app whose prices you want to manage. You can switch later from the sidebar.
        </p>
        <Card className="mt-10">
          <CardContent>
            {error && (
              <div role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {error instanceof Error ? error.message : 'Failed to load apps.'}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-2"
                  onClick={() => refetch()}
                >
                  Retry
                </Button>
              </div>
            )}

            {apps && apps.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No apps found for this API key. Verify the key has at least one
                app assigned in App Store Connect → Users and Access.
              </p>
            )}

            <ul className="divide-y divide-line">
              {apps?.map((app) => (
                <li key={app.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent font-extrabold text-accent-foreground"
                    >
                      {app.name.trim().charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-bold">{app.name}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{app.bundleId}</p>
                    </div>
                  </div>
                  <Button
                    onClick={() => handlePick(app.bundleId)}
                    disabled={setActive.isPending}
                    size="sm"
                    aria-label={`Select ${app.name}`}
                  >
                    Select
                  </Button>
                </li>
              ))}
            </ul>

            {setActive.isError && (
              <p className="mt-3 text-sm text-destructive">
                {setActive.error instanceof Error
                  ? setActive.error.message
                  : 'Failed to set active app.'}
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
