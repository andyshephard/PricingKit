'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Package,
  CreditCard,
  LayoutDashboard,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PlatformSelector } from './platform-selector';
import { getPlatformFromPath, type Platform } from '@/lib/utils/platform-routes';

export function Sidebar() {
  const pathname = usePathname();

  // Determine current platform from URL
  const currentPlatform = getPlatformFromPath(pathname);

  // Build platform-specific navigation links
  const getNavigation = (platform: Platform | null) => {
    if (!platform) {
      // Fallback to generic routes (shouldn't happen in normal use)
      return [
        { name: 'Overview', href: '/dashboard', icon: LayoutDashboard },
        { name: 'Products', href: '/dashboard/products', icon: Package },
        { name: 'Subscriptions', href: '/dashboard/subscriptions', icon: CreditCard },
        { name: 'Settings', href: '/dashboard/settings', icon: Settings },
      ];
    }

    const basePath = `/dashboard/${platform}`;
    return [
      { name: 'Overview', href: basePath, icon: LayoutDashboard },
      { name: 'Products', href: `${basePath}/products`, icon: Package },
      { name: 'Subscriptions', href: `${basePath}/subscriptions`, icon: CreditCard },
      { name: 'Settings', href: '/dashboard/settings', icon: Settings },
    ];
  };

  const navigation = getNavigation(currentPlatform);

  return (
    <div className="flex h-full w-64 flex-col border-r bg-background">
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/dashboard" className="flex items-center">
          <span className="font-semibold">PricingKit</span>
        </Link>
      </div>

      {/* Platform Selector */}
      <div className="px-3 py-3 border-b">
        <PlatformSelector currentPlatform={currentPlatform} />
      </div>

      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="flex flex-col gap-1">
          {navigation.map((item) => {
            // Determine if this item is active
            const isActive = currentPlatform
              ? item.href === `/dashboard/${currentPlatform}`
                ? pathname === `/dashboard/${currentPlatform}`
                : pathname.startsWith(item.href)
              : item.href === '/dashboard'
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

    </div>
  );
}
