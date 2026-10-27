// Regenerating the static Apple price tier data (price-tier-data.json) from
// the live App Store Connect API. Used by scripts/fetch-apple-price-tiers.ts;
// the store reads are injected, so this module is testable without a network.
//
// The data maps each currency to its ladder of [customerPrice, tier] pairs,
// sorted by price. A currency's ladder comes from one representative
// territory that bills in it (the first in App Store Connect's territory
// list, or one chosen with `prefer`); Apple's per-territory prices in one
// currency can differ, and that is a known limit of a per-currency table.
//
// The tier is the "p" field of Apple's base64-JSON price point ID. That
// encoding is undocumented (the web app's IAP price edits rely on it too),
// so any ID that doesn't decode to a numeric tier fails the whole run: a
// partial table is never written.

import { mapWithConcurrency } from '../pricing/concurrency';
import { isDecimalString } from '../pricing/decimal';

export interface TierBuildTerritory {
  /** App Store Connect territory ID (alpha-3) */
  id: string;
  currency: string;
}

export interface TierBuildPricePoint {
  id: string;
  customerPrice: string;
}

export interface TierBuildSource {
  listTerritories(): Promise<TierBuildTerritory[]>;
  /** Every in-app purchase price point of one territory */
  listPricePoints(territory: string): Promise<TierBuildPricePoint[]>;
}

export interface TierBuildOptions {
  /** Currency -> territory (alpha-3) to read that currency's ladder from */
  prefer?: Record<string, string>;
  /** Territories read at once (default 4) */
  concurrency?: number;
  onProgress?: (message: string) => void;
}

export type TierData = Record<string, Array<[number, string]>>;

export interface TierBuildResult {
  data: TierData;
  /** Currency -> the territory its ladder was read from */
  territories: Record<string, string>;
}

export class TierBuildError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Price tier data not generated:\n- ${problems.join('\n- ')}`);
    this.name = 'TierBuildError';
  }
}

/** The tier ("p") of an Apple price point ID, or undefined when it doesn't decode to a numeric tier */
export function decodePricePointTier(id: string): string | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(id, 'base64').toString('utf8')) as { p?: unknown };
    const tier = typeof parsed.p === 'string' || typeof parsed.p === 'number' ? String(parsed.p) : undefined;
    return tier && /^\d+$/.test(tier) ? tier : undefined;
  } catch {
    return undefined;
  }
}

/** Read every currency's ladder and build the table. Throws TierBuildError (and builds nothing) on any problem. */
export async function buildPriceTierData(source: TierBuildSource, options: TierBuildOptions = {}): Promise<TierBuildResult> {
  const territories = await source.listTerritories();
  const problems: string[] = [];
  const byCurrency = new Map<string, string>();
  for (const t of territories) {
    if (!/^[A-Z]{3}$/.test(t.currency ?? '')) {
      problems.push(`territory ${t.id} has no currency`);
      continue;
    }
    if (!byCurrency.has(t.currency)) byCurrency.set(t.currency, t.id);
  }
  for (const [currency, territory] of Object.entries(options.prefer ?? {})) {
    const match = territories.find((t) => t.id === territory);
    if (!match) problems.push(`prefer ${currency}=${territory}: no such territory`);
    else if (match.currency !== currency) problems.push(`prefer ${currency}=${territory}: ${territory} bills in ${match.currency}`);
    else byCurrency.set(currency, territory);
  }
  if (byCurrency.size === 0) problems.push('App Store Connect listed no territories');
  if (problems.length > 0) throw new TierBuildError(problems);

  const currencies = [...byCurrency.keys()];
  const ladders = await mapWithConcurrency(currencies, options.concurrency ?? 4, async (currency) => {
    const territory = byCurrency.get(currency)!;
    const points = await source.listPricePoints(territory);
    options.onProgress?.(`${currency} from ${territory}: ${points.length} price points`);
    const rows: Array<[number, string]> = [];
    const seen = new Set<string>();
    for (const point of points) {
      const tier = decodePricePointTier(point.id);
      if (!tier) {
        problems.push(`${territory}: a price point ID doesn't decode to a tier`);
        return rows;
      }
      if (!isDecimalString(point.customerPrice)) {
        problems.push(`${territory}: tier ${tier} has no valid customer price`);
        return rows;
      }
      if (seen.has(tier)) continue;
      seen.add(tier);
      rows.push([Number(point.customerPrice), tier]);
    }
    if (rows.length === 0) problems.push(`${territory} (${currency}): no price points`);
    rows.sort((a, b) => a[0] - b[0] || Number(a[1]) - Number(b[1]));
    return rows;
  });
  if (problems.length > 0) throw new TierBuildError([...new Set(problems)]);

  const data: TierData = {};
  currencies.forEach((currency, i) => (data[currency] = ladders[i]));
  return { data, territories: Object.fromEntries(byCurrency) };
}

/** price-tier-data.json as committed: one line of compact JSON */
export function serializeTierData(data: TierData): string {
  return JSON.stringify(data);
}

/** Replace the generated date in price-tier-data.ts (its header comment and PRICE_TIER_DATA_GENERATED_AT) */
export function updateTierModuleDate(moduleText: string, generatedAt: Date): string {
  const iso = generatedAt.toISOString();
  const updated = moduleText
    .replace(/^\/\/ Generated: .*$/m, `// Generated: ${iso}`)
    .replace(/export const PRICE_TIER_DATA_GENERATED_AT = '[^']*';/, `export const PRICE_TIER_DATA_GENERATED_AT = '${iso.slice(0, 10)}';`);
  if (updated === moduleText && !moduleText.includes(iso)) throw new TierBuildError(['price-tier-data.ts has no "// Generated:" line or PRICE_TIER_DATA_GENERATED_AT to update']);
  return updated;
}
