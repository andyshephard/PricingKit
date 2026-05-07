import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/auth-store';
import type { AppleAppSummary } from '@/app/api/apple/apps/route';

interface AppleAppsResponse {
  apps: AppleAppSummary[];
}

export function useAppleApps() {
  const isAppleAuthenticated = useAuthStore((s) => s.isAppleAuthenticated);

  return useQuery({
    queryKey: ['apple', 'apps'],
    enabled: isAppleAuthenticated,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<AppleAppSummary[]> => {
      const response = await fetch('/api/apple/apps');
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'Failed to fetch apps');
      }
      const data = (await response.json()) as AppleAppsResponse;
      return data.apps;
    },
  });
}
