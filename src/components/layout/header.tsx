'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogOut, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { forgetAllKeys, setOerKey } from '@/lib/web/client';
import { Breadcrumbs } from './breadcrumbs';

interface HeaderProps {
  onRefresh?: () => void;
  isRefreshing?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  showSearch?: boolean;
}

const iconButton =
  'inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-line-strong bg-card text-soft transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50';

/**
 * The app screens' top bar: breadcrumb, then the page's search and refresh
 * (when it has them) and Sign out. On phones it wraps: the breadcrumb gets
 * its own row above the search and buttons. The theme toggle lives in the
 * sidebar, which is on screen at every width.
 */
export function Header({
  onRefresh,
  isRefreshing,
  searchValue = '',
  onSearchChange,
  showSearch = true,
}: HeaderProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const clearAuth = useAuthStore((state) => state.clearAuth);
  const [signingOut, setSigningOut] = useState(false);

  // Signing out deletes both store keys from this browser (IndexedDB), the
  // saved Open Exchange Rates key and the app selection. If the keys can't be
  // deleted that is reported, never treated as signed out.
  const handleLogout = async () => {
    setSigningOut(true);
    try {
      await forgetAllKeys();
    } catch {
      setSigningOut(false);
      toast.error("Sign-out failed: this browser could not delete the stored keys. Try again, or clear this site's data in the browser settings.");
      return;
    }
    setOerKey(null);
    queryClient.clear();
    clearAuth();
    setSigningOut(false);
    router.push('/setup');
  };

  const hasSearch = showSearch && Boolean(onSearchChange);

  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-header px-4 py-2.5 sm:px-8 lg:px-10">
      {/* Phones: the breadcrumb on its own row, then search and buttons */}
      <div className="w-full min-w-0 sm:w-auto sm:flex-1">
        <Breadcrumbs />
      </div>

      {hasSearch && (
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-border bg-background px-3.5 py-2 text-sm text-muted-foreground focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring sm:w-64 sm:flex-none">
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search this list"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            value={searchValue}
            onChange={(e) => onSearchChange!(e.target.value)}
          />
        </label>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {onRefresh && (
          <button type="button" className={iconButton} onClick={onRefresh} disabled={isRefreshing} aria-label="Refresh" title="Refresh">
            <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={handleLogout}
          disabled={signingOut}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-card px-3.5 text-sm font-semibold text-soft transition-colors hover:border-destructive hover:text-destructive disabled:pointer-events-none disabled:opacity-60"
        >
          {signingOut ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <LogOut className="size-4" aria-hidden="true" />}
          Sign out
        </button>
      </div>
    </header>
  );
}
