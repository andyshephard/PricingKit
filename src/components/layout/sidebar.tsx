'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Store,
  Package,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useAuthStore } from '@/store/auth-store';
import { PlatformSelector } from './platform-selector';

const navigation = [
  { name: 'Overview', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Products', href: '/dashboard/products', icon: Package },
  { name: 'Subscriptions', href: '/dashboard/subscriptions', icon: CreditCard },
  { name: 'Settings', href: '/dashboard/settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const platform = useAuthStore((state) => state.platform);
  const clearAuth = useAuthStore((state) => state.clearAuth);
  const clearGoogleAuth = useAuthStore((state) => state.clearGoogleAuth);
  const clearAppleAuth = useAuthStore((state) => state.clearAppleAuth);

  const handleLogout = async () => {
    try {
      // Disconnect from the currently active platform
      if (platform === 'google') {
        await fetch('/api/auth', { method: 'DELETE' });
        clearGoogleAuth();
      } else if (platform === 'apple') {
        await fetch('/api/apple/auth', { method: 'DELETE' });
        clearAppleAuth();
      }

      // Check if any platform is still connected
      const state = useAuthStore.getState();
      if (!state.isGoogleAuthenticated && !state.isAppleAuthenticated) {
        router.push('/');
      }
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  const handleDisconnectAll = async () => {
    try {
      // Disconnect from both platforms
      await Promise.all([
        fetch('/api/auth', { method: 'DELETE' }),
        fetch('/api/apple/auth', { method: 'DELETE' }),
      ]);
      clearAuth();
      router.push('/');
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  return (
    <div className="flex h-full w-64 flex-col border-r bg-background">
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/dashboard" className="flex items-center gap-2">
          <Store className="h-6 w-6 text-primary" />
          <span className="font-semibold">Pricing.io</span>
        </Link>
      </div>

      {/* Platform Selector */}
      <div className="px-3 py-3 border-b">
        <PlatformSelector />
      </div>

      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="flex flex-col gap-1">
          {navigation.map((item) => {
            const isActive =
              item.href === '/dashboard'
                ? pathname === '/dashboard'
                : pathname.startsWith(item.href);

            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.name}
              </Link>
            );
          })}
        </nav>
      </ScrollArea>

      <div className="border-t p-4">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground hover:text-destructive"
          onClick={handleDisconnectAll}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Disconnect All
        </Button>
      </div>
    </div>
  );
}
