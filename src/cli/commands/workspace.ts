// Workspaces in the CLI: plan, diff, apply, undo and drift across several
// apps (pricingkit.workspace, see src/lib/pricing/workspace.ts).
//
// One plan per app, never one plan for several apps. `plan --workspace`
// writes each app's plan (and its offer plan) as an ordinary plan file, plus
// a workspace plan index listing them in apply order under one combined
// hash. Every plan keeps the per-app checks it has on its own: its hash
// covers its app, apply builds the adapter for that app only (verifyApp,
// verifyProduct), the PRICINGKIT_EXPECT_* pins cover every app before
// anything is read, and each plan has its own run log for resume and undo.

import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  appLabel,
  basePriceOps,
  buildParityReport,
  buildUndoChangeSet,
  buildWorkspacePlan,
  changeSetHash,
  isOfferOp,
  parityAppleProduct,
  parityMappingReport,
  parityPlayProduct,
  parseChangeSet,
  parseRun,
  parseWorkspacePlan,
  plannedParityMappingReport,
  productKey,
  sameAppRef,
  serializeChangeSet,
  serializeWorkspacePlan,
  WorkspaceError,
  type ApplyRun,
  type AppRef,
  type ChangeSet,
  type ParityMappingReport,
  type ParityReport,
  type ProductPriceState,
  type RulesDriftReport,
  type ScheduledBasePolicy,
  type WorkspacePlan,
  type WorkspacePlanEntry,
} from '@/lib/pricing';
import type { AppleAdapter } from '@/lib/adapters/apple';
import type { PlayAdapter } from '@/lib/adapters/play';
import { stringFlag } from '../args';
import { adapterForApp, readInputFile, readOnly, writeOutputFile, writeOutputFileAtomic, type CommandContext, type CommandResult } from '../context';
import { csvImportOutcomes, formatCsvOutcomes, offerImportStates, withCsvWarnings, type CsvRowOutcome } from '../csv-report';
import { CliError, EXIT_CHANGES, EXIT_ERROR, EXIT_OK, UsageError, type ExitCode } from '../errors';
import { loadWorkspace, type LoadedWorkspace, type LoadedWorkspaceApp } from '../workspace';
import { defaultRunFile } from './apply';
import { formatPlanSummary, summarizeChangeSet, type PlanSummary } from './diff';
import { formatRulesDriftReport, rulesDriftExitCode } from './drift';
import { assertSpecGuards, baseApplyNote, deviationNote, deviationSkips, formatOfferPlan, formatSyncPlan, planFromSpec } from './plan';
import { formatParityReport } from './parity';
import { defaultUndoFile } from './undo';

export const DEFAULT_WORKSPACE_PLAN_DIR = 'pricingkit-plans';
export const WORKSPACE_PLAN_INDEX = 'workspace-plan.json';

type AnyAdapter = AppleAdapter | PlayAdapter;

/** Adapters built on first use, one per app, never shared between apps */
class AdapterPool {
  private readonly adapters = new Map<string, Promise<AnyAdapter>>();
  constructor(private readonly ctx: CommandContext) {}
  get(app: AppRef): Promise<AnyAdapter> {
    const key = JSON.stringify(app);
    if (!this.adapters.has(key)) this.adapters.set(key, adapterForApp(this.ctx, app));
    return this.adapters.get(key)!;
  }
}

export function header(appId: string, app: AppRef, part: string): string {
  return `== ${appId}: ${appLabel(app)}, ${part}`;
}

// ---------------------------------------------------------------------------
// plan --workspace

interface AppPlans {
  prices?: { changeSet: ChangeSet; text: string[]; manual: number; failed: boolean };
  offers?: { changeSet: ChangeSet; text: string[]; failed: boolean };
  states: ProductPriceState[];
  csv: CsvRowOutcome[];
}

async function planApp(loaded: LoadedWorkspaceApp, adapter: AnyAdapter, createdAt: string, scheduledBase: ScheduledBasePolicy): Promise<AppPlans> {
  const out: AppPlans = { states: [], csv: [] };
  const baseImports = loaded.csvImports.filter((i) => !i.offer);
  const offerImports = loaded.csvImports.filter((i) => i.offer);
  const description = loaded.entry.description;
  if (loaded.spec || loaded.rules) {
    // Every product must belong to this app before its prices are read (team-wide App Store keys reach every app)
    for (const entry of loaded.spec?.products ?? []) await adapter.verifyProduct(entry.product);
    const basePlan = loaded.spec ? await planFromSpec(loaded.spec, readOnly(adapter), createdAt) : undefined;
    if (loaded.spec && basePlan) assertSpecGuards(loaded.spec, basePlan.changeSet);
    out.states = basePlan?.states ?? [];
    let changeSet: ChangeSet;
    let text: string[];
    let manual = 0;
    let failed = false;
    if (loaded.rules) {
      const plan = await adapter.planOfferSync({
        rules: loaded.rules,
        ...(basePlan ? { base: basePlan.changeSet, states: basePlan.states } : {}),
        ...('bundleId' in loaded.entry.app ? { scheduledBase } : {}),
        createdAt,
        ...(description ? { description } : {}),
      });
      if (plan.hash !== changeSetHash(plan.changeSet)) throw new CliError('Internal error: plan hash mismatch');
      changeSet = plan.changeSet;
      manual = plan.manualActions.length;
      text = [formatSyncPlan(plan)];
      failed = deviationSkips(changeSet).length > 0;
    } else {
      changeSet = basePlan!.changeSet;
      text = [formatPlanSummary(summarizeChangeSet(changeSet))];
    }
    const csv = csvImportOutcomes(baseImports, changeSet, out.states);
    out.csv.push(...csv);
    changeSet = withCsvWarnings(changeSet, csv);
    text.push(...formatCsvOutcomes(csv), ...deviationNote(deviationSkips(changeSet)));
    out.prices = { changeSet, text, manual, failed };
  }
  if (loaded.offers) {
    const plan = await adapter.planOffers({ app: loaded.offers.app, offers: loaded.offers.offers, createdAt, ...(loaded.offers.description ? { description: loaded.offers.description } : {}) });
    if (plan.hash !== changeSetHash(plan.changeSet)) throw new CliError('Internal error: plan hash mismatch');
    const csv = csvImportOutcomes(offerImports, plan.changeSet, await offerImportStates(offerImports, readOnly(adapter)));
    out.csv.push(...csv);
    const changeSet = withCsvWarnings(plan.changeSet, csv);
    const deviating = deviationSkips(changeSet);
    out.offers = {
      changeSet,
      text: [formatOfferPlan({ ...plan, changeSet }), ...formatCsvOutcomes(csv), ...deviationNote(deviating)],
      failed: plan.entries.some((e) => e.action === 'refused') || deviating.length > 0,
    };
  }
  return out;
}

/** Rename files to <name>.stale-<timestamp> (a free name), so a new plan can't be resumed or undone with them */
async function moveAside(ctx: CommandContext, dir: string, names: string[], at: string): Promise<Array<{ from: string; to: string }>> {
  const stamp = at.replace(/[^0-9]/g, '').slice(0, 14);
  const moved: Array<{ from: string; to: string }> = [];
  for (const name of names) {
    let to = `${name}.stale-${stamp}`;
    for (let n = 2; existsSync(resolve(ctx.cwd, dir, to)); n++) to = `${name}.stale-${stamp}-${n}`;
    await rename(resolve(ctx.cwd, dir, name), resolve(ctx.cwd, dir, to));
    moved.push({ from: name, to });
  }
  return moved;
}

/** The undo index next to a workspace plan index: x.json -> x.undo.json (never the input itself) */
export function workspaceUndoIndexPath(indexPath: string): string {
  return join(dirname(indexPath), `${basename(indexPath).replace(/\.json$/i, '')}.undo.json`);
}

function planEntry(appId: string, app: AppRef, part: WorkspacePlanEntry['part'], file: string, changeSet: ChangeSet): WorkspacePlanEntry {
  const offerOps = changeSet.ops.filter(isOfferOp).length;
  return {
    appId,
    app,
    part,
    file,
    hash: changeSetHash(changeSet),
    ops: changeSet.ops.length,
    baseOps: changeSet.ops.length - offerOps,
    offerOps,
    manualActions: changeSet.manualActions?.length ?? 0,
  };
}

/** Parity on the prices the plans leave (current prices where a plan changes nothing) */
async function plannedParity(loaded: LoadedWorkspace, results: Map<string, AppPlans>, pool: AdapterPool, checkedAt: string): Promise<ParityReport | undefined> {
  const mappings = loaded.workspace.parity ?? [];
  if (mappings.length === 0) return undefined;
  const reports: ParityMappingReport[] = [];
  const stateFor = async (app: AppRef, product: ReturnType<typeof parityAppleProduct> | ReturnType<typeof parityPlayProduct>) => {
    const entry = loaded.apps.find((a) => sameAppRef(a.entry.app, app))!;
    const plans = results.get(entry.entry.id);
    const known = plans?.states.find((s) => productKey(s.product) === productKey(product));
    const ops = plans?.prices ? basePriceOps(plans.prices.changeSet) : [];
    if (known) return { state: known, ops };
    const adapter = await pool.get(app);
    await adapter.verifyProduct(product);
    return { state: await readOnly(adapter).fetchState(product), ops };
  };
  for (const mapping of mappings) {
    const apple = await stateFor({ bundleId: mapping.apple.bundleId }, parityAppleProduct(mapping));
    const play = await stateFor({ packageName: mapping.play.packageName }, parityPlayProduct(mapping));
    reports.push(plannedParityMappingReport(mapping, apple.state, apple.ops, play.state, play.ops));
  }
  return buildParityReport(reports, 'plan', checkedAt);
}

export async function planWorkspaceCommand(ctx: CommandContext, workspacePath: string): Promise<CommandResult> {
  for (const flag of ['spec', 'rules', 'out', 'state-out', 'bundle-id', 'package-name']) {
    if (ctx.flags[flag] !== undefined) throw new UsageError(`--workspace plans every app from the workspace file; drop --${flag} (plans go to --out-dir)`);
  }
  const scheduledFlag = stringFlag(ctx.flags, 'scheduled-base');
  if (scheduledFlag !== undefined && scheduledFlag !== 'hold' && scheduledFlag !== 'now') throw new UsageError('--scheduled-base must be hold (default) or now');
  const scheduledBase: ScheduledBasePolicy = scheduledFlag === 'now' ? 'deriveNow' : 'hold';
  const outDir = stringFlag(ctx.flags, 'out-dir') ?? DEFAULT_WORKSPACE_PLAN_DIR;

  const loaded = await loadWorkspace(ctx, workspacePath);
  // Never replace earlier plans by accident
  const files: Array<{ appId: string; part: WorkspacePlanEntry['part']; file: string }> = [];
  for (const app of loaded.apps) {
    if (app.spec || app.rules) files.push({ appId: app.entry.id, part: 'prices', file: `${app.entry.id}.json` });
    if (app.offers) files.push({ appId: app.entry.id, part: 'offers', file: `${app.entry.id}.offers.json` });
  }
  if (files.length === 0 && !(loaded.workspace.parity ?? []).length) throw new UsageError('The workspace has no specs, rules or offer specs to plan');
  // Run logs and undo plans of earlier plans with these names: a new plan must never be resumed from
  // (or undone with) them. Kept, not deleted: they are what undoes an earlier run.
  const leftovers = [WORKSPACE_PLAN_INDEX, ...files.map((f) => f.file)]
    .flatMap((f) => {
      const base = f.replace(/\.json$/, '');
      return [`${base}.run.json`, `${base}.undo.json`, `${base}.undo.run.json`];
    })
    .filter((f) => existsSync(resolve(ctx.cwd, outDir, f)));
  if (ctx.flags.force !== true) {
    const existing = [WORKSPACE_PLAN_INDEX, ...files.map((f) => f.file)].filter((f) => existsSync(resolve(ctx.cwd, outDir, f)));
    if (existing.length > 0 || leftovers.length > 0) {
      throw new UsageError(
        `${outDir} already has ${[...existing, ...leftovers].join(', ')}. Pass --force to replace the plans (run logs and undo plans are then moved aside, not deleted), or choose another --out-dir`
      );
    }
  }

  const pool = new AdapterPool(ctx);
  const createdAt = ctx.now().toISOString();
  const results = new Map<string, AppPlans>();
  for (const app of loaded.apps) {
    if (!app.spec && !app.rules && !app.offers) continue;
    results.set(app.entry.id, await planApp(app, await pool.get(app.entry.app), createdAt, scheduledBase));
  }
  const parity = await plannedParity(loaded, results, pool, createdAt);

  await mkdir(resolve(ctx.cwd, outDir), { recursive: true });
  const movedAside = await moveAside(ctx, outDir, leftovers, createdAt);
  const entries: WorkspacePlanEntry[] = [];
  const text: string[] = [`Workspace ${workspacePath}: ${loaded.apps.length} apps (${loaded.apps.map((a) => `${a.entry.id} ${appLabel(a.entry.app)}`).join(', ')})`];
  if (movedAside.length > 0) {
    text.push(`Moved aside the run logs and undo plans of the earlier plans (keep them to undo those runs): ${movedAside.map((m) => `${m.from} -> ${m.to}`).join(', ')}`);
  }
  const plans: Record<string, ChangeSet> = {};
  let failed = false;
  let changes = false;
  let anyBase = false;
  for (const app of loaded.apps) {
    const result = results.get(app.entry.id);
    if (!result) continue;
    for (const part of ['prices', 'offers'] as const) {
      const plan = result[part];
      if (!plan) continue;
      const file = part === 'prices' ? `${app.entry.id}.json` : `${app.entry.id}.offers.json`;
      const written = await writeOutputFile(ctx, join(outDir, file), serializeChangeSet(plan.changeSet));
      const entry = planEntry(app.entry.id, app.entry.app, part, file, plan.changeSet);
      entries.push(entry);
      plans[file] = plan.changeSet;
      failed ||= plan.failed;
      changes ||= entry.ops > 0 || entry.manualActions > 0;
      anyBase ||= entry.baseOps > 0;
      text.push('', header(app.entry.id, app.entry.app, part === 'prices' ? 'base prices and offer sync' : 'offers'), ...plan.text, `Plan written to ${written}`);
    }
  }
  if (parity) {
    text.push('', formatParityReport(parity));
    changes ||= !parity.inParity;
  }
  const index = buildWorkspacePlan({ createdAt, ...(loaded.workspace.description ? { description: loaded.workspace.description } : {}), plans: entries, ...(parity ? { parity } : {}) });
  const indexPath = join(outDir, WORKSPACE_PLAN_INDEX);
  const writtenIndex = await writeOutputFile(ctx, indexPath, serializeWorkspacePlan(index));
  const withOps = entries.filter((e) => e.ops > 0);
  text.push(
    '',
    `Workspace plan written to ${writtenIndex}: ${entries.length} plan files for ${new Set(entries.map((e) => e.appId)).size} apps, ${withOps.length} with changes`,
    ...(withOps.length > 0
      ? [
          `Workspace plan hash: ${index.hash} (covers every plan above, in order; each plan is still applied on its own, for its own app)`,
          `Apply with: pricingkit apply --workspace-plan ${indexPath} --confirm <the workspace plan hash>${anyBase ? ' --allow-base-prices' : ''}`,
          ...(anyBase ? withOps.filter((e) => e.baseOps > 0).flatMap((e) => baseApplyNote(e.app)).filter((l, i, all) => all.indexOf(l) === i) : []),
        ]
      : []),
    'Dry run: nothing was changed in any store.'
  );
  const csv = [...results.values()].flatMap((r) => r.csv);
  return {
    exitCode: failed ? EXIT_ERROR : changes ? EXIT_CHANGES : EXIT_OK,
    json: { workspacePlan: index, plans, ...(csv.length > 0 ? { csvImport: csv } : {}) },
    text: text.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Reading a workspace plan index and its plans

export interface IndexedPlan {
  entry: WorkspacePlanEntry;
  path: string;
  changeSet: ChangeSet;
}

/** The index and every plan it lists, each checked: same app, same hash as when planned */
export async function readWorkspacePlan(ctx: CommandContext, indexPath: string): Promise<{ index: WorkspacePlan; plans: IndexedPlan[] }> {
  let index: WorkspacePlan;
  try {
    index = parseWorkspacePlan(await readInputFile(ctx, indexPath, 'workspace plan'));
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof WorkspaceError) throw new CliError(error.message, 'INVALID_PLAN');
    throw error;
  }
  const plans: IndexedPlan[] = [];
  for (const entry of index.plans) {
    const path = join(dirname(indexPath), entry.file);
    let changeSet: ChangeSet;
    try {
      changeSet = parseChangeSet(await readInputFile(ctx, path, 'plan file'));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(`${entry.file}: ${(error as Error).message}`, 'INVALID_PLAN');
    }
    if (!sameAppRef(changeSet.app, entry.app)) {
      throw new CliError(`${entry.file} is a plan for ${appLabel(changeSet.app)}, but the workspace plan lists it for ${appLabel(entry.app)}; nothing was read or sent`, 'APP_MISMATCH');
    }
    if (changeSetHash(changeSet) !== entry.hash) {
      throw new CliError(`${entry.file} has changed since the workspace plan was written; plan the workspace again`, 'PLAN_CHANGED');
    }
    plans.push({ entry, path, changeSet });
  }
  return { index, plans };
}

// ---------------------------------------------------------------------------
// diff --workspace-plan

export async function diffWorkspaceCommand(ctx: CommandContext, indexPath: string): Promise<CommandResult> {
  const { index, plans } = await readWorkspacePlan(ctx, indexPath);
  const summaries: Array<{ file: string; appId: string; part: string; summary: PlanSummary }> = [];
  const apps = [...new Map(plans.map((p) => [JSON.stringify(p.entry.app), p.entry])).values()];
  const text = [
    `Workspace plan ${indexPath}, created ${index.createdAt}${index.description ? `: ${index.description}` : ''}`,
    `It changes ${apps.length} ${apps.length === 1 ? 'app' : 'apps'}, one plan file each (plus offer plans): ${apps.map((a) => `${a.appId} ${appLabel(a.app)}`).join(', ')}`,
  ];
  for (const plan of plans) {
    const summary = summarizeChangeSet(plan.changeSet);
    summaries.push({ file: plan.entry.file, appId: plan.entry.appId, part: plan.entry.part, summary });
    text.push('', header(plan.entry.appId, plan.entry.app, `${plan.entry.part} (${plan.entry.file})`), formatPlanSummary(summary));
  }
  if (index.parity) text.push('', formatParityReport(index.parity));
  const changes = plans.some((p) => p.changeSet.ops.length > 0 || (p.changeSet.manualActions?.length ?? 0) > 0);
  text.push('', `Workspace plan hash: ${index.hash} (what "pricingkit apply --workspace-plan --confirm" needs once you have reviewed every plan above)`);
  return { exitCode: changes ? EXIT_CHANGES : EXIT_OK, json: { workspacePlan: index, plans: summaries }, text: text.join('\n') };
}

/** diff with several plan files: each under its app, and a line saying how many apps they cover */
export async function diffManyCommand(ctx: CommandContext, paths: string[]): Promise<CommandResult> {
  const summaries: Array<{ file: string; summary: PlanSummary }> = [];
  for (const path of paths) {
    let changeSet: ChangeSet;
    try {
      changeSet = parseChangeSet(await readInputFile(ctx, path, 'plan file'));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(`${path}: ${(error as Error).message}`, 'INVALID_PLAN');
    }
    summaries.push({ file: path, summary: summarizeChangeSet(changeSet) });
  }
  const apps = [...new Set(summaries.map((s) => JSON.stringify(s.summary.app)))].map((a) => appLabel(JSON.parse(a) as AppRef));
  const text = [
    apps.length > 1
      ? `These ${paths.length} plans change ${apps.length} apps: ${apps.join(', ')}. Each plan is for one app and is applied on its own, with its own hash.`
      : `These ${paths.length} plans are all for ${apps[0]}.`,
  ];
  for (const s of summaries) text.push('', `== ${s.file}: ${appLabel(s.summary.app)}`, formatPlanSummary(s.summary));
  const changes = summaries.some((s) => s.summary.opCount > 0 || s.summary.manualActions.length > 0);
  return { exitCode: changes ? EXIT_CHANGES : EXIT_OK, json: summaries, text: text.join('\n') };
}

// ---------------------------------------------------------------------------
// undo --workspace-plan

export async function undoWorkspaceCommand(ctx: CommandContext, indexPath: string): Promise<CommandResult> {
  if (ctx.positionals.length > 0 || ctx.flags.out !== undefined) throw new UsageError('--workspace-plan undoes every plan it lists from the run logs next to them; give no other files');
  const { plans } = await readWorkspacePlan(ctx, indexPath);
  const undoIndexPath = workspaceUndoIndexPath(indexPath);
  // Newest first: the last plan applied is undone first
  const reversed = [...plans].reverse();
  const targets = reversed
    .filter((p) => existsSync(resolve(ctx.cwd, defaultRunFile(p.path))))
    .map((p) => ({ plan: p, out: defaultUndoFile(p.path) }));
  if (ctx.flags.force !== true) {
    const existing = [undoIndexPath, ...targets.map((t) => t.out)].filter((f) => existsSync(resolve(ctx.cwd, f)));
    if (existing.length > 0) throw new UsageError(`${existing.join(', ')} already exist. Pass --force to replace them`);
  }
  const entries: WorkspacePlanEntry[] = [];
  const text: string[] = [`Undo of workspace plan ${indexPath}`];
  const notReversible: Array<{ file: string; opId: string; reason: string }> = [];
  let deletes = false;
  for (const { plan, out } of targets) {
    let run: ApplyRun;
    try {
      run = parseRun(await readInputFile(ctx, defaultRunFile(plan.path), 'run log'));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(`${defaultRunFile(plan.path)}: ${(error as Error).message}`, 'INVALID_RUN');
    }
    let undo: ChangeSet;
    try {
      undo = buildUndoChangeSet(plan.changeSet, run, { createdAt: ctx.now().toISOString() });
    } catch (error) {
      throw new CliError(`${plan.entry.file}: ${(error as Error).message}`, 'INVALID_RUN');
    }
    const written = await writeOutputFileAtomic(ctx, out, serializeChangeSet(undo));
    deletes ||= undo.ops.some((op) => isOfferOp(op) && op.kind === 'deleteOffer');
    entries.push(planEntry(plan.entry.appId, plan.entry.app, plan.entry.part, basename(out), undo));
    for (const n of undo.notReversible ?? []) notReversible.push({ file: plan.entry.file, ...n });
    text.push('', header(plan.entry.appId, plan.entry.app, `undo of ${plan.entry.file}`), formatPlanSummary(summarizeChangeSet(undo)), `Undo plan written to ${written}`);
  }
  for (const p of reversed.filter((p) => !targets.some((t) => t.plan === p))) text.push('', `${p.entry.file}: no run log, nothing to undo`);
  const index = buildWorkspacePlan({ createdAt: ctx.now().toISOString(), description: `Undo of ${basename(indexPath)}`, plans: entries });
  const written = await writeOutputFile(ctx, undoIndexPath, serializeWorkspacePlan(index));
  const ops = entries.reduce((n, e) => n + e.ops, 0);
  const base = entries.some((e) => e.baseOps > 0);
  text.push(
    '',
    `Workspace undo plan written to ${written}`,
    ...(ops > 0
      ? [`Workspace undo plan hash: ${index.hash}`, `Review it (pricingkit diff --workspace-plan ${undoIndexPath}), then apply it with: pricingkit apply --workspace-plan ${undoIndexPath} --confirm <hash>${base ? ' --allow-base-prices' : ''}${deletes ? ' --force-delete' : ''}`]
      : ['Nothing to undo.'])
  );
  return { exitCode: ops > 0 ? EXIT_CHANGES : EXIT_OK, json: { workspacePlan: index, notReversible }, text: text.join('\n') };
}

// ---------------------------------------------------------------------------
// drift --workspace

export async function driftWorkspaceCommand(ctx: CommandContext, workspacePath: string): Promise<CommandResult> {
  const loaded = await loadWorkspace(ctx, workspacePath);
  const pool = new AdapterPool(ctx);
  const apps: Array<{ appId: string; app: AppRef; report?: RulesDriftReport }> = [];
  const text: string[] = [];
  let exitCode: ExitCode = EXIT_OK;
  for (const app of loaded.apps) {
    if (!app.rules) {
      apps.push({ appId: app.entry.id, app: app.entry.app });
      continue;
    }
    const report = await (await pool.get(app.entry.app)).checkRulesDrift(app.rules);
    apps.push({ appId: app.entry.id, app: app.entry.app, report });
    text.push('', header(app.entry.id, app.entry.app, 'offer rules'), formatRulesDriftReport(report));
    const code = rulesDriftExitCode(report);
    if (code === EXIT_CHANGES || (code === EXIT_ERROR && exitCode === EXIT_OK)) exitCode = code;
  }
  const checked = apps.filter((a) => a.report);
  if (checked.length === 0) throw new UsageError('No app in the workspace has a rules file to check');
  const inSync = checked.every((a) => a.report!.inSync);
  const status = inSync ? 'In sync' : exitCode === EXIT_CHANGES ? 'DRIFT' : 'NOT CHECKED';
  text.unshift(`Workspace ${workspacePath}: ${status}: ${checked.length} apps with offer rules${apps.length > checked.length ? ` (${apps.length - checked.length} without)` : ''}`);
  return {
    exitCode,
    json: { kind: 'pricingkit.workspaceDrift', schemaVersion: 1, checkedAt: ctx.now().toISOString(), inSync, apps },
    text: text.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// parity --workspace (read-only)

export async function parityWorkspace(ctx: CommandContext, workspacePath: string, only?: string): Promise<ParityReport> {
  const loaded = await loadWorkspace(ctx, workspacePath);
  const mappings = (loaded.workspace.parity ?? []).filter((m) => only === undefined || m.id === only);
  if (mappings.length === 0) throw new UsageError(only ? `The workspace has no parity mapping "${only}"` : 'The workspace has no parity mappings');
  const pool = new AdapterPool(ctx);
  const reports: ParityMappingReport[] = [];
  for (const mapping of mappings) {
    // Each product is read through its own app's adapter, after checking it belongs to that app
    const apple = await pool.get({ bundleId: mapping.apple.bundleId });
    const play = await pool.get({ packageName: mapping.play.packageName });
    const appleProduct = parityAppleProduct(mapping);
    const playProduct = parityPlayProduct(mapping);
    await apple.verifyProduct(appleProduct);
    await play.verifyProduct(playProduct);
    const appleState = await readOnly(apple).fetchState(appleProduct);
    const playState = await readOnly(play).fetchState(playProduct);
    reports.push(parityMappingReport(mapping, appleState, playState));
  }
  return buildParityReport(reports, 'current', ctx.now().toISOString());
}
