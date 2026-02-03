'use client';

import { useState } from 'react';
import { Plus, Check } from 'lucide-react';
import { useAuthStore, type Platform } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ConnectPlatformModal } from './connect-platform-modal';

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

interface PlatformItemProps {
  id: 'google' | 'apple';
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  identifier: string | null;
  isConnected: boolean;
  isActive: boolean;
  onSelect: () => void;
  onConnect: () => void;
}

function PlatformItem({
  id,
  name,
  icon: Icon,
  identifier,
  isConnected,
  isActive,
  onSelect,
  onConnect,
}: PlatformItemProps) {
  if (!isConnected) {
    return (
      <button
        onClick={onConnect}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border-2 border-dashed border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex-shrink-0 w-8 h-8 rounded-md bg-muted flex items-center justify-center">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{name}</p>
          <p className="text-xs text-muted-foreground">Not connected</p>
        </div>
        <Plus className="h-4 w-4 text-muted-foreground" />
      </button>
    );
  }

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border-2 transition-colors text-left',
        isActive
          ? 'border-primary bg-primary/5'
          : 'border-transparent hover:bg-muted/50'
      )}
    >
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center',
          isActive ? 'bg-primary text-primary-foreground' : 'bg-muted'
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{name}</p>
        <p className="text-xs text-muted-foreground truncate font-mono">
          {identifier}
        </p>
      </div>
      {isActive && <Check className="h-4 w-4 text-primary flex-shrink-0" />}
    </button>
  );
}

export function PlatformSelector() {
  const platform = useAuthStore((state) => state.platform);
  const isGoogleAuthenticated = useAuthStore(
    (state) => state.isGoogleAuthenticated
  );
  const isAppleAuthenticated = useAuthStore(
    (state) => state.isAppleAuthenticated
  );
  const packageName = useAuthStore((state) => state.packageName);
  const bundleId = useAuthStore((state) => state.bundleId);
  const setPlatform = useAuthStore((state) => state.setPlatform);

  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [connectPlatform, setConnectPlatform] = useState<'google' | 'apple'>(
    'google'
  );

  const handleConnect = (p: 'google' | 'apple') => {
    setConnectPlatform(p);
    setConnectModalOpen(true);
  };

  return (
    <>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
          Platforms
        </p>

        <div className="space-y-1.5">
          <PlatformItem
            id="google"
            name="Google Play"
            icon={GooglePlayIcon}
            identifier={packageName}
            isConnected={isGoogleAuthenticated}
            isActive={platform === 'google'}
            onSelect={() => setPlatform('google')}
            onConnect={() => handleConnect('google')}
          />

          <PlatformItem
            id="apple"
            name="App Store"
            icon={AppleIcon}
            identifier={bundleId}
            isConnected={isAppleAuthenticated}
            isActive={platform === 'apple'}
            onSelect={() => setPlatform('apple')}
            onConnect={() => handleConnect('apple')}
          />
        </div>
      </div>

      <ConnectPlatformModal
        open={connectModalOpen}
        onOpenChange={setConnectModalOpen}
        platform={connectPlatform}
      />
    </>
  );
}
