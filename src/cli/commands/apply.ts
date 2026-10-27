// pricingkit apply: the CLI's only write. Applies an offer plan file, only
// with --confirm set to the plan's hash (what `pricingkit diff` and `plan`
// print), and saves the run log after every step so a failed or interrupted
// run can be resumed with --resume and undone later.

import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  applyChangeSet,
  changeSetHash,
  describeRun,
  isOfferOp,
  parseChangeSet,
  parseRun,
  serializeRun,
  summarizeRun,
  type ApplyRun,
  type ChangeSet,
} from '@/lib/pricing';
import { stringFlag } from '../args';
import { appleAdapter, readInputFile, writeOutputFile, type CommandContext, type CommandResult } from '../context';
import { CliError, EXIT_ERROR, EXIT_OK, UsageError } from '../errors';

/** Default run log file for a plan file: plan.json -> plan.run.json */
export function defaultRunFile(planPath: string): string {
  const name = basename(planPath).replace(/\.json$/i, '');
  return `${name}.run.json`;
}

export async function applyCommand(ctx: CommandContext): Promise<CommandResult> {
  const fromFlag = stringFlag(ctx.flags, 'plan');
  if (fromFlag && ctx.positionals.length > 0) throw new UsageError('Give the plan file once: as an argument or with --plan');
  if (ctx.positionals.length > 1) throw new UsageError('apply takes one plan file');
  const planPath = fromFlag ?? ctx.positionals[0];
  if (!planPath) throw new UsageError('Give a plan file: pricingkit apply <plan.json> --confirm <hash>');
  const confirm = stringFlag(ctx.flags, 'confirm', true);
  const resumePath = stringFlag(ctx.flags, 'resume');
  const runOut = stringFlag(ctx.flags, 'run-out') ?? resumePath ?? defaultRunFile(planPath);
  if (!resumePath && existsSync(resolve(ctx.cwd, runOut))) {
    throw new UsageError(`${runOut} already exists. Resume that run with --resume ${runOut}, or choose a new log file with --run-out`);
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
    throw new CliError(`--confirm doesn't match this plan (its hash is ${hash}). Review it with "pricingkit diff ${planPath}" and confirm that hash.`, 'CONFIRM_MISMATCH');
  }
  if (!('bundleId' in changeSet.app)) throw new UsageError('apply supports App Store offer plans only in this version');
  const notOffer = changeSet.ops.find((op) => !isOfferOp(op));
  if (notOffer) throw new UsageError(`apply supports offer plans only in this version (op ${notOffer.id} is a ${notOffer.kind})`);

  let previous: ApplyRun | undefined;
  if (resumePath) {
    try {
      previous = parseRun(await readInputFile(ctx, resumePath, 'run log'));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError((error as Error).message, 'INVALID_RUN');
    }
  }

  const adapter = await appleAdapter(ctx, changeSet.app.bundleId);
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
      saved = await writeOutputFile(ctx, runOut, serializeRun(snapshot));
    },
    now: () => ctx.now().toISOString(),
  });

  const counts = summarizeRun(run);
  const text = [
    ...describeRun(changeSet, run),
    '',
    `Run ${run.id}: ${run.status} (${Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ')})`,
    ...(run.stoppedReason ? [`Stopped: ${run.stoppedReason}${run.stoppedDetail ? ` (${run.stoppedDetail})` : ''}`] : []),
    `Run log written to ${saved || resolve(ctx.cwd, runOut)}`,
    ...(run.status === 'completed' ? [] : [`Resume with: pricingkit apply ${planPath} --confirm ${hash} --resume ${runOut}`]),
  ].join('\n');
  return { exitCode: run.status === 'completed' ? EXIT_OK : EXIT_ERROR, json: run, text };
}
