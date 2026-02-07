'use client';

import { useRouter } from 'next/navigation';
import { Search, RefreshCw, LogOut } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Breadcrumbs } from './breadcrumbs';
import { useAuthStore } from '@/store/auth-store';

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
  const clearAuth = useAuthStore((state) => state.clearAuth);

  const handleLogout = async () => {
    try {
      await Promise.all([
        fetch('/api/auth', { method: 'DELETE' }),
        fetch('/api/apple/auth', { method: 'DELETE' }),
      ]);
      clearAuth();
      router.push('/setup');
    } catch (error) {
      console.error('Logout failed:', error);
    }
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
