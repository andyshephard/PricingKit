'use client';

import { useRouter } from 'next/navigation';
import { Search, RefreshCw, LogOut } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Breadcrumbs } from './breadcrumbs';
import { toast } from 'sonner';
import { DASHBOARD_AUTH_VERIFIED_KEY, useAuthStore } from '@/store/auth-store';
import { useQueryClient } from '@tanstack/react-query';

interface HeaderProps {
  onRefresh?: () => void;
  isRefreshing?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  showSearch?: boolean;
}

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

  // Signing out clears both store sessions and the saved Open Exchange Rates
  // key (server cookies), then this tab's state. A failed request is reported,
  // not treated as signed out.
  const handleLogout = async () => {
    const endpoints = ['/api/auth', '/api/apple/auth', '/api/settings/exchange-rates'];
    const results = await Promise.allSettled(endpoints.map((url) => fetch(url, { method: 'DELETE' })));
    const failed = results.filter((r) => r.status === 'rejected' || !r.value.ok).length;
    try {
      sessionStorage.removeItem(DASHBOARD_AUTH_VERIFIED_KEY);
    } catch {
      // storage unavailable
    }
    queryClient.clear();
    clearAuth();
    if (failed > 0) {
      toast.error('Sign-out may be incomplete: the server did not confirm it. Close the browser or try again.');
      return;
    }
    router.push('/setup');
  };

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b bg-background px-6">
      <Breadcrumbs />

      <div className="ml-auto flex items-center gap-4">
        {showSearch && onSearchChange && (
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search..."
              className="w-64 pl-8"
              value={searchValue}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
        )}

        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw
              className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`}
            />
            <span className="sr-only">Refresh</span>
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={handleLogout}
          className="text-muted-foreground hover:text-destructive"
        >
          <LogOut className="h-4 w-4 mr-1.5" />
          Logout
        </Button>
      </div>
    </header>
  );
}
