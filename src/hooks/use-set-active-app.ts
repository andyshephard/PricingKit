import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/store/auth-store';

type AppleVariables = { platform: 'apple'; bundleId: string };
type GoogleVariables = { platform: 'google'; packageName: string };
export type SetActiveAppVariables = AppleVariables | GoogleVariables;

interface SetActiveAppResponse {
  ok: true;
  bundleId?: string;
  packageName?: string;
}

async function postActiveApp(
  variables: SetActiveAppVariables
): Promise<SetActiveAppResponse> {
  const url =
    variables.platform === 'apple' ? '/api/apple/active-app' : '/api/active-app';
  const body =
    variables.platform === 'apple'
      ? { bundleId: variables.bundleId }
      : { packageName: variables.packageName };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? 'Failed to switch app');
  }
  return (await response.json()) as SetActiveAppResponse;
}

export function useSetActiveApp() {
  const queryClient = useQueryClient();
  const setActiveBundleId = useAuthStore((s) => s.setActiveBundleId);
  const setActivePackageName = useAuthStore((s) => s.setActivePackageName);

  return useMutation({
    mutationFn: postActiveApp,
    onSuccess: (_, variables) => {
      if (variables.platform === 'apple') {
        setActiveBundleId(variables.bundleId);
      } else {
        setActivePackageName(variables.packageName);
      }
      queryClient.invalidateQueries();
    },
  });
}
