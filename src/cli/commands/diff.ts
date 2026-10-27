import {
  changedTerritories,
  changeSetHash,
  isOfferOp,
  parseChangeSet,
  productKey,
  type AppRef,
  type ChangeSet,
  type OfferOp,
  type OfferTerritoryPrice,
  type PlanSkip,
  type PriceValue,
  type ProductRef,
} from '@/lib/pricing';
import { stringFlag } from '../args';
import { readInputFile, type CommandContext, type CommandResult } from '../context';
import { CliError, EXIT_CHANGES, EXIT_OK, UsageError } from '../errors';
import { countBy, describeCounts, percentChange, priceCell, table } from '../format';

export const PLAN_SUMMARY_KIND = 'pricingkit.planSummary' as const;
export const PLAN_SUMMARY_SCHEMA_VERSION = 1 as const;

export interface PlanSummary {
  kind: typeof PLAN_SUMMARY_KIND;
  schemaVersion: typeof PLAN_SUMMARY_SCHEMA_VERSION;
  changeSetId: string;
  /** Hash of app + ops: equal hashes mean the same store changes */
  changeSetHash: string;
  createdAt: string;
  description?: string;
  app: AppRef;
  undoOf?: ChangeSet['undoOf'];
  opCount: number;
  byKind: Record<string, number>;
  products: Array<{
    product: ProductRef;
    key: string;
    ops: Array<{
      id: string;
      kind: string;
      territory: string;
      /** Offer ops: the offer the row belongs to (one row per territory whose offer price changes) */
      offer?: { kind: string; key: string };
      before: PriceValue | null;
      after: PriceValue | null;
      change?: string;
      note?: string;
    }>;
  }>;
  skipped: { count: number; byReason: Record<string, number>; territories: PlanSkip[] };
  warnings: NonNullable<ChangeSet['warnings']>;
  notReversible: NonNullable<ChangeSet['notReversible']>;
}

/** A plan's contents, grouped by product, for reviewers and machines. */
export function summarizeChangeSet(changeSet: ChangeSet): PlanSummary {
  const products = new Map<string, PlanSummary['products'][number]>();
  for (const op of changeSet.ops) {
    const key = productKey(op.target.product);
    if (!products.has(key)) products.set(key, { product: op.target.product, key, ops: [] });
    if (isOfferOp(op)) {
      products.get(key)!.ops.push(...offerRows(op));
      continue;
    }
    const change = percentChange(op.before, op.after);
    products.get(key)!.ops.push({
      id: op.id,
      kind: op.kind,
      territory: op.target.territory,
      before: op.before,
      after: op.after,
      ...(change ? { change } : {}),
      ...(op.note ? { note: op.note } : {}),
    });
  }
  const skipped = changeSet.skipped ?? [];
  return {
    kind: PLAN_SUMMARY_KIND,
    schemaVersion: PLAN_SUMMARY_SCHEMA_VERSION,
    changeSetId: changeSet.id,
    changeSetHash: changeSetHash(changeSet),
    createdAt: changeSet.createdAt,
    ...(changeSet.description ? { description: changeSet.description } : {}),
    app: changeSet.app,
    ...(changeSet.undoOf ? { undoOf: changeSet.undoOf } : {}),
    opCount: changeSet.ops.length,
    byKind: countBy(changeSet.ops, (op) => op.kind),
    products: [...products.values()],
    skipped: { count: skipped.length, byReason: countBy(skipped, (s) => s.reason), territories: skipped },
    warnings: changeSet.warnings ?? [],
    notReversible: changeSet.notReversible ?? [],
  };
}

const offerPrice = (p: OfferTerritoryPrice | undefined): PriceValue | null =>
  p ? { currency: p.currency, amount: p.amount, ...(p.pricePointId ? { pricePointId: p.pricePointId } : {}) } : null;

/** One row per territory whose offer price changes; one row for an op that changes no price (end date, active flag) */
function offerRows(op: OfferOp): PlanSummary['products'][number]['ops'] {
  const offer = { kind: op.target.offer.kind, key: op.target.offer.key };
  const before = op.before?.prices ?? {};
  const after = op.after?.prices ?? {};
  const territories = op.kind === 'deleteOffer' ? Object.keys(before).sort() : changedTerritories(before, after);
  if (territories.length === 0) {
    const what =
      op.after?.active !== undefined && op.after.active !== op.before?.active
        ? `active: ${op.after.active}`
        : `end date: ${op.before?.schedule?.end ?? 'none'} -> ${op.after?.schedule?.end ?? 'none'}`;
    return [{ id: op.id, kind: op.kind, territory: '-', offer, before: null, after: null, note: what }];
  }
  return territories.map((t) => {
    const b = offerPrice(before[t]);
    const a = offerPrice(after[t]);
    const change = percentChange(b, a);
    return { id: op.id, kind: op.kind, territory: t, offer, before: b, after: a, ...(change ? { change } : {}), ...(op.note ? { note: op.note } : {}) };
  });
}

export function formatPlanSummary(summary: PlanSummary): string {
  const app = 'bundleId' in summary.app ? `App Store ${summary.app.bundleId}` : `Google Play ${summary.app.packageName}`;
  const lines = [
    `Plan ${summary.changeSetId} for ${app}`,
    `Created ${summary.createdAt}${summary.description ? `: ${summary.description}` : ''}`,
    ...(summary.undoOf ? [`Undoes run ${summary.undoOf.runId} of ${summary.undoOf.changeSetId}`] : []),
    summary.opCount === 0 ? 'No changes: every territory is already at its target.' : `${summary.opCount} changes (${describeCounts(summary.byKind)})`,
  ];
  for (const product of summary.products) {
    lines.push('', product.key);
    lines.push(
      table([
        ['Op', 'Territory', 'Kind', 'Before', 'After', 'Change'],
        ...product.ops.map((op) => [
          op.id,
          op.territory,
          op.offer ? `${op.kind} ${op.offer.kind} ${op.offer.key}` : op.kind,
          priceCell(op.before),
          priceCell(op.after),
          op.change ?? (op.territory === '-' ? op.note ?? '' : ''),
        ]),
      ])
    );
  }
  if (summary.skipped.count > 0) {
    lines.push('', `Skipped ${summary.skipped.count} territories (${describeCounts(summary.skipped.byReason)})`);
    const notable = summary.skipped.territories.filter((s) => s.reason !== 'ALREADY_AT_TARGET');
    if (notable.length > 0) {
      lines.push(table(notable.map((s) => [productKey(s.product), s.territory, s.reason, s.detail ?? ''])));
    }
  }
  if (summary.warnings.length > 0) lines.push('', 'Warnings:', ...summary.warnings.map((w) => `  ${w.opId}: ${w.message}`));
  if (summary.notReversible.length > 0) lines.push('', 'Not reversible:', ...summary.notReversible.map((w) => `  ${w.opId}: ${w.reason}`));
  return lines.join('\n');
}

export async function diffCommand(ctx: CommandContext): Promise<CommandResult> {
  const fromFlag = stringFlag(ctx.flags, 'plan');
  if (fromFlag && ctx.positionals.length > 0) throw new UsageError('Give the plan file once: as an argument or with --plan');
  if (ctx.positionals.length > 1) throw new UsageError('diff takes one plan file');
  const path = fromFlag ?? ctx.positionals[0];
  if (!path) throw new UsageError('Give a plan file: pricingkit diff <plan.json>');

  const text = await readInputFile(ctx, path, 'plan file');
  let changeSet: ChangeSet;
  try {
    changeSet = parseChangeSet(text);
  } catch (error) {
    throw new CliError((error as Error).message, 'INVALID_PLAN');
  }
  const summary = summarizeChangeSet(changeSet);
  return { exitCode: summary.opCount > 0 ? EXIT_CHANGES : EXIT_OK, json: summary, text: formatPlanSummary(summary) };
}
