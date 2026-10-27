// pricingkit undo: turn a plan and its run log into an undo plan. Offline:
// no credentials, no store requests. The undo plan is an ordinary plan file,
// applied (after review) with `pricingkit apply <undo.json> --confirm <hash>`.

import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { buildUndoChangeSet, isOfferOp, parseChangeSet, parseRun, serializeChangeSet, type ApplyRun, type ChangeSet } from '@/lib/pricing';
import { stringFlag } from '../args';
import { readInputFile, writeOutputFileAtomic, type CommandContext, type CommandResult } from '../context';
import { CliError, EXIT_CHANGES, EXIT_OK, UsageError } from '../errors';
import { formatPlanSummary, summarizeChangeSet } from './diff';

/** Default undo plan file: plan.json -> plan.undo.json */
export function defaultUndoFile(planPath: string): string {
  return `${basename(planPath).replace(/\.json$/i, '')}.undo.json`;
}

export async function undoCommand(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.positionals.length !== 2) throw new UsageError('Give the plan and its run log: pricingkit undo <plan.json> <run.json> [--out <undo.json>]');
  const [planPath, runPath] = ctx.positionals;
  const out = stringFlag(ctx.flags, 'out') ?? defaultUndoFile(planPath);
  if (ctx.flags.force !== true && existsSync(resolve(ctx.cwd, out))) {
    throw new UsageError(`${out} already exists. Choose another file with --out, or pass --force to replace it`);
  }

  let changeSet: ChangeSet;
  let run: ApplyRun;
  try {
    changeSet = parseChangeSet(await readInputFile(ctx, planPath, 'plan file'));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError((error as Error).message, 'INVALID_PLAN');
  }
  try {
    run = parseRun(await readInputFile(ctx, runPath, 'run log'));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError((error as Error).message, 'INVALID_RUN');
  }

  let undo: ChangeSet;
  try {
    undo = buildUndoChangeSet(changeSet, run, { createdAt: ctx.now().toISOString() });
  } catch (error) {
    // e.g. a run log of a different plan
    throw new CliError((error as Error).message, 'INVALID_RUN');
  }
  const written = await writeOutputFileAtomic(ctx, out, serializeChangeSet(undo));
  const deletes = undo.ops.some((op) => isOfferOp(op) && op.kind === 'deleteOffer');
  const summary = summarizeChangeSet(undo);

  const text = [
    formatPlanSummary(summary),
    '',
    `Undo plan written to ${written}`,
    ...(undo.ops.length > 0
      ? [
          'Review it, then apply it with:',
          `  pricingkit apply ${out} --confirm <the plan hash above>${deletes ? ' --force-delete' : ''}`,
          ...(deletes ? ["--force-delete is needed because App Store Connect's API doesn't report whether anyone redeemed an offer."] : []),
        ]
      : ['Nothing to undo: the run changed nothing that can be reversed.']),
  ].join('\n');
  return { exitCode: undo.ops.length > 0 ? EXIT_CHANGES : EXIT_OK, json: { changeSet: undo, hash: summary.changeSetHash, notReversible: undo.notReversible ?? [] }, text };
}
