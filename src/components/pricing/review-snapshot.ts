/**
 * The review step's frozen payload. When a bulk pricing review opens, the
 * exact per-region prices it shows are copied here, and Apply sends only
 * this copy: a PPP or exchange-rate fetch that lands while the review is
 * open can change the live preview, but never what is sent. If the live
 * preview no longer matches, the review is stale and must be reopened.
 */

export interface ReviewSnapshot<P, M = undefined> {
  /** Region or territory code -> what Apply sends for it */
  prices: Readonly<Record<string, P>>;
  /** The regions in the snapshot, sorted */
  regions: readonly string[];
  /** Other inputs Apply uses (e.g. a start date), frozen with the prices */
  meta: M;
  /** Canonical text of prices and meta, to compare with the live preview */
  key: string;
}

/** JSON with object keys sorted, so equal values give equal text */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Freezes a deep copy of `prices` (and `meta`), so later changes to the source can't reach it */
export function takeReviewSnapshot<P, M = undefined>(prices: Record<string, P>, meta?: M): ReviewSnapshot<P, M> {
  const copy = JSON.parse(JSON.stringify(prices)) as Record<string, P>;
  const metaCopy = (meta === undefined ? undefined : JSON.parse(JSON.stringify(meta))) as M;
  const regions = Object.keys(copy).sort();
  return Object.freeze({
    prices: Object.freeze(copy),
    regions: Object.freeze(regions),
    meta: metaCopy,
    key: canonical({ prices: copy, meta: metaCopy ?? null }),
  });
}

/** True when what the live preview would send differs from the snapshot (a price, a region, or meta) */
export function isReviewStale<P, M>(snapshot: ReviewSnapshot<P, M> | null, livePrices: Record<string, P>, liveMeta?: M): boolean {
  if (!snapshot) return false;
  return canonical({ prices: livePrices, meta: liveMeta === undefined ? null : JSON.parse(JSON.stringify(liveMeta)) }) !== snapshot.key;
}

export const STALE_REVIEW_MESSAGE =
  'The calculated prices changed while this review was open (new exchange rates or PPP data). Nothing was sent. Close it and review again.';

// ---------------------------------------------------------------------------
// What each bulk pricing dialog sends, from its live preview

interface Calculated<P> {
  regionCode: string;
  price: P;
  error?: unknown;
}

/**
 * In-app purchases (both stores) and Google Play base plans: every selected
 * region with a calculated price, plus the App Store base territory (it must
 * be in the schedule), never a region flagged with an error.
 */
export function selectedRegionPrices<P>(preview: readonly Calculated<P>[], selected: ReadonlySet<string>, required: string | null = null): Record<string, P> {
  const out: Record<string, P> = {};
  for (const p of preview) {
    if (p.error) continue;
    if (selected.has(p.regionCode) || p.regionCode === required) out[p.regionCode] = p.price;
  }
  return out;
}

interface AppleTierPreview {
  territoryCode: string;
  tierPrice: number;
  currency: string;
  tier?: unknown;
  noTierData?: boolean;
  error?: unknown;
}

/** App Store subscriptions: each selected territory's target price and currency, when it has a tier and no error */
export function selectedTierTargets(preview: readonly AppleTierPreview[], selected: ReadonlySet<string>): Record<string, { targetPrice: number; currency: string }> {
  const out: Record<string, { targetPrice: number; currency: string }> = {};
  for (const p of preview) {
    if (!selected.has(p.territoryCode) || p.error || p.noTierData || !p.tier) continue;
    out[p.territoryCode] = { targetPrice: p.tierPrice, currency: p.currency };
  }
  return out;
}
