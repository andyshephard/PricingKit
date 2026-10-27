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
  checkFreshness,
  DEFAULT_MAX_AGE_DAYS,
  priceChangeNotes,
  REFERENCE_DATA,
  strategyReferenceData,
  type FreshnessEntry,
  type PriceNoteProductInput,
} from '@/lib/pricing';
import { appSelection, stringFlag } from '../args';
import { appleAdapter, playAdapter, readOnly, writeOutputFile, type CommandContext, type CommandResult, type PriceReader } from '../context';
import { inlineMultiplierFiles, inlinePricesFiles, readSpecText, type CsvImport } from '../spec-file';
import { csvImportOutcomes, formatCsvOutcomes, withCsvWarnings } from '../csv-report';
import { CliError, EXIT_CHANGES, EXIT_ERROR, EXIT_OK, UsageError } from '../errors';
import { BASE_PRICE_NOTE } from './apply';
import { formatPlanSummary, summarizeChangeSet } from './diff';
import { sameApp } from './drift';
import { table } from '../format';
import { planWorkspaceCommand } from './workspace';

export const DEFAULT_PLAN_FILE = 'pricingkit-plan.json';

export interface PlanOutcome {
  changeSet: ChangeSet;
  states: ProductPriceState[];
}

/**
 * Spec -> ChangeSet. Reads each product's state, builds its targets, snaps
 * them with the store and diffs. Takes only a PriceReader, so it can't write.
 * Adds planner notes: per op what existing subscribers see, proceeds and tax
 * (priceChanges), and the age of the reference data used (dataFreshness).
 */
export async function planFromSpec(spec: PricingSpec, reader: PriceReader, createdAt: string): Promise<PlanOutcome> {
  const products: Parameters<typeof buildChangeSet>[0]['products'] = [];
  const unresolvedSkips: PlanSkip[] = [];
  const strategyWarnings: Array<{ product: ProductRef; territory: string; message: string }> = [];
  const states: ProductPriceState[] = [];
  const noteInputs: PriceNoteProductInput[] = [];
  const now = new Date(createdAt);

  for (const entry of spec.products) {
    const state = await reader.fetchState(entry.product);
    states.push(state);
    const { targets: raw, skipped, warnings } = specTargets(entry, state, { now });
    unresolvedSkips.push(...skipped);
    for (const w of warnings ?? []) strategyWarnings.push({ product: entry.product, ...w });

    const measure = entry.measure ?? 'customerPrice';
    const resolveOptions = {
      mode: entry.snap ?? 'nearest',
      ...(measure === 'proceeds' ? { measure } : {}),
      ...(entry.commission ? { commission: entry.commission } : {}),
    } as const;
    const resolved = Object.keys(raw).length > 0 ? await reader.resolvePricePoints(entry.product, raw, resolveOptions) : { resolved: {}, unresolved: {} };
    for (const [territory, reason] of Object.entries(resolved.unresolved)) {
      unresolvedSkips.push({ product: entry.product, territory, reason: 'UNRESOLVED_PRICE_POINT', detail: reason });
    }
    const targets: Record<string, TargetPrice> = {};
    for (const [territory, price] of Object.entries(resolved.resolved)) {
      const note =
        price.measure === 'proceeds'
          ? `target proceeds ${price.target} ${price.currency}, proceeds ${price.proceeds ?? '?'}${price.proceedsEstimated ? ' (estimated)' : ''} at price ${price.amount} (${price.deviation}, ${price.deviationRatio})`
          : price.deviation !== '0'
            ? `target ${price.target} ${price.currency}, snapped by ${price.deviation} (${price.deviationRatio})`
            : undefined;
      targets[territory] = {
        currency: price.currency,
        amount: price.amount,
        ...(price.pricePointId ? { pricePointId: price.pricePointId } : {}),
        // Only store-reported proceeds go into the op (Apple); Play's are estimates and stay in the notes
        ...(price.proceeds && !price.proceedsEstimated ? { proceeds: price.proceeds } : {}),
        ...(entry.startDate ? { startDate: entry.startDate } : {}),
        ...(note ? { note } : {}),
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
    const exchangeRates = entry.targets.type === 'strategy' ? entry.targets.exchangeRates : undefined;
    const consent = entry.consent || exchangeRates
      ? {
          ...(entry.consent?.billingPeriod ? { billingPeriod: entry.consent.billingPeriod } : {}),
          ...(entry.consent?.lastIncreaseAt ? { lastIncreaseAt: entry.consent.lastIncreaseAt } : {}),
          ...(exchangeRates ? { exchangeRates } : {}),
        }
      : undefined;
    noteInputs.push({
      state,
      ...(consent ? { consent } : {}),
      measure,
      ...(entry.commission ? { commission: entry.commission } : {}),
      resolved: resolved.resolved,
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
  const priceChanges = priceChangeNotes(basePriceOps(changeSet), noteInputs, createdAt);
  const dataFreshness = specFreshness(spec, states, now);
  for (const f of dataFreshness) if (f.stale) warnings.push({ opId: '-', message: `Reference data: ${f.message}` });
  return {
    changeSet: {
      ...changeSet,
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(priceChanges.length > 0 ? { priceChanges } : {}),
      ...(dataFreshness.length > 0 ? { dataFreshness } : {}),
    },
    states,
  };
}

/** The reference data a spec's strategy targets read, with their ages */
export function specFreshness(spec: PricingSpec, states: ProductPriceState[], now: Date): FreshnessEntry[] {
  const maxAge = spec.freshness?.maxAgeDays ?? {};
  const entries = new Map<string, FreshnessEntry>();
  const add = (info: Parameters<typeof checkFreshness>[0]) => {
    if (!entries.has(info.id)) entries.set(info.id, checkFreshness(info, now, maxAge[info.id] ?? DEFAULT_MAX_AGE_DAYS[info.id]));
  };
  spec.products.forEach((entry, i) => {
    if (entry.targets.type !== 'strategy') return;
    const t = entry.targets;
    for (const id of strategyReferenceData(t.strategy)) add(REFERENCE_DATA[id]);
    if (t.exchangeRates) add({ id: 'exchangeRates', label: 'Exchange rates (spec)', ...(t.exchangeRatesAsOf ? { asOf: t.exchangeRatesAsOf } : {}) });
    // Any territory currency the spec gives no rate for is converted with the built-in fallback rates
    const currencies = new Set(Object.values(states[i]?.territories ?? {}).map((s) => s.currency).filter((c) => c && c !== 'USD'));
    if (t.base.currency && t.base.currency !== 'USD') currencies.add(t.base.currency);
    if ([...currencies].some((c) => !t.exchangeRates?.[c])) add(REFERENCE_DATA.fallbackExchangeRates);
  });
  return [...entries.values()];
}

/** Planning stops here, before any file is written, when the spec's guards say so */
export function assertSpecGuards(spec: PricingSpec, changeSet: ChangeSet): void {
  const ops = new Map(basePriceOps(changeSet).map((op) => [op.id, op]));
  const refused: string[] = [];
  spec.products.forEach((entry) => {
    if (!entry.consent?.maxIncreaseWithoutConsent) return;
    for (const note of changeSet.priceChanges ?? []) {
      const op = ops.get(note.opId);
      if (op && productKey(op.target.product) === productKey(entry.product) && note.classification === 'increase-needs-consent') {
        refused.push(`${productKey(entry.product)} ${note.territory} (${note.percent ?? '?'}%): ${note.reasons[note.reasons.length - 1] ?? 'needs consent'}`);
      }
    }
  });
  if (refused.length > 0) {
    throw new CliError(
      `The spec sets maxIncreaseWithoutConsent, but ${refused.length} territories would need existing subscribers' consent; no plan was written:\n  ${refused.join('\n  ')}\nKeep their price for existing subscribers (preserveCurrentPrice), lower the increase, or remove the guard.`,
      'CONSENT_REQUIRED'
    );
  }
  const stale = (changeSet.dataFreshness ?? []).filter((f) => f.stale);
  if (spec.freshness?.refuseStale && stale.length > 0) {
    throw new CliError(`The spec sets freshness.refuseStale and the plan used stale reference data; no plan was written:\n  ${stale.map((f) => f.message).join('\n  ')}`, 'STALE_REFERENCE_DATA');
  }
}

export async function planCommand(ctx: CommandContext): Promise<CommandResult> {
  const workspacePath = stringFlag(ctx.flags, 'workspace');
  if (workspacePath) return planWorkspaceCommand(ctx, workspacePath);
  if (ctx.flags['out-dir'] !== undefined) throw new UsageError('--out-dir goes with --workspace');
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

  const rawSpecText = await readSpecText(ctx, specPath!, 'spec file');
  if (specKind(rawSpecText) === OFFER_PLAN_SPEC_KIND) return planOffersCommand(ctx, rawSpecText, out, specPath!);
  const { text: specText, imports } = await inlinePricesFiles(ctx, await inlineMultiplierFiles(ctx, rawSpecText, specPath!), specPath!);

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
  const planned = await planFromSpec(spec, readOnly(adapter), ctx.now().toISOString());
  const { states } = planned;
  assertSpecGuards(spec, planned.changeSet);
  // Prices from a CSV: report rows that didn't become exactly the planned price
  const csvOutcomes = csvImportOutcomes(imports, planned.changeSet, states);
  const changeSet = withCsvWarnings(planned.changeSet, csvOutcomes);

  const written = await writeOutputFile(ctx, out, serializeChangeSet(changeSet));
  const stateWritten = stateOut ? await writeOutputFile(ctx, stateOut, serializeStateSnapshot(createStateSnapshot(spec.app, states, ctx.now().toISOString()))) : undefined;

  const text = [
    formatPlanSummary(summarizeChangeSet(changeSet)),
    ...formatCsvOutcomes(csvOutcomes),
    '',
    `Plan written to ${written}`,
    ...(stateWritten ? [`State written to ${stateWritten}`] : []),
    'Dry run: nothing was changed in the store.',
    ...(changeSet.ops.length > 0 ? ['', ...baseApplyNote(spec.app)] : []),
  ].join('\n');
  return { exitCode: changeSet.ops.length > 0 ? EXIT_CHANGES : EXIT_OK, json: changeSet, text };
}

/** How a plan with base-price ops is applied, and the App Store caveat */
export function baseApplyNote(app: PricingSpec['app']): string[] {
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

export function deviationNote(skips: PlanSkip[]): string[] {
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
async function planOffersCommand(ctx: CommandContext, rawSpecText: string, out: string, specPath: string): Promise<CommandResult> {
  const { text: specText, imports } = await inlinePricesFiles(ctx, rawSpecText, specPath);
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
  const offerPlan = await planner.planOffers({ app: spec.app, offers: spec.offers, createdAt: ctx.now().toISOString(), ...(spec.description ? { description: spec.description } : {}) });
  if (offerPlan.hash !== changeSetHash(offerPlan.changeSet)) throw new CliError('Internal error: plan hash mismatch');
  const csvOutcomes = csvImportOutcomes(imports, offerPlan.changeSet);
  const plan = { ...offerPlan, changeSet: withCsvWarnings(offerPlan.changeSet, csvOutcomes) };
  const written = await writeOutputFile(ctx, out, serializeChangeSet(plan.changeSet));
  const refused = plan.entries.filter((e) => e.action === 'refused').length;
  const deviating = deviationSkips(plan.changeSet);
  const text = [formatOfferPlan(plan), ...formatCsvOutcomes(csvOutcomes), '', `Plan written to ${written}`, 'Dry run: nothing was changed in the store.', ...deviationNote(deviating)].join('\n');
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
  let imports: CsvImport[] = [];
  if (specPath) {
    const inlined = await inlinePricesFiles(ctx, await inlineMultiplierFiles(ctx, await readSpecText(ctx, specPath, 'spec file'), specPath), specPath);
    const specText = inlined.text;
    imports = inlined.imports;
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
  if (spec && basePlan) assertSpecGuards(spec, basePlan.changeSet);
  const planner: OfferSyncPlanner = { planOfferSync: (input) => adapter.planOfferSync(input) };
  const syncPlan = await planner.planOfferSync({
    rules,
    ...(basePlan ? { base: basePlan.changeSet, states: basePlan.states } : {}),
    scheduledBase,
    createdAt,
    ...(spec?.description || rules.description ? { description: spec?.description ?? rules.description } : {}),
  });
  if (syncPlan.hash !== changeSetHash(syncPlan.changeSet)) throw new CliError('Internal error: plan hash mismatch');
  const csvOutcomes = basePlan ? csvImportOutcomes(imports, syncPlan.changeSet, basePlan.states) : [];
  const plan = { ...syncPlan, changeSet: withCsvWarnings(syncPlan.changeSet, csvOutcomes) };

  const written = await writeOutputFile(ctx, out, serializeChangeSet(plan.changeSet));
  const stateWritten =
    stateOut && basePlan ? await writeOutputFile(ctx, stateOut, serializeStateSnapshot(createStateSnapshot(rules.app, basePlan.states, createdAt))) : undefined;
  const hasBaseOps = plan.changeSet.ops.some((op) => !isOfferOp(op));
  const deviating = deviationSkips(plan.changeSet);
  const text = [
    formatSyncPlan(plan),
    ...formatCsvOutcomes(csvOutcomes),
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
