import { APPLE_OFFER_KINDS, type AppleOfferKind, type ProductRef, type StoreOffer } from '@/lib/pricing';
import { appSelection, stringFlag, type AppSelection } from '../args';
import { appleAdapter, type CommandContext, type CommandResult } from '../context';
import { EXIT_OK, UsageError } from '../errors';
import { money, table } from '../format';
import { productFromFlags } from './export';

export const OFFER_LIST_KIND = 'pricingkit.offers' as const;
export const OFFER_LIST_SCHEMA_VERSION = 1 as const;

export interface OfferList {
  kind: typeof OFFER_LIST_KIND;
  schemaVersion: typeof OFFER_LIST_SCHEMA_VERSION;
  fetchedAt: string;
  app: { bundleId: string };
  product: ProductRef;
  offers: StoreOffer[];
}

export function appleOnly(app: AppSelection, command: string): asserts app is Extract<AppSelection, { platform: 'apple' }> {
  if (app.platform !== 'apple') throw new UsageError(`${command} is App Store only for now (Google Play offers come in a later phase)`);
}

export function parseOfferKind(value: string): AppleOfferKind {
  if (!(APPLE_OFFER_KINDS as readonly string[]).includes(value)) {
    throw new UsageError(`--kind must be one of ${APPLE_OFFER_KINDS.join(', ')}`);
  }
  return value as AppleOfferKind;
}

export function formatOffer(offer: StoreOffer): string {
  const terms = [offer.mode ?? 'unknown mode', offer.duration ?? 'unknown duration', ...(offer.periods ? [`x${offer.periods}`] : [])].join(' ');
  const lines = [`${offer.kind}  ${offer.key}${offer.name && offer.name !== offer.key ? ` "${offer.name}"` : ''}  ${terms}  (id ${offer.storeId})`];
  if (offer.schedule?.start || offer.schedule?.end) lines.push(`  schedule: ${offer.schedule.start ?? '...'} to ${offer.schedule.end ?? '...'}`);
  if (offer.eligibility) lines.push(`  eligibility: ${JSON.stringify(offer.eligibility)}`);
  if (offer.status && Object.keys(offer.status).length > 0) {
    lines.push(`  status: ${Object.entries(offer.status).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  const territories = [...new Set([...Object.keys(offer.prices), ...Object.keys(offer.territoryProblems ?? {})])].sort();
  if (territories.length > 0) {
    lines.push(
      table(
        territories.map((t) => {
          const price = offer.prices[t];
          const problem = offer.territoryProblems?.[t];
          return [t, price ? (price.free ? 'free' : money(price)) : '-', problem ? `problem: ${problem}` : ''];
        }),
        '    '
      )
    );
  }
  for (const problem of offer.problems ?? []) lines.push(`  problem: ${problem}`);
  return lines.join('\n');
}

export async function offersCommand(ctx: CommandContext): Promise<CommandResult> {
  const app = appSelection(ctx.flags)!;
  appleOnly(app, 'offers');
  const product = productFromFlags(app, ctx.flags);
  const kindFlag = stringFlag(ctx.flags, 'kind');
  const kind = kindFlag ? parseOfferKind(kindFlag) : undefined;

  const adapter = await appleAdapter(ctx, app.bundleId);
  const all = await adapter.fetchOffers(product);
  const offers = kind ? all.filter((o) => o.kind === kind) : all;
  const result: OfferList = {
    kind: OFFER_LIST_KIND,
    schemaVersion: OFFER_LIST_SCHEMA_VERSION,
    fetchedAt: ctx.now().toISOString(),
    app: { bundleId: app.bundleId },
    product,
    offers,
  };
  const text = offers.length === 0 ? 'No offers.' : [`${offers.length} offers`, ...offers.map(formatOffer)].join('\n\n');
  return { exitCode: EXIT_OK, json: result, text };
}
