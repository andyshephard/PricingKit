import { useQuery } from '@tanstack/react-query';
import type { StoreOffer } from '@/lib/pricing';
import { apiFetch } from '@/lib/web/client';

/** Read-only list of a Google Play subscription's offers, across its base plans */
export function usePlaySubscriptionOffers(productId: string | undefined) {
  return useQuery<{ offers: StoreOffer[] }>({
    queryKey: ['google', 'subscription-offers', productId],
    queryFn: async () => {
      const response = await apiFetch(`/api/subscriptions/${encodeURIComponent(productId!)}/offers`);
      if (!response.ok) {
        if (response.status === 401) throw new Error('401: Unauthorized');
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to fetch offers');
      }
      return response.json();
    },
    enabled: !!productId,
    // A failed read is not retried: a 429 or a spent request budget only gets worse by retrying
    retry: false,
  });
}
