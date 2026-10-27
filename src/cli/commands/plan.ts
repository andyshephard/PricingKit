import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isOfferOp,
  basePriceOps,
  productKey,
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
  InvalidOfferRulesError,
  parseOfferRules,
  type OfferRules,
  type OfferSyncPlan,
  type ScheduledBasePolicy,
  describePlayRegionPrice,
  type OfferPlanEntry,
  type ProductRef,
} from '@/lib/pricing';
import { appSelection, stringFlag } from '../args';
import { appleAdapter, playAdapter, readOnly, writeOutputFile, type CommandContext, type CommandResult, type PriceReader } from '../context';
import { readSpecText } from '../spec-file';
import { CliError, EXIT_CHANGES, EXIT_ERROR, EXIT_OK, UsageError } from '../errors';
import { BASE_PRICE_NOTE } from './apply';
import { formatPlanSummary, summarizeChangeSet } from './diff';
import { sameApp } from './drift';
import { table } from '../format';

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
  const strategyWarnings: Array<{ product: ProductRef; territory: string; message: string }> = [];
  const states: ProductPriceState[] = [];

  for (const entry of spec.products) {
    const state = await reader.fetchState(entry.product);
    states.push(state);
    const { targets: raw, skipped, warnings } = specTargets(entry, state);
    unresolvedSkips.push(...skipped);
    for (const w of warnings ?? []) strategyWarnings.push({ product: entry.product, ...w });

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
    // Google Play base plan edits send a regions version: record Play's current one in the plan
    const regionsVersion =
      entry.product.platform === 'google' && entry.product.type === 'subscription' && Object.keys(targets).length > 0 ? await reader.fetchRegionsVersion?.() : undefined;
    products.push({
      state,
      targets,
      options: {
        ...(entry.allowNewTerritories !== undefined ? { allowNewTerritories: entry.allowNewTerritories } : {}),
        ...(entry.preserveCurrentPrice !== undefined ? { preserveCurrentPrice: entry.preserveCurrentPrice } : {}),
        ...(regionsVersion ? { regionsVersion } : {}),
      },
    });
  }

  const changeSet = buildChangeSet({ app: spec.app, ...(spec.description ? { description: spec.description } : {}), products, createdAt });
  const skipped = [...(changeSet.skipped ?? []), ...unresolvedSkips];
  // Strategy notes (e.g. a minimum price not enforced) go on the op they concern, or on "-" when that territory needs no change
  const warnings = [
    ...(changeSet.warnings ?? []),
    ...strategyWarnings.map((w) => {
      const op = basePriceOps(changeSet).find((o) => o.target.territory === w.territory && productKey(o.target.product) === productKey(w.product));
      return op ? { opId: op.id, message: `${w.territory}: ${w.message}` } : { opId: '-', message: `${productKey(w.product)} ${w.territory} (no change): ${w.message}` };
    }),
  ];
  return { changeSet: { ...changeSet, ...(skipped.length > 0 ? { skipped } : {}), ...(warnings.length > 0 ? { warnings } : {}) }, states };
}

export async function planCommand(ctx: CommandContext): Promise<CommandResult> {
  const rulesPath = stringFlag(ctx.flags, 'rules');
  const specPath = rulesPath === undefined ? stringFlag(ctx.flags, 'spec', true) : stringFlag(ctx.flags, 'spec');
  if (!rulesPath && ctx.flags['scheduled-base'] !== undefined) throw new UsageError('--scheduled-base goes with --rules');
  const explicitOut = stringFlag(ctx.flags, 'out');
  const out = explicitOut ?? DEFAULT_PLAN_FILE;
  // The default file name is easy to clobber by accident: keep an existing one unless told otherwise
  if (!explicitOut && ctx.flags.force !== true && existsSync(resolve(ctx.cwd, out))) {
    throw new UsageError(`${out} already exists. Pass --force to replace it, or choose a file with --out`);
  }
  const stateOut = stringFlag(ctx.flags, 'state-out');
  if (stateOut && stateOut === out) throw new UsageError('--out and --state-out must be different files');

  if (rulesPath) return planSyncCommand(ctx, rulesPath, specPath, out, stateOut);

  const specText = await readSpecText(ctx, specPath!, 'spec file');
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
    ...(changeSet.ops.length > 0 ? ['', ...baseApplyNote(spec.app)] : []),
  ].join('\n');
  return { exitCode: changeSet.ops.length > 0 ? EXIT_CHANGES : EXIT_OK, json: changeSet, text };
}

/** How a plan with base-price ops is applied, and the App Store caveat */
function baseApplyNote(app: PricingSpec['app']): string[] {
  return [
    'This plan changes base prices: "pricingkit apply" applies it only with --allow-base-prices (and --confirm <plan hash>).',
    ...('bundleId' in app ? [BASE_PRICE_NOTE] : []),
  ];
}

function specKind(text: string): unknown {
  try {
    return (JSON.parse(text) as { kind?: unknown })?.kind;
  } catch {
    return undefined;
  }
}

/** Regions left out because Play's price was further from the target than the deviation threshold */
export function deviationSkips(changeSet: ChangeSet): PlanSkip[] {
  return (changeSet.skipped ?? []).filter((s) => s.reason === 'DEVIATION_ABOVE_THRESHOLD');
}

function deviationNote(skips: PlanSkip[]): string[] {
  if (skips.length === 0) return [];
  return [
    '',
    `ERROR: ${skips.length} ${skips.length === 1 ? 'region was' : 'regions were'} left out because Play's price is further from the target than the deviation threshold (${skips.map((s) => `${s.offerKey ?? ''} ${s.territory}`.trim()).join(', ')}).`,
    'Review them; raise the threshold (play.deviationThreshold in the spec, deviationThreshold in a rules file) to accept those prices. Exit code 1.',
  ];
}

/** The read side of offer planning only: no way to reach applyOffer */
export interface OfferPlanner {
  planOffers(input: { app: OfferPlanSpec['app']; offers: OfferPlanSpec['offers']; createdAt?: string; description?: string }): Promise<OfferPlan>;
}

function productLabel(product: ProductRef): string {
  return product.platform === 'apple' ? product.id : product.type === 'subscription' ? `${product.productId}/${product.basePlanId}` : product.productId;
}

const ACTIONS: Record<OfferPlanEntry['action'], string> = {
  create: 'create',
  updatePrices: 'change prices',
  update: 'change',
  activate: 'activate',
  none: 'no change',
  refused: 'refused',
};

/** A Play offer's preview: what it will be (eligibility, phases, tags) and, per region, base price, offer price and discount */
export function formatPlayOfferPreview(entry: OfferPlanEntry): string[] {
  const p = entry.play;
  if (!p) return [];
  const tags = (list: string[]) => (list.length ? list.join(', ') : 'none');
  const change = (before: string | undefined, after: string) => (before === undefined ? `${after} (new offer)` : before === after ? `${after} (unchanged)` : `${before} -> ${after}`);
  const tagNotes = [...p.tagChanges.removed.map((t) => `removes ${t}`), ...(p.before ? p.tagChanges.added.map((t) => `adds ${t}`) : [])];
  const lines = [
    '',
    `Play offer ${p.offerId} on ${productLabel(entry.product)}: ${ACTIONS[entry.action]}${entry.opId ? ` (${entry.opId})` : ''}`,
    `  State: ${change(p.before?.state, p.state)}`,
    `  Eligibility: ${change(p.before?.eligibility, p.eligibility)}`,
    `  Phases: ${p.phases.join('; ')}`,
    `  Tags: ${change(p.before ? tags(p.before.tags) : undefined, tags(p.tags))}${tagNotes.length ? ` (${tagNotes.join(', ')})` : ''}`,
    ...(p.regionsVersion ? [`  Regions version: ${p.regionsVersion}`] : []),
  ];
  if (p.rows.length > 0) {
    lines.push(
      table([
        ['Region', 'Base price', 'Over the phase', 'Offer', 'Offer price', 'Discount', 'New subscribers', 'Notes'],
        ...p.rows.map((r) => [
          r.region,
          r.basePrice ? `${r.basePrice} ${r.currency}` : '-',
          r.proratedBase ? `${r.proratedBase} ${r.currency}` : '-',
          describePlayRegionPrice(r.config ?? undefined),
          r.offerPrice !== null ? `${r.estimated ? '~' : ''}${r.offerPrice} ${r.currency}` : '-',
          r.discount !== null ? `${r.discount} ${r.currency}${r.discountPercent !== null ? ` (${r.discountPercent}%)` : ''}` : '-',
          r.newSubscriberAvailability ? 'yes' : 'no',
          r.flags.map((f) => `${f.severity === 'error' ? 'SKIPPED: ' : ''}${f.message}`).join('; '),
        ]),
      ])
    );
    if (p.rows.some((r) => r.estimated)) lines.push('  ~ Play works discounted prices out itself; these are estimates.');
  }
  return lines;
}

export function formatOfferPlan(plan: OfferPlan): string {
  const lines = [formatPlanSummary(summarizeChangeSet(plan.changeSet))];
  for (const entry of plan.entries) {
    lines.push(...formatPlayOfferPreview(entry));
    const where = `${productLabel(entry.product)} ${entry.kind} ${entry.key}`;
    if (entry.action === 'none') lines.push('', `${where}: already matches its spec`);
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
  if (selected && !sameApp(selected, spec.app)) {
    throw new UsageError('The app given on the command line is not the app in the spec');
  }
  const adapter = 'bundleId' in spec.app ? await appleAdapter(ctx, spec.app.bundleId) : await playAdapter(ctx, spec.app.packageName);
  const planner: OfferPlanner = { planOffers: (input) => adapter.planOffers(input) };
  const plan = await planner.planOffers({ app: spec.app, offers: spec.offers, createdAt: ctx.now().toISOString(), ...(spec.description ? { description: spec.description } : {}) });
  if (plan.hash !== changeSetHash(plan.changeSet)) throw new CliError('Internal error: plan hash mismatch');
  const written = await writeOutputFile(ctx, out, serializeChangeSet(plan.changeSet));
  const refused = plan.entries.filter((e) => e.action === 'refused').length;
  const deviating = deviationSkips(plan.changeSet);
  const text = [formatOfferPlan(plan), '', `Plan written to ${written}`, 'Dry run: nothing was changed in the store.', ...deviationNote(deviating)].join('\n');
  return {
    exitCode: refused > 0 || deviating.length > 0 ? EXIT_ERROR : plan.changeSet.ops.length > 0 ? EXIT_CHANGES : EXIT_OK,
    json: { changeSet: plan.changeSet, hash: plan.hash, entries: plan.entries },
    text,
  };
}

// ---------------------------------------------------------------------------
// pricingkit plan --rules: keep offers in step with base prices

/** The read side of sync planning only: no way to reach apply() or applyOffer() */
export interface OfferSyncPlanner {
  planOfferSync(input: {
    rules: OfferRules;
    base?: ChangeSet;
    states?: ProductPriceState[];
    scheduledBase?: ScheduledBasePolicy;
    createdAt?: string;
    description?: string;
  }): Promise<OfferSyncPlan>;
}

const SCHEDULED_BASE: Record<string, ScheduledBasePolicy> = { hold: 'hold', now: 'deriveNow' };

export function formatSyncPlan(plan: OfferSyncPlan): string {
  const lines = [formatPlanSummary(summarizeChangeSet(plan.changeSet)), '', 'Offers in the rules file:'];
  const rows = plan.entries.map((e) => {
    const product = productLabel(e.product);
    const what =
      e.action === 'updatePrices'
        ? `${e.opId}: re-price ${e.play ? `${new Set(e.play.changes.map((c) => c.region)).size} regions` : `${e.changes.length} territories`} (${e.pricedAgainst === 'planTargets' ? "against this plan's base prices" : 'against current base prices'})`
        : e.action === 'none'
          ? `in step with its rule${e.pricedAgainst === 'planTargets' ? " at this plan's base prices" : ''}`
          : e.action === 'notSynced'
            ? 'syncWithBase is false: not synced (drift still checks it)'
            : e.action === 'followsBase'
              ? 'follows base automatically (Play relative discount)'
              : `needs manual action (${e.manual?.code})`;
    return [product, e.kind, e.key, what];
  });
  lines.push(table(rows));
  return lines.join('\n');
}

async function planSyncCommand(ctx: CommandContext, rulesPath: string, specPath: string | undefined, out: string, stateOut: string | undefined): Promise<CommandResult> {
  const flag = stringFlag(ctx.flags, 'scheduled-base');
  if (flag !== undefined && !SCHEDULED_BASE[flag]) throw new UsageError('--scheduled-base must be hold (default) or now');
  const scheduledBase = SCHEDULED_BASE[flag ?? 'hold'];
  if (stateOut && !specPath) throw new UsageError('--state-out saves the prices a base-price spec was planned against; it needs --spec');

  let rules: OfferRules;
  try {
    rules = parseOfferRules(await readSpecText(ctx, rulesPath, 'rules file'));
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof InvalidOfferRulesError) throw new CliError(error.message, 'INVALID_RULES');
    throw error;
  }
  const selected = appSelection(ctx.flags, false);
  if (selected && !sameApp(selected, rules.app)) {
    throw new UsageError('The app given on the command line is not the app in the rules file');
  }
  const play = 'packageName' in rules.app;
  if (play && ctx.flags['scheduled-base'] !== undefined) throw new UsageError('--scheduled-base is for App Store plans (Google Play has no scheduled base prices)');

  let spec: PricingSpec | undefined;
  if (specPath) {
    const specText = await readSpecText(ctx, specPath, 'spec file');
    if (specKind(specText) === OFFER_PLAN_SPEC_KIND) {
      throw new UsageError('--rules goes with a base-price spec (pricingkit.spec), or on its own; an offer plan spec creates offers and is planned without --rules');
    }
    try {
      spec = parsePricingSpec(specText);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError((error as Error).message, 'INVALID_SPEC');
    }
    if (JSON.stringify(spec.app) !== JSON.stringify(rules.app)) throw new UsageError('The spec and the rules file are for different apps');
  }

  const adapter = 'bundleId' in rules.app ? await appleAdapter(ctx, rules.app.bundleId) : await playAdapter(ctx, rules.app.packageName);
  const createdAt = ctx.now().toISOString();
  const basePlan = spec ? await planFromSpec(spec, readOnly(adapter), createdAt) : undefined;
  const planner: OfferSyncPlanner = { planOfferSync: (input) => adapter.planOfferSync(input) };
  const plan = await planner.planOfferSync({
    rules,
    ...(basePlan ? { base: basePlan.changeSet, states: basePlan.states } : {}),
    scheduledBase,
    createdAt,
    ...(spec?.description || rules.description ? { description: spec?.description ?? rules.description } : {}),
  });
  if (plan.hash !== changeSetHash(plan.changeSet)) throw new CliError('Internal error: plan hash mismatch');

  const written = await writeOutputFile(ctx, out, serializeChangeSet(plan.changeSet));
  const stateWritten =
    stateOut && basePlan ? await writeOutputFile(ctx, stateOut, serializeStateSnapshot(createStateSnapshot(rules.app, basePlan.states, createdAt))) : undefined;
  const hasBaseOps = plan.changeSet.ops.some((op) => !isOfferOp(op));
  const deviating = deviationSkips(plan.changeSet);
  const text = [
    formatSyncPlan(plan),
    '',
    `Plan written to ${written}`,
    ...(stateWritten ? [`State written to ${stateWritten}`] : []),
    'Dry run: nothing was changed in the store.',
    ...(hasBaseOps ? ['', ...baseApplyNote(rules.app)] : []),
    ...deviationNote(deviating),
  ].join('\n');
  return {
    exitCode: deviating.length > 0 ? EXIT_ERROR : plan.changeSet.ops.length > 0 || plan.manualActions.length > 0 ? EXIT_CHANGES : EXIT_OK,
    json: { changeSet: plan.changeSet, hash: plan.hash, entries: plan.entries, manualActions: plan.manualActions },
    text,
  };
}
