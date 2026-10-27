import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApplyRun, ChangeSet, OfferPlanEntry, OpStatus, StoreOffer } from '@/lib/pricing';

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
    // A failed read is not retried: a 429 or a spent request budget only gets worse by retrying
    retry: false,
  });
}

async function postJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 401) throw new Error('401: Unauthorized');
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || fallback);
  }
  return response.json();
}

export interface OfferRuleInput {
  percent: string;
  basis: 'perPeriod' | 'totalOverDuration';
  snap: 'nearest' | 'floor' | 'ceil';
}

export type OfferPlanRequest =
  | ({ action: 'create'; offerCode: string; name: string; mode: 'PAY_UP_FRONT' | 'PAY_AS_YOU_GO'; duration: string; periods?: number } & OfferRuleInput)
  | ({ action: 'updatePrices'; offer: string } & OfferRuleInput);

export interface OfferPlanResponse {
  changeSet: ChangeSet;
  hash: string;
  entry: OfferPlanEntry;
}

/** Dry run: plan a promotional offer from a rule (reads only) */
export function usePlanAppleOffer(subscriptionId: string) {
  return useMutation<OfferPlanResponse, Error, OfferPlanRequest>({
    mutationFn: (body) => postJson(`/api/apple/subscriptions/${encodeURIComponent(subscriptionId)}/offers/plan`, body, 'Failed to plan the offer'),
  });
}

/** Apply a reviewed offer plan; `confirm` is the plan's hash */
export function useApplyAppleOfferPlan(subscriptionId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ run: ApplyRun; summary: Record<OpStatus, number> }, Error, { changeSet: ChangeSet; confirm: string }>({
    mutationFn: (body) => postJson(`/api/apple/subscriptions/${encodeURIComponent(subscriptionId)}/offers/apply`, body, 'Failed to apply the offer plan'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['apple', 'subscription-offers', subscriptionId] });
    },
  });
}
