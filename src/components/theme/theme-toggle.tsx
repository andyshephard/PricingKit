'use client';

import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { setTheme, useResolvedTheme } from './theme';

/**
 * A round icon button that switches between light and dark and remembers the
 * choice. Both icons render and CSS shows the right one, so the button is
 * correct before hydration; the label settles once the theme is known.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useResolvedTheme();
  const label =
    theme === 'dark' ? 'Switch to light mode' : theme === 'light' ? 'Switch to dark mode' : 'Switch color theme';

  return (
    <button
      type="button"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-line-strong text-soft transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className
      )}
    >
      <Moon className="size-4 dark:hidden" aria-hidden="true" />
      <Sun className="hidden size-4 dark:block" aria-hidden="true" />
    </button>
  );
}
