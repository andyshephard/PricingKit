import { useQuery } from '@tanstack/react-query';
import type { AppleOfferKind, OfferDriftReport, StoreOffer } from '@/lib/pricing';

async function getJson<T>(url: string, fallback: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 401) throw new Error('401: Unauthorized');
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || fallback);
  }
  return response.json();
}

/** Read-only list of a subscription's offers (numeric App Store Connect subscription ID) */
export function useAppleSubscriptionOffers(subscriptionId: string | undefined) {
  return useQuery<{ offers: StoreOffer[] }>({
    queryKey: ['apple', 'subscription-offers', subscriptionId],
    queryFn: () => getJson(`/api/apple/subscriptions/${encodeURIComponent(subscriptionId!)}/offers`, 'Failed to fetch offers'),
    enabled: !!subscriptionId,
  });
}

export interface OfferDriftQuery {
  kind: AppleOfferKind;
  offer: string;
  percent: string;
  basis: 'perPeriod' | 'totalOverDuration';
  snap: 'nearest' | 'floor' | 'ceil';
}

/** Drift of one offer against a percent-of-current rule. Runs only when `query` is set. */
export function useAppleOfferDrift(subscriptionId: string | undefined, query: OfferDriftQuery | null) {
  return useQuery<{ report: OfferDriftReport }>({
    queryKey: ['apple', 'offer-drift', subscriptionId, query],
    queryFn: () => {
      const params = new URLSearchParams({ ...query! });
      return getJson(`/api/apple/subscriptions/${encodeURIComponent(subscriptionId!)}/offers/drift?${params}`, 'Failed to check offer');
    },
    enabled: !!subscriptionId && !!query,
    retry: false,
  });
}
