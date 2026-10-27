// pricingkit apply: the CLI's only write. Applies a plan file (App Store or
// Google Play, the app named in the plan), only with --confirm set to the
// plan's hash (what `pricingkit diff` and `plan` print), and saves the run
// log before and after every write so a failed or interrupted run can be
// resumed with --resume and undone later. Offer ops are applied by default;
// a plan that changes base prices also needs --allow-base-prices.

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  applyChangeSet,
  assertRunMatches,
  changeSetHash,
  describeRun,
  isOfferOp,
  parseChangeSet,
  parseRun,
  serializeRun,
  summarizeRun,
  type ApplyRun,
  type AppRef,
  type ChangeSet,
} from '@/lib/pricing';
import { stringFlag } from '../args';
import { adapterForApp, appleAdapter, assertExpectedApp, playAdapter, readInputFile, writeOutputFileAtomic, type CommandContext, type CommandResult } from '../context';
import { CliError, EXIT_ERROR, EXIT_OK, UsageError } from '../errors';
import { header, readWorkspacePlan } from './workspace';

/**
 * Default run log file for a plan file, next to the plan: plans/x.json ->
 * plans/x.run.json (relative paths stay relative to the working directory,
 * like the plan path itself)
 */
export function defaultRunFile(planPath: string): string {
  const name = basename(planPath).replace(/\.json$/i, '');
  return join(dirname(planPath), `${name}.run.json`);
}

/**
 * What `apply --allow-base-prices` users must know. App Store base-price
 * writes rest on two behaviours not yet confirmed on a test app (CLAUDE.md,
 * Testing); the executor re-reads every territory before writing and refuses
 * ambiguous state, but don't rely on them in production before that check.
 */
export const BASE_PRICE_NOTE =
  "App Store base prices rely on two behaviours not yet confirmed on a test app: that an immediate price replaces the territory's older entries, and that a second scheduled price can be created before the old one is deleted. Try a base-price plan on a test app first.";

export async function applyCommand(ctx: CommandContext): Promise<CommandResult> {
  const workspacePlan = stringFlag(ctx.flags, 'workspace-plan');
  if (workspacePlan) return applyWorkspaceCommand(ctx, workspacePlan);
  if (ctx.flags['resume-runs'] !== undefined) throw new UsageError('--resume-runs goes with --workspace-plan; resume one plan with --resume <run.json>');
  const fromFlag = stringFlag(ctx.flags, 'plan');
  if (fromFlag && ctx.positionals.length > 0) throw new UsageError('Give the plan file once: as an argument or with --plan');
  if (ctx.positionals.length > 1) throw new UsageError('apply takes one plan file');
  const planPath = fromFlag ?? ctx.positionals[0];
  if (!planPath) throw new UsageError('Give a plan file: pricingkit apply <plan.json> --confirm <hash>');
  const confirm = stringFlag(ctx.flags, 'confirm', true);
  const resumePath = stringFlag(ctx.flags, 'resume');
  const runOut = stringFlag(ctx.flags, 'run-out') ?? resumePath ?? defaultRunFile(planPath);
  // A run log is never replaced by accident: only the log being resumed, or with --force
  const resumingInPlace = resumePath !== undefined && resolve(ctx.cwd, resumePath) === resolve(ctx.cwd, runOut);
  if (!resumingInPlace && ctx.flags.force !== true && existsSync(resolve(ctx.cwd, runOut))) {
    throw new UsageError(`${runOut} already exists. Resume that run with --resume ${runOut}, choose a new log file with --run-out, or pass --force to replace it`);
  }

  let changeSet: ChangeSet;
  try {
    changeSet = parseChangeSet(await readInputFile(ctx, planPath, 'plan file'));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError((error as Error).message, 'INVALID_PLAN');
  }
  const hash = changeSetHash(changeSet);
  if (confirm !== hash) {
    // Never print the right hash here: it must come from reviewing the plan
    throw new CliError(`--confirm doesn't match this plan. Review it with "pricingkit diff ${planPath}" and confirm the hash shown there.`, 'CONFIRM_MISMATCH');
  }
  const baseOps = changeSet.ops.filter((op) => !isOfferOp(op));
  if (baseOps.length > 0 && ctx.flags['allow-base-prices'] !== true) {
    // Base prices are an explicit opt-in: see BASE_PRICE_NOTE
    throw new UsageError(
      `This plan changes base prices (${baseOps.length} ${baseOps.length === 1 ? 'op' : 'ops'}, e.g. ${baseOps[0].id} ${baseOps[0].kind}). Pass --allow-base-prices to apply it. ${BASE_PRICE_NOTE}`
    );
  }

  let previous: ApplyRun | undefined;
  if (resumePath) {
    try {
      previous = parseRun(await readInputFile(ctx, resumePath, 'run log'));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError((error as Error).message, 'INVALID_RUN');
    }
  }

  // The adapter is for the plan's own app; the executor checks the plan against it again (APP_MISMATCH)
  const adapter = 'bundleId' in changeSet.app ? await appleAdapter(ctx, changeSet.app.bundleId) : await playAdapter(ctx, changeSet.app.packageName);
  let saved = '';
  const run = await applyChangeSet(changeSet, {
    adapter,
    budget: ctx.budget,
    confirm,
    verify: true,
    concurrency: 1,
    ...(previous ? { run: previous } : {}),
    ...(ctx.flags['force-delete'] === true ? { force: { deleteOffers: true } } : {}),
    // Saved before and after every write: a crash leaves a log that can be resumed
    onUpdate: async (snapshot) => {
      saved = await writeOutputFileAtomic(ctx, runOut, serializeRun(snapshot));
    },
    now: () => ctx.now().toISOString(),
  });

  const counts = summarizeRun(run);
  const resume = `pricingkit apply ${planPath} --confirm ${hash} --resume ${runOut}${baseOps.length > 0 ? ' --allow-base-prices' : ''}${ctx.flags['force-delete'] === true ? ' --force-delete' : ''}`;
  const text = [
    ...describeRun(changeSet, run),
    '',
    `Run ${run.id}: ${run.status} (${Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ')})`,
    ...(run.stoppedReason ? [`Stopped: ${run.stoppedReason}${run.stoppedDetail ? ` (${run.stoppedDetail})` : ''}`] : []),
    `Run log written to ${saved || resolve(ctx.cwd, runOut)}`,
    ...(run.status === 'completed' ? [] : [`Resume with: ${resume}`]),
    ...(baseOps.length > 0 && 'bundleId' in changeSet.app ? ['', `Note: ${BASE_PRICE_NOTE}`] : []),
  ].join('\n');
  return { exitCode: run.status === 'completed' ? EXIT_OK : EXIT_ERROR, json: run, text };
}

// ---------------------------------------------------------------------------
// apply --workspace-plan

/**
 * apply --workspace-plan: every plan of a workspace plan, in order, each for
 * its own app (this file stays the only one that calls the executor).
 */
async function applyWorkspaceCommand(ctx: CommandContext, indexPath: string): Promise<CommandResult> {
  for (const flag of ['plan', 'resume', 'run-out']) {
    if (ctx.flags[flag] !== undefined) throw new UsageError(`--workspace-plan applies every plan it lists, each with its run log next to it; drop --${flag} (use --resume-runs to resume)`);
  }
  if (ctx.positionals.length > 0) throw new UsageError('Give either a plan file or --workspace-plan, not both');
  const confirm = stringFlag(ctx.flags, 'confirm', true);
  const { index, plans } = await readWorkspacePlan(ctx, indexPath);
  if (confirm !== index.hash) {
    // Never print the right hash here: it must come from reviewing the plans
    throw new CliError(`--confirm doesn't match this workspace plan. Review it with "pricingkit diff --workspace-plan ${indexPath}" and confirm the hash shown there.`, 'CONFIRM_MISMATCH');
  }
  // Every app the plans touch must be allowed by the pins before any credential is loaded
  for (const plan of plans) assertExpectedApp(ctx, plan.changeSet.app);
  const withOps = plans.filter((p) => p.changeSet.ops.length > 0);
  const baseOps = withOps.flatMap((p) => p.changeSet.ops.filter((op) => !isOfferOp(op)));
  if (baseOps.length > 0 && ctx.flags['allow-base-prices'] !== true) {
    throw new UsageError(`These plans change base prices (${baseOps.length} ops). Pass --allow-base-prices to apply them. ${BASE_PRICE_NOTE}`);
  }
  const resumeRuns = ctx.flags['resume-runs'] === true;
  const previous = new Map<string, ApplyRun>();
  const blocked: string[] = [];
  for (const plan of withOps) {
    const runPath = defaultRunFile(plan.path);
    if (!existsSync(resolve(ctx.cwd, runPath))) continue;
    if (resumeRuns) {
      let earlier: ApplyRun;
      try {
        earlier = parseRun(await readInputFile(ctx, runPath, 'run log'));
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(`${runPath}: ${(error as Error).message}`, 'INVALID_RUN');
      }
      // A log left by an earlier plan of the same file must never count as this plan's run
      try {
        assertRunMatches(plan.changeSet, earlier);
      } catch {
        throw new CliError(
          `${runPath} is the run log of a different plan than ${plan.entry.file} (the plan was made again since). Nothing was read or sent. Move the old log aside (it is what undoes that earlier run), then apply without --resume-runs.`,
          'INVALID_RUN'
        );
      }
      previous.set(plan.entry.file, earlier);
    } else if (ctx.flags.force !== true) {
      blocked.push(runPath);
    }
  }
  if (blocked.length > 0) {
    throw new UsageError(`Run logs already exist (${blocked.join(', ')}). Resume them with --resume-runs, or pass --force to start over and replace them`);
  }

  const text: string[] = [`Workspace plan ${indexPath}: ${withOps.length} of ${plans.length} plans have changes`];
  const runs: Array<{ file: string; appId: string; app: AppRef; status: string; run?: ApplyRun }> = [];
  let stopped = false;
  for (const plan of plans) {
    const label = header(plan.entry.appId, plan.entry.app, `${plan.entry.part} (${plan.entry.file})`);
    if (plan.changeSet.ops.length === 0) {
      runs.push({ file: plan.entry.file, appId: plan.entry.appId, app: plan.entry.app, status: 'nothingToApply' });
      continue;
    }
    if (stopped) {
      runs.push({ file: plan.entry.file, appId: plan.entry.appId, app: plan.entry.app, status: 'notStarted' });
      text.push('', label, 'Not started: an earlier plan did not complete.');
      continue;
    }
    const earlier = previous.get(plan.entry.file);
    if (earlier?.status === 'completed') {
      runs.push({ file: plan.entry.file, appId: plan.entry.appId, app: plan.entry.app, status: 'completed', run: earlier });
      text.push('', label, `Already completed (run ${earlier.id}).`);
      continue;
    }
    const runPath = defaultRunFile(plan.path);
    // The adapter is built for this plan's own app; the executor checks the plan against it again (APP_MISMATCH)
    const adapter = await adapterForApp(ctx, plan.changeSet.app);
    let saved = '';
    const run = await applyChangeSet(plan.changeSet, {
      adapter,
      budget: ctx.budget,
      confirm: plan.entry.hash,
      verify: true,
      concurrency: 1,
      ...(earlier ? { run: earlier } : {}),
      ...(ctx.flags['force-delete'] === true ? { force: { deleteOffers: true } } : {}),
      onUpdate: async (snapshot) => {
        saved = await writeOutputFileAtomic(ctx, runPath, serializeRun(snapshot));
      },
      now: () => ctx.now().toISOString(),
    });
    runs.push({ file: plan.entry.file, appId: plan.entry.appId, app: plan.entry.app, status: run.status, run });
    const counts = summarizeRun(run);
    text.push(
      '',
      label,
      ...describeRun(plan.changeSet, run),
      `Run ${run.id}: ${run.status} (${Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([s, n]) => `${s} ${n}`)
        .join(', ')})`,
      ...(run.stoppedReason ? [`Stopped: ${run.stoppedReason}${run.stoppedDetail ? ` (${run.stoppedDetail})` : ''}`] : []),
      `Run log written to ${saved || resolve(ctx.cwd, runPath)}`
    );
    if (run.status !== 'completed') stopped = true;
  }
  const complete = runs.every((r) => r.status === 'completed' || r.status === 'nothingToApply');
  if (!complete) {
    text.push(
      '',
      `Resume with: pricingkit apply --workspace-plan ${indexPath} --confirm ${index.hash} --resume-runs${baseOps.length > 0 ? ' --allow-base-prices' : ''}${ctx.flags['force-delete'] === true ? ' --force-delete' : ''}`
    );
  }
  if (baseOps.length > 0 && plans.some((p) => 'bundleId' in p.changeSet.app && p.changeSet.ops.some((op) => !isOfferOp(op)))) text.push('', `Note: ${BASE_PRICE_NOTE}`);
  return { exitCode: complete ? EXIT_OK : EXIT_ERROR, json: { kind: 'pricingkit.workspaceRun', workspacePlanHash: index.hash, complete, plans: runs }, text: text.join('\n') };
}
