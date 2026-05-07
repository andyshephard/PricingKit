'use client';

import { useState } from 'react';
import { Check, ChevronsUpDown, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth-store';
import { useAppleApps } from '@/hooks/use-apple-apps';
import { useSetActiveApp } from '@/hooks/use-set-active-app';
import { AddGoogleAppModal } from './add-google-app-modal';

export function AppSwitcher() {
  const platform = useAuthStore((s) => s.platform);
  const activeBundleId = useAuthStore((s) => s.bundleId);
  const activePackageName = useAuthStore((s) => s.packageName);
  const googleAppHistory = useAuthStore((s) => s.googleAppHistory);
  const removeGoogleAppFromHistory = useAuthStore(
    (s) => s.removeGoogleAppFromHistory
  );
  const clientEmail = useAuthStore((s) => s.clientEmail);

  const setActive = useSetActiveApp();
  const appleApps = useAppleApps();

  const [open, setOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  if (!platform) return null;

  const triggerLabel =
    platform === 'apple'
      ? appleApps.data?.find((a) => a.bundleId === activeBundleId)?.name ??
        activeBundleId ??
        'Select app'
      : activePackageName ?? 'Select app';

  const handlePickApple = async (bundleId: string) => {
    try {
      await setActive.mutateAsync({ platform: 'apple', bundleId });
      setOpen(false);
    } catch (err) {
      console.error(err);
    }
  };

  const handlePickGoogle = async (packageName: string) => {
    try {
      await setActive.mutateAsync({ platform: 'google', packageName });
      setOpen(false);
    } catch (err) {
      console.error(err);
    }
  };

  const googleEntries = clientEmail
    ? googleAppHistory.filter((entry) => entry.clientEmail === clientEmail)
    : googleAppHistory;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          {platform === 'apple' && (
            <div className="max-h-72 overflow-auto py-1">
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
              {appleApps.data?.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No apps found.
                </div>
              )}
              {appleApps.data?.map((app) => {
                const isActive = app.bundleId === activeBundleId;
                return (
                  <button
                    key={app.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
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
              <div className="border-t mt-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => appleApps.refetch()}
                >
                  <RefreshCw className="h-3 w-3" /> Refresh apps list
                </button>
              </div>
            </div>
          )}

          {platform === 'google' && (
            <div className="max-h-72 overflow-auto py-1">
              {googleEntries.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No saved apps yet.
                </div>
              )}
              {googleEntries.map((entry) => {
                const isActive = entry.packageName === activePackageName;
                return (
                  <div
                    key={`${entry.packageName}-${entry.clientEmail}`}
                    className="group flex w-full items-center justify-between gap-2 px-3 py-2 hover:bg-muted"
                  >
                    <button
                      type="button"
                      className="flex-1 min-w-0 text-left text-sm"
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
              <div className="border-t mt-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setShowAddModal(true);
                    setOpen(false);
                  }}
                >
                  <Plus className="h-3 w-3" /> Add app
                </button>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {platform === 'google' && (
        <AddGoogleAppModal
          open={showAddModal}
          onOpenChange={setShowAddModal}
        />
      )}
    </>
  );
}
