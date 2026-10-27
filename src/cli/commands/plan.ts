import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  changeSetHash,
  OFFER_PLAN_SPEC_KIND,
  parseOfferPlanSpec,
  type OfferPlan,
  type OfferPlanSpec,
  buildChangeSet,
  createStateSnapshot,
  parsePricingSpec,
  serializeChangeSet,
  serializeStateSnapshot,
  specTargets,
  type ChangeSet,
  type PlanSkip,
  type PricingSpec,
  type ProductPriceState,
  type TargetPrice,
} from '@/lib/pricing';
import { appSelection, stringFlag } from '../args';
import { appleAdapter, playAdapter, readInputFile, readOnly, writeOutputFile, type CommandContext, type CommandResult, type PriceReader } from '../context';
import { CliError, EXIT_CHANGES, EXIT_ERROR, EXIT_OK, UsageError } from '../errors';
import { formatPlanSummary, summarizeChangeSet } from './diff';

export const DEFAULT_PLAN_FILE = 'pricingkit-plan.json';

export interface PlanOutcome {
  changeSet: ChangeSet;
  states: ProductPriceState[];
}

/**
 * Spec -> ChangeSet. Reads each product's state, builds its targets, snaps
 * them with the store and diffs. Takes only a PriceReader, so it can't write.
 */
export async function planFromSpec(spec: PricingSpec, reader: PriceReader, createdAt: string): Promise<PlanOutcome> {
  const products: Parameters<typeof buildChangeSet>[0]['products'] = [];
  const unresolvedSkips: PlanSkip[] = [];
  const states: ProductPriceState[] = [];

  for (const entry of spec.products) {
    const state = await reader.fetchState(entry.product);
    states.push(state);
    const { targets: raw, skipped } = specTargets(entry, state);
    unresolvedSkips.push(...skipped);

    const resolved = Object.keys(raw).length > 0 ? await reader.resolvePricePoints(entry.product, raw, { mode: entry.snap ?? 'nearest' }) : { resolved: {}, unresolved: {} };
    for (const [territory, reason] of Object.entries(resolved.unresolved)) {
      unresolvedSkips.push({ product: entry.product, territory, reason: 'UNRESOLVED_PRICE_POINT', detail: reason });
    }
    const targets: Record<string, TargetPrice> = {};
    for (const [territory, price] of Object.entries(resolved.resolved)) {
      targets[territory] = {
        currency: price.currency,
        amount: price.amount,
        ...(price.pricePointId ? { pricePointId: price.pricePointId } : {}),
        ...(price.proceeds ? { proceeds: price.proceeds } : {}),
        ...(entry.startDate ? { startDate: entry.startDate } : {}),
        ...(price.deviation !== '0' ? { note: `target ${price.target} ${price.currency}, snapped by ${price.deviation} (${price.deviationRatio})` } : {}),
      };
    }
    products.push({
      state,
      targets,
      options: {
        ...(entry.allowNewTerritories !== undefined ? { allowNewTerritories: entry.allowNewTerritories } : {}),
        ...(entry.preserveCurrentPrice !== undefined ? { preserveCurrentPrice: entry.preserveCurrentPrice } : {}),
      },
    });
  }

  const changeSet = buildChangeSet({ app: spec.app, ...(spec.description ? { description: spec.description } : {}), products, createdAt });
  const skipped = [...(changeSet.skipped ?? []), ...unresolvedSkips];
  return { changeSet: { ...changeSet, ...(skipped.length > 0 ? { skipped } : {}) }, states };
}

export async function planCommand(ctx: CommandContext): Promise<CommandResult> {
  const specPath = stringFlag(ctx.flags, 'spec', true);
  const explicitOut = stringFlag(ctx.flags, 'out');
  const out = explicitOut ?? DEFAULT_PLAN_FILE;
  // The default file name is easy to clobber by accident: keep an existing one unless told otherwise
  if (!explicitOut && ctx.flags.force !== true && existsSync(resolve(ctx.cwd, out))) {
    throw new UsageError(`${out} already exists. Pass --force to replace it, or choose a file with --out`);
  }
  const stateOut = stringFlag(ctx.flags, 'state-out');
  if (stateOut && stateOut === out) throw new UsageError('--out and --state-out must be different files');

  const specText = await readInputFile(ctx, specPath, 'spec file');
  if (specKind(specText) === OFFER_PLAN_SPEC_KIND) return planOffersCommand(ctx, specText, out);

  let spec: PricingSpec;
  try {
    spec = parsePricingSpec(specText);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError((error as Error).message, 'INVALID_SPEC');
  }
  const selected = appSelection(ctx.flags, false);
  if (selected) {
    const matches = selected.platform === 'apple' ? 'bundleId' in spec.app && spec.app.bundleId === selected.bundleId : 'packageName' in spec.app && spec.app.packageName === selected.packageName;
    if (!matches) throw new UsageError('The app given on the command line is not the app in the spec');
  }

  const adapter = 'bundleId' in spec.app ? await appleAdapter(ctx, spec.app.bundleId) : await playAdapter(ctx, spec.app.packageName);
  const { changeSet, states } = await planFromSpec(spec, readOnly(adapter), ctx.now().toISOString());

  const written = await writeOutputFile(ctx, out, serializeChangeSet(changeSet));
  const stateWritten = stateOut ? await writeOutputFile(ctx, stateOut, serializeStateSnapshot(createStateSnapshot(spec.app, states, ctx.now().toISOString()))) : undefined;

  const text = [
    formatPlanSummary(summarizeChangeSet(changeSet)),
    '',
    `Plan written to ${written}`,
    ...(stateWritten ? [`State written to ${stateWritten}`] : []),
    'Dry run: nothing was changed in the store.',
  ].join('\n');
  return { exitCode: changeSet.ops.length > 0 ? EXIT_CHANGES : EXIT_OK, json: changeSet, text };
}

function specKind(text: string): unknown {
  try {
    return (JSON.parse(text) as { kind?: unknown })?.kind;
  } catch {
    return undefined;
  }
}

/** The read side of offer planning only: no way to reach applyOffer */
export interface OfferPlanner {
  planOffers(input: { app: OfferPlanSpec['app']; offers: OfferPlanSpec['offers']; createdAt?: string; description?: string }): Promise<OfferPlan>;
}

export function formatOfferPlan(plan: OfferPlan): string {
  const lines = [formatPlanSummary(summarizeChangeSet(plan.changeSet))];
  for (const entry of plan.entries) {
    const where = `${entry.product.platform === 'apple' ? entry.product.id : ''} ${entry.kind} ${entry.key}`;
    if (entry.action === 'none') lines.push('', `${where}: already matches its rule`);
    for (const r of entry.refusals) lines.push('', `${where}: refused (${r.code}): ${r.message}`);
  }
  return lines.join('\n');
}

/** pricingkit plan with a pricingkit.offerPlanSpec: plan creating or re-pricing offers. Reads only. */
async function planOffersCommand(ctx: CommandContext, specText: string, out: string): Promise<CommandResult> {
  let spec: OfferPlanSpec;
  try {
    spec = parseOfferPlanSpec(specText);
  } catch (error) {
    throw new CliError((error as Error).message, 'INVALID_SPEC');
  }
  const selected = appSelection(ctx.flags, false);
  if (selected && !(selected.platform === 'apple' && 'bundleId' in spec.app && spec.app.bundleId === selected.bundleId)) {
    throw new UsageError('The app given on the command line is not the app in the spec');
  }
  const adapter = await appleAdapter(ctx, (spec.app as { bundleId: string }).bundleId);
  const planner: OfferPlanner = { planOffers: (input) => adapter.planOffers(input) };
  const plan = await planner.planOffers({ app: spec.app, offers: spec.offers, createdAt: ctx.now().toISOString(), ...(spec.description ? { description: spec.description } : {}) });
  if (plan.hash !== changeSetHash(plan.changeSet)) throw new CliError('Internal error: plan hash mismatch');
  const written = await writeOutputFile(ctx, out, serializeChangeSet(plan.changeSet));
  const refused = plan.entries.filter((e) => e.action === 'refused').length;
  const text = [formatOfferPlan(plan), '', `Plan written to ${written}`, 'Dry run: nothing was changed in the store.'].join('\n');
  return {
    exitCode: refused > 0 ? EXIT_ERROR : plan.changeSet.ops.length > 0 ? EXIT_CHANGES : EXIT_OK,
    json: { changeSet: plan.changeSet, hash: plan.hash, entries: plan.entries },
    text,
  };
}
