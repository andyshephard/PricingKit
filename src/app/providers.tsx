'use client';

import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { AuthErrorDialog, triggerAuthError } from '@/components/auth-error-dialog';

const AUTH_ERROR_COOLDOWN = 5000; // 5 seconds cooldown between auth error dialogs

// Module-level tracking for auth error deduplication
// Using module scope to avoid React ref access during render issues
let authErrorShown = false;
let authErrorTimeout: NodeJS.Timeout | null = null;

function handleGlobalError(error: unknown) {
  // Check if this is a 401 error
  if (error instanceof Error && error.message.includes('401')) {
    if (!authErrorShown) {
      authErrorShown = true;
      triggerAuthError();

      // Clear any existing timeout
      if (authErrorTimeout) {
        clearTimeout(authErrorTimeout);
      }

      // Reset after cooldown so future auth errors can be shown
      authErrorTimeout = setTimeout(() => {
        authErrorShown = false;
        authErrorTimeout = null;
      }, AUTH_ERROR_COOLDOWN);
    }
  }
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Don't retry on 401 errors
              if (error instanceof Error && error.message.includes('401')) {
                return false;
              }
              return failureCount < 3;
            },
          },
          mutations: {
            retry: false,
          },
        },
        queryCache: new QueryCache({
          onError: handleGlobalError,
        }),
        mutationCache: new MutationCache({
          onError: handleGlobalError,
        }),
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster richColors position="top-right" />
      <AuthErrorDialog />
    </QueryClientProvider>
  );
}
