// pricingkit offer deactivate|activate|delete: plan one lifecycle change of
// an existing offer (App Store or Google Play). Reads only and writes a plan
// file; applying it is the usual `pricingkit apply <plan> --confirm <hash>`
// (with --force-delete for a delete).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  changeSetHash,
  OfferLifecycleError,
  PlayOfferLifecycleError,
  serializeChangeSet,
  type AppRef,
  type OfferPlan,
  type ProductRef,
} from '@/lib/pricing';
import { appSelection, stringFlag } from '../args';
import { appleAdapter, playAdapter, writeOutputFile, type CommandContext, type CommandResult } from '../context';
import { CliError, EXIT_CHANGES, EXIT_OK, UsageError } from '../errors';
import { parseOfferKind } from './offers';
import { productFromFlags } from './export';
import { formatOfferPlan, DEFAULT_PLAN_FILE } from './plan';

export const OFFER_ACTIONS = ['deactivate', 'activate', 'delete'] as const;
export type OfferAction = (typeof OFFER_ACTIONS)[number];

/** The read side of lifecycle planning only: no way to reach applyOffer */
export interface OfferLifecyclePlanner {
  planOfferLifecycle(input: { app: AppRef; product: ProductRef; key: string; action: OfferAction; endDate?: string; createdAt?: string }): Promise<OfferPlan>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function offerCommand(ctx: CommandContext): Promise<CommandResult> {
  const [action, ...extra] = ctx.positionals;
  if (!action || !(OFFER_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Give an action: pricingkit offer ${OFFER_ACTIONS.join('|')} ...`);
  }
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}"`);
  const app = appSelection(ctx.flags)!;
  const key = stringFlag(ctx.flags, 'offer', true);
  const endDate = stringFlag(ctx.flags, 'end-date');
  if (endDate !== undefined && !DATE.test(endDate)) throw new UsageError('--end-date must be a date, YYYY-MM-DD');

  const explicitOut = stringFlag(ctx.flags, 'out');
  const out = explicitOut ?? DEFAULT_PLAN_FILE;
  if (!explicitOut && ctx.flags.force !== true && existsSync(resolve(ctx.cwd, out))) {
    throw new UsageError(`${out} already exists. Pass --force to replace it, or choose a file with --out`);
  }

  let planner: OfferLifecyclePlanner;
  let product: ProductRef;
  let input: Parameters<OfferLifecyclePlanner['planOfferLifecycle']>[0];
  if (app.platform === 'apple') {
    product = productFromFlags(app, ctx.flags);
    const kind = parseOfferKind(stringFlag(ctx.flags, 'kind', true));
    if (action === 'deactivate' && endDate === undefined && (kind === 'apple.intro' || kind === 'apple.winBack')) {
      throw new UsageError('Deactivating an introductory or win-back offer sets its end date: pass --end-date YYYY-MM-DD');
    }
    if (endDate !== undefined && !(action === 'deactivate' && (kind === 'apple.intro' || kind === 'apple.winBack'))) {
      throw new UsageError('--end-date goes with deactivate, for introductory and win-back offers');
    }
    const adapter = await appleAdapter(ctx, app.bundleId);
    planner = { planOfferLifecycle: (i) => adapter.planOfferLifecycle({ ...i, kind }) };
    input = { app: { bundleId: app.bundleId }, product, key, action: action as OfferAction, ...(endDate ? { endDate } : {}), createdAt: ctx.now().toISOString() };
  } else {
    if (ctx.flags.kind !== undefined && ctx.flags.kind !== 'play.offer') throw new UsageError('On Google Play, --kind can only be play.offer');
    if (endDate !== undefined) throw new UsageError('--end-date is for App Store introductory and win-back offers');
    product = productFromFlags(app, ctx.flags);
    const adapter = await playAdapter(ctx, app.packageName);
    planner = { planOfferLifecycle: (i) => adapter.planOfferLifecycle(i) };
    input = { app: { packageName: app.packageName }, product, key, action: action as OfferAction, createdAt: ctx.now().toISOString() };
  }

  let plan: OfferPlan;
  try {
    plan = await planner.planOfferLifecycle(input);
  } catch (error) {
    if (error instanceof OfferLifecycleError || error instanceof PlayOfferLifecycleError) throw new CliError(error.message, 'OFFER_LIFECYCLE_REFUSED');
    throw error;
  }
  if (plan.hash !== changeSetHash(plan.changeSet)) throw new CliError('Internal error: plan hash mismatch');
  const written = await writeOutputFile(ctx, out, serializeChangeSet(plan.changeSet));
  const deletes = action === 'delete';
  const text = [
    formatOfferPlan(plan),
    '',
    `Plan written to ${written}`,
    'Dry run: nothing was changed in the store.',
    ...(plan.changeSet.ops.length > 0
      ? ['Review it, then apply it with:', `  pricingkit apply ${out} --confirm ${plan.hash}${deletes ? ' --force-delete' : ''}`]
      : []),
  ].join('\n');
  return {
    exitCode: plan.changeSet.ops.length > 0 ? EXIT_CHANGES : EXIT_OK,
    json: { changeSet: plan.changeSet, hash: plan.hash, entries: plan.entries },
    text,
  };
}
