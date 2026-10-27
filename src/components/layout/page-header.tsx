'use client';

import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import type { Platform } from '@/lib/utils/platform-routes';

/** "com.example.app · App Store": the app and store a screen is about. */
export function useAppContextLabel(platform: Platform): string {
  const bundleId = useAuthStore((s) => s.bundleId);
  const packageName = useAuthStore((s) => s.packageName);
  const app = platform === 'apple' ? bundleId : packageName;
  const store = platform === 'apple' ? 'App Store' : 'Google Play';
  return app ? `${app} · ${store}` : store;
}

/** Page padding shared by app screens. */
export const pageClass = 'flex-1 space-y-6 px-4 py-6 sm:px-8 lg:px-10 lg:py-7';

/** The Atlas page heading: small context line, title, optional actions. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-4', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && <p className="truncate text-[13px] text-muted-foreground">{eyebrow}</p>}
        <h1 className="mt-1 text-[26px] leading-tight font-extrabold tracking-[-0.02em] break-words sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1 text-[15px] text-soft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
