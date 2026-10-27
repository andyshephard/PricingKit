'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronsUpDown, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useAuthStore } from '@/store/auth-store';
import { useAppleApps } from '@/hooks/use-apple-apps';
import { useSetActiveApp } from '@/hooks/use-set-active-app';
import { AddGoogleAppModal } from './add-google-app-modal';

export function AppSwitcher() {
  const platform = useAuthStore((s) => s.platform);
  const isAppleAuthenticated = useAuthStore((s) => s.isAppleAuthenticated);
  const isGoogleAuthenticated = useAuthStore((s) => s.isGoogleAuthenticated);
  const activeBundleId = useAuthStore((s) => s.bundleId);
  const activePackageName = useAuthStore((s) => s.packageName);
  const googleAppHistory = useAuthStore((s) => s.googleAppHistory);
  const removeGoogleAppFromHistory = useAuthStore(
    (s) => s.removeGoogleAppFromHistory
  );
  const clientEmail = useAuthStore((s) => s.clientEmail);

  const setActive = useSetActiveApp();
  const appleApps = useAppleApps();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // Hide entirely if neither platform is connected.
  if (!isAppleAuthenticated && !isGoogleAuthenticated) return null;

  const triggerLabel = (() => {
    if (platform === 'apple') {
      const name =
        appleApps.data?.find((a) => a.bundleId === activeBundleId)?.name ??
        activeBundleId ??
        'Select app';
      return { name, store: 'App Store' };
    }
    if (platform === 'google') {
      return { name: activePackageName ?? 'Select app', store: 'Google Play' };
    }
    return { name: 'Select app', store: null };
  })();

  const handlePickApple = async (bundleId: string) => {
    try {
      await setActive.mutateAsync({ platform: 'apple', bundleId });
      setOpen(false);
      router.push('/dashboard/apple');
    } catch (err) {
      console.error(err);
    }
  };

  const handlePickGoogle = async (packageName: string) => {
    try {
      await setActive.mutateAsync({ platform: 'google', packageName });
      setOpen(false);
      router.push('/dashboard/google');
    } catch (err) {
      console.error(err);
    }
  };

  // Only show Google entries belonging to the currently authenticated client_email.
  const googleEntries = clientEmail
    ? googleAppHistory.filter((entry) => entry.clientEmail === clientEmail)
    : googleAppHistory;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Current app: ${triggerLabel.name}${triggerLabel.store ? `, ${triggerLabel.store}` : ''}. Switch app`}
            className="flex w-full items-center gap-2.5 rounded-xl border bg-background p-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span
              aria-hidden="true"
              className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-accent font-extrabold text-accent-foreground"
            >
              {triggerLabel.name.trim().charAt(0).toUpperCase() || '?'}
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm">{triggerLabel.name}</strong>
              {triggerLabel.store && (
                <span className="block truncate text-xs text-muted-foreground">{triggerLabel.store}</span>
              )}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <div className="max-h-96 overflow-auto py-1">
            {isAppleAuthenticated && (
              <div>
                <div className="flex items-center justify-between px-3 pt-2 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Apple App Store
                  </span>
                  <button
                    type="button"
                    aria-label="Refresh Apple apps list"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      appleApps.refetch();
                    }}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                </div>
                {appleApps.isLoading && (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading apps…
                  </div>
                )}
                {appleApps.error && (
                  <div className="px-3 py-2 text-sm text-destructive">
                    {appleApps.error instanceof Error
                      ? appleApps.error.message
                      : 'Failed to load apps.'}
                  </div>
                )}
                {!appleApps.isLoading && appleApps.data?.length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No apps found.
                  </div>
                )}
                {appleApps.data?.map((app) => {
                  const isActive =
                    platform === 'apple' && app.bundleId === activeBundleId;
                  return (
                    <button
                      key={`apple-${app.id}`}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                      onClick={() => handlePickApple(app.bundleId)}
                      disabled={setActive.isPending}
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{app.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {app.bundleId}
                        </p>
                      </div>
                      {isActive && <Check className="h-4 w-4 text-primary shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}

            {isAppleAuthenticated && isGoogleAuthenticated && (
              <div className="my-1 border-t" />
            )}

            {isGoogleAuthenticated && (
              <div>
                <div className="px-3 pt-2 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Google Play
                  </span>
                </div>
                {googleEntries.length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No saved apps yet.
                  </div>
                )}
                {googleEntries.map((entry) => {
                  const isActive =
                    platform === 'google' &&
                    entry.packageName === activePackageName;
                  return (
                    <div
                      key={`google-${entry.packageName}-${entry.clientEmail}`}
                      className="group flex w-full items-center justify-between gap-2 px-3 py-2 hover:bg-muted"
                    >
                      <button
                        type="button"
                        className="flex-1 min-w-0 text-left text-sm disabled:opacity-50"
                        onClick={() => handlePickGoogle(entry.packageName)}
                        disabled={setActive.isPending}
                      >
                        <p className="truncate font-medium">{entry.packageName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {entry.clientEmail}
                        </p>
                      </button>
                      {isActive ? (
                        <Check className="h-4 w-4 text-primary shrink-0" />
                      ) : (
                        <button
                          type="button"
                          aria-label={`Remove ${entry.packageName} from history`}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeGoogleAppFromHistory(
                              entry.packageName,
                              entry.clientEmail
                            );
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setShowAddModal(true);
                    setOpen(false);
                  }}
                >
                  <Plus className="h-3 w-3" /> Add Google app
                </button>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {isGoogleAuthenticated && (
        <AddGoogleAppModal
          open={showAddModal}
          onOpenChange={setShowAddModal}
        />
      )}
    </>
  );
}
