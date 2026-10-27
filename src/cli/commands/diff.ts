import {
  changedPlayRegions,
  changedTerritories,
  changeSetHash,
  legacyHashWarning,
  describePlayPhase,
  describePlayRegionPrice,
  describePlayTargeting,
  isOfferOp,
  isPlayOfferOp,
  type PlayOfferOp,
  type PlayPhaseRegionPrice,
  parseChangeSet,
  productKey,
  type AppRef,
  type ChangeSet,
  type ManualAction,
  type OfferOp,
  type OfferTerritoryPrice,
  type PlanSkip,
  type PriceValue,
  type ProductRef,
  type PriceChangeNote,
  type FreshnessEntry,
  type BasePriceOp,
  classifyPriceChange,
  noteConsentContext,
} from '@/lib/pricing';
import { stringFlag } from '../args';
import { readInputFile, type CommandContext, type CommandResult } from '../context';
import { CliError, EXIT_CHANGES, EXIT_OK, UsageError } from '../errors';
import { countBy, describeCounts, percentChange, priceCell, table } from '../format';
import { diffManyCommand, diffWorkspaceCommand } from './workspace';

export const PLAN_SUMMARY_KIND = 'pricingkit.planSummary' as const;
export const PLAN_SUMMARY_SCHEMA_VERSION = 1 as const;

export interface PlanSummary {
  kind: typeof PLAN_SUMMARY_KIND;
  schemaVersion: typeof PLAN_SUMMARY_SCHEMA_VERSION;
  changeSetId: string;
  /** Hash of app + ops: equal hashes mean the same store changes */
  changeSetHash: string;
  /** Set when the plan's hash is the old FNV-1a (schema version 1 or 2) */
  hashWarning?: string;
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
      /** Offer ops: the base-price ops it waits for (sync plans) */
      dependsOn?: string[];
      /**
       * Base-price ops: what existing subscribers see (price-increase.ts classes).
       * Recomputed by diff from the op (before, after, options) and the note's
       * inputs; for a scheduled change (current price not in the op) it is the
       * stored note, and existingSubscribersVerified is false.
       */
      existingSubscribers?: string;
      existingSubscribersVerified?: boolean;
      /** Google Play: what migrating the legacy cohort to this price would need */
      ifMigrated?: string;
      /** Developer proceeds after the change (Google Play: estimated) */
      proceeds?: string;
      proceedsBefore?: string;
      proceedsEstimated?: boolean;
      /** Google Play: tax included in the new price */
      tax?: string;
    }>;
  }>;
  /** Per base-price op: existing-subscriber class, reasons, assumptions, proceeds, tax (from the plan's priceChanges) */
  priceChanges: PriceChangeNote[];
  /** Base-price ops by existing-subscriber class (as diff recomputed it) */
  byExistingSubscribers: Record<string, number>;
  /** Ops whose stored note disagrees with the class recomputed from the op (the note was edited or is stale) */
  noteMismatches: Array<{ opId: string; territory: string; stored: string; recomputed: string }>;
  /** The reference data the plan's targets came from, with ages */
  dataFreshness: FreshnessEntry[];
  /** Ops per group: base prices are applied before offers */
  byGroup: { basePrices: number; offers: number };
  skipped: { count: number; byReason: Record<string, number>; territories: PlanSkip[] };
  warnings: NonNullable<ChangeSet['warnings']>;
  notReversible: NonNullable<ChangeSet['notReversible']>;
  /** Offers that need a person (sync plans): the store can't re-price them, or they were held */
  manualActions: ManualAction[];
  /** Google Play offer ops: what each offer is after the op (eligibility, phases, tags, state) */
  playOffers: Array<{
    opId: string;
    kind: string;
    product: string;
    offerId: string;
    stateBefore: string | null;
    stateAfter: string | null;
    /** null for a create */
    eligibilityBefore: string | null;
    eligibility: string;
    phases: string[];
    /** null for a create */
    tagsBefore: string[] | null;
    tags: string[];
    tagsAdded: string[];
    tagsRemoved: string[];
  }>;
}

/** A plan's contents, grouped by product, for reviewers and machines. */
export function summarizeChangeSet(changeSet: ChangeSet): PlanSummary {
  const products = new Map<string, PlanSummary['products'][number]>();
  const notes = new Map((changeSet.priceChanges ?? []).map((n) => [n.opId, n]));
  const noteMismatches: PlanSummary['noteMismatches'] = [];
  const effective: string[] = [];
  for (const op of changeSet.ops) {
    const key = productKey(op.target.product);
    if (!products.has(key)) products.set(key, { product: op.target.product, key, ops: [] });
    if (isOfferOp(op)) {
      products.get(key)!.ops.push(...(isPlayOfferOp(op) ? playOfferRows(op) : offerRows(op)));
      continue;
    }
    const change = percentChange(op.before, op.after);
    const note = notes.get(op.id);
    const checked = note ? recheckNote(op, note, changeSet.createdAt) : undefined;
    if (checked?.mismatch) noteMismatches.push({ opId: op.id, territory: op.target.territory, ...checked.mismatch });
    if (checked) effective.push(checked.classification);
    products.get(key)!.ops.push({
      id: op.id,
      kind: op.kind,
      territory: op.target.territory,
      before: op.before,
      after: op.after,
      ...(change ? { change } : {}),
      ...(op.note ? { note: op.note } : {}),
      ...(checked ? { existingSubscribers: checked.classification, existingSubscribersVerified: checked.verified } : {}),
      ...(checked?.ifMigrated ? { ifMigrated: checked.ifMigrated } : {}),
      ...(note?.proceeds?.after !== undefined ? { proceeds: note.proceeds.after } : {}),
      ...(note?.proceeds?.before !== undefined ? { proceedsBefore: note.proceeds.before } : {}),
      ...(note?.proceeds?.estimated ? { proceedsEstimated: true } : {}),
      ...(note?.tax !== undefined ? { tax: note.tax } : {}),
    });
  }
  const skipped = changeSet.skipped ?? [];
  return {
    kind: PLAN_SUMMARY_KIND,
    schemaVersion: PLAN_SUMMARY_SCHEMA_VERSION,
    changeSetId: changeSet.id,
    changeSetHash: changeSetHash(changeSet),
    ...(legacyHashWarning(changeSet) ? { hashWarning: legacyHashWarning(changeSet)! } : {}),
    createdAt: changeSet.createdAt,
    ...(changeSet.description ? { description: changeSet.description } : {}),
    app: changeSet.app,
    ...(changeSet.undoOf ? { undoOf: changeSet.undoOf } : {}),
    opCount: changeSet.ops.length,
    byKind: countBy(changeSet.ops, (op) => op.kind),
    byGroup: { basePrices: changeSet.ops.filter((op) => !isOfferOp(op)).length, offers: changeSet.ops.filter(isOfferOp).length },
    products: [...products.values()],
    skipped: { count: skipped.length, byReason: countBy(skipped, (s) => s.reason), territories: skipped },
    warnings: changeSet.warnings ?? [],
    notReversible: changeSet.notReversible ?? [],
    manualActions: changeSet.manualActions ?? [],
    priceChanges: changeSet.priceChanges ?? [],
    byExistingSubscribers: countBy(effective, (c) => c),
    noteMismatches,
    dataFreshness: changeSet.dataFreshness ?? [],
    playOffers: changeSet.ops.filter(isOfferOp).filter(isPlayOfferOp).map((op) => {
      const state = (op.after ?? op.before)!;
      const tagsBefore = op.before?.tags ?? null;
      return {
        opId: op.id,
        kind: op.kind,
        product: productKey(op.target.product),
        offerId: op.target.offer.key,
        stateBefore: op.before?.state ?? null,
        stateAfter: op.after?.state ?? null,
        eligibilityBefore: op.before ? describePlayTargeting(op.before.targeting) : null,
        eligibility: describePlayTargeting(state.targeting),
        phases: state.phases.map(describePlayPhase),
        tagsBefore,
        tags: state.tags,
        tagsAdded: op.after ? op.after.tags.filter((t) => !(tagsBefore ?? []).includes(t)) : [],
        tagsRemoved: op.after && tagsBefore ? tagsBefore.filter((t) => !op.after!.tags.includes(t)) : [],
      };
    }),
  };
}

const playPrice = (p: PlayPhaseRegionPrice | undefined): PriceValue | null => (p && p.type === 'price' ? { currency: p.currency, amount: p.amount } : null);

/** One row per region and phase whose offer price changes; one row for an op that changes no price (state, eligibility, tags) */
function playOfferRows(op: PlayOfferOp): PlanSummary['products'][number]['ops'] {
  const offer = { kind: op.target.offer.kind, key: op.target.offer.key };
  const deps = op.dependsOn?.length ? { dependsOn: op.dependsOn } : {};
  const before = op.before;
  const after = op.after;
  const regions = op.kind === 'deleteOffer' ? Object.keys(before?.regions ?? {}).sort() : before && after ? changedPlayRegions(before, after) : Object.keys(after?.regions ?? {}).sort();
  if (regions.length === 0) {
    const notes: string[] = [];
    if (before?.state !== after?.state) notes.push(`state: ${before?.state ?? 'none'} -> ${after?.state ?? 'deleted'}`);
    if (before && after && JSON.stringify(before.targeting) !== JSON.stringify(after.targeting)) notes.push(`eligibility: ${describePlayTargeting(after.targeting)}`);
    if (before && after && before.tags.join() !== after.tags.join()) notes.push(`tags: ${after.tags.join(', ') || 'none'}`);
    return [{ id: op.id, kind: op.kind, territory: '-', offer, before: null, after: null, note: notes.join('; ') || op.note || '', ...deps }];
  }
  const phases = Math.max(before?.phases.length ?? 0, after?.phases.length ?? 0);
  const rows: PlanSummary['products'][number]['ops'] = [];
  for (const region of regions) {
    for (let i = 0; i < phases; i++) {
      const b = before?.phases[i]?.regions[region];
      const a = after?.phases[i]?.regions[region];
      if (before && after && JSON.stringify(b) === JSON.stringify(a)) continue;
      const change = percentChange(playPrice(b), playPrice(a));
      const note = `phase ${i + 1}: ${describePlayRegionPrice(b)} -> ${describePlayRegionPrice(a)}`;
      rows.push({ id: op.id, kind: op.kind, territory: region, offer, before: playPrice(b), after: playPrice(a), ...(change ? { change } : {}), note, ...deps });
    }
  }
  return rows;
}

const offerPrice = (p: OfferTerritoryPrice | undefined): PriceValue | null =>
  p ? { currency: p.currency, amount: p.amount, ...(p.pricePointId ? { pricePointId: p.pricePointId } : {}) } : null;

/** One row per territory whose offer price changes; one row for an op that changes no price (end date, active flag) */
function offerRows(op: OfferOp): PlanSummary['products'][number]['ops'] {
  const offer = { kind: op.target.offer.kind, key: op.target.offer.key };
  const deps = op.dependsOn?.length ? { dependsOn: op.dependsOn } : {};
  const before = op.before?.prices ?? {};
  const after = op.after?.prices ?? {};
  const territories = op.kind === 'deleteOffer' ? Object.keys(before).sort() : changedTerritories(before, after);
  if (territories.length === 0) {
    const what =
      op.after?.active !== undefined && op.after.active !== op.before?.active
        ? `active: ${op.after.active}`
        : `end date: ${op.before?.schedule?.end ?? 'none'} -> ${op.after?.schedule?.end ?? 'none'}`;
    return [{ id: op.id, kind: op.kind, territory: '-', offer, before: null, after: null, note: what, ...deps }];
  }
  return territories.map((t) => {
    const b = offerPrice(before[t]);
    const a = offerPrice(after[t]);
    const change = percentChange(b, a);
    return { id: op.id, kind: op.kind, territory: t, offer, before: b, after: a, ...(change ? { change } : {}), ...(op.note ? { note: op.note } : {}), ...deps };
  });
}

export function formatPlanSummary(summary: PlanSummary): string {
  const app = 'bundleId' in summary.app ? `App Store ${summary.app.bundleId}` : `Google Play ${summary.app.packageName}`;
  const lines = [
    `Plan ${summary.changeSetId} for ${app}`,
    `Created ${summary.createdAt}${summary.description ? `: ${summary.description}` : ''}`,
    ...(summary.undoOf ? [`Undoes run ${summary.undoOf.runId} of ${summary.undoOf.changeSetId}`] : []),
    summary.opCount === 0
      ? summary.manualActions.length > 0
        ? 'No changes the plan can make itself; see "Needs manual action".'
        : 'No changes: every territory is already at its target.'
      : `${summary.opCount} changes (${describeCounts(summary.byKind)})`,
    ...(summary.opCount > 0 ? [`Plan hash: ${summary.changeSetHash} (what "pricingkit apply --confirm" needs once you have reviewed this plan)`] : []),
    ...(summary.hashWarning ? [`WARNING: ${summary.hashWarning}`] : []),
  ];
  type Row = PlanSummary['products'][number]['ops'][number];
  const section = (pick: (op: Row) => boolean) => {
    for (const product of summary.products) {
      const rows = product.ops.filter(pick);
      if (rows.length === 0) continue;
      // Proceeds, tax and existing-subscriber columns only for plans that carry the notes
      const withProceeds = rows.some((r) => r.proceeds !== undefined || r.proceedsBefore !== undefined);
      const withTax = rows.some((r) => r.tax !== undefined);
      const withSubscribers = rows.some((r) => r.existingSubscribers !== undefined);
      lines.push('', product.key);
      lines.push(
        table([
          ['Op', 'Territory', 'Kind', 'Before', 'After', 'Change', ...(withProceeds ? ['Proceeds*'] : []), ...(withTax ? ['Tax*'] : []), ...(withSubscribers ? ['Existing subscribers*'] : [])],
          ...rows.map((op) => [
            op.id,
            op.territory,
            op.offer ? `${op.kind} ${op.offer.kind} ${op.offer.key}` : op.kind,
            priceCell(op.before),
            priceCell(op.after),
            op.change ?? (op.territory === '-' || op.offer?.kind === 'play.offer' ? op.note ?? '' : ''),
            ...(withProceeds ? [proceedsCell(op)] : []),
            ...(withTax ? [op.tax ?? ''] : []),
            ...(withSubscribers ? [subscribersCell(op)] : []),
          ]),
        ])
      );
      if (withProceeds || withTax || withSubscribers) {
        lines.push('  * planner notes, not covered by the plan hash. Existing subscribers is recomputed from each op; "(unverified)" marks a scheduled change, shown as noted.');
      }
      const waits = [...new Set(rows.filter((r) => r.dependsOn?.length).map((r) => `${r.id} after ${r.dependsOn!.join(', ')}`))];
      if (waits.length > 0) lines.push(`  Applied only once its base prices are: ${waits.join('; ')}`);
    }
  };
  if (summary.playOffers.length > 0) {
    lines.push('', 'Play offers:');
    const change = (before: string | null, after: string) => (before === null ? `${after} (new offer)` : before === after ? `${after} (unchanged)` : `${before} -> ${after}`);
    const tags = (list: string[]) => (list.length ? list.join(', ') : 'none');
    for (const o of summary.playOffers) {
      lines.push(`  ${o.opId} ${o.kind} ${o.offerId} on ${o.product}`);
      lines.push(`    State: ${change(o.stateBefore, o.stateAfter ?? 'deleted')}`);
      lines.push(`    Eligibility: ${change(o.eligibilityBefore, o.eligibility)}`);
      lines.push(`    Phases: ${o.phases.join('; ')}`);
      const notes = [...o.tagsRemoved.map((t) => `removes ${t}`), ...(o.tagsBefore ? o.tagsAdded.map((t) => `adds ${t}`) : [])];
      lines.push(`    Tags: ${change(o.tagsBefore ? tags(o.tagsBefore) : null, tags(o.tags))}${notes.length ? ` (${notes.join(', ')})` : ''}`);
    }
  }
  if (summary.byGroup.basePrices > 0 && summary.byGroup.offers > 0) {
    // A plan with both: base prices go first, and offers derived from them wait for them
    lines.push('', `Base prices (${summary.byGroup.basePrices} changes, applied first)`);
    section((op) => !op.offer);
    lines.push('', `Offers (${summary.byGroup.offers} ops, applied after the base prices)`);
    section((op) => Boolean(op.offer));
  } else {
    section(() => true);
  }
  if (summary.manualActions.length > 0) {
    lines.push('', `Needs manual action (${summary.manualActions.length} offers; this plan doesn't change them):`);
    for (const m of summary.manualActions) {
      lines.push(`  ${productKey(m.product)} ${m.offer.kind} ${m.offer.key} (${m.code}): ${m.message}`);
    }
  }
  if (summary.skipped.count > 0) {
    lines.push('', `Skipped ${summary.skipped.count} territories (${describeCounts(summary.skipped.byReason)})`);
    const notable = summary.skipped.territories.filter((s) => s.reason !== 'ALREADY_AT_TARGET');
    if (notable.length > 0) {
      lines.push(table(notable.map((s) => [productKey(s.product), s.territory, s.reason, s.detail ?? ''])));
    }
  }
  if (summary.priceChanges.length > 0 || summary.dataFreshness.length > 0) {
    lines.push('', 'Planner notes (not covered by the plan hash):');
  }
  for (const m of summary.noteMismatches) {
    lines.push(`  WARNING: ${m.opId} ${m.territory}: the plan's note says ${m.stored}, but the op gives ${m.recomputed}. The note was edited or is stale; the op is what applies.`);
  }
  if (summary.priceChanges.length > 0) {
    lines.push(`  Existing subscribers: ${describeCounts(summary.byExistingSubscribers)}`);
    const consent = summary.products.flatMap((p) => p.ops).filter((o) => o.existingSubscribers === 'increase-needs-consent');
    if (consent.length > 0) {
      lines.push(`  Needs consent (subscribers who don't agree are lost at renewal): ${consent.map((o) => o.territory).join(', ')}`);
    }
    const assumptions = [...new Set(summary.priceChanges.flatMap((n) => n.assumptions ?? []))];
    if (assumptions.length > 0) lines.push('  Assumed (not checked):', ...assumptions.map((a) => `    - ${a}`));
    if (summary.priceChanges.some((n) => n.proceeds?.estimated)) {
      const rates = [...new Set(summary.priceChanges.map((n) => n.proceeds?.commission).filter(Boolean))];
      lines.push(`  Google Play proceeds are estimates: (price - tax) x (1 - commission), commission ${rates.join(', ')}.`);
    }
  }
  if (summary.dataFreshness.length > 0) {
    lines.push('  Reference data:', ...summary.dataFreshness.map((f) => `    ${f.stale ? 'STALE ' : ''}${f.message}`));
  }
  if (summary.warnings.length > 0) lines.push('', 'Warnings:', ...summary.warnings.map((w) => `  ${w.opId}: ${w.message}`));
  if (summary.notReversible.length > 0) lines.push('', 'Not reversible:', ...summary.notReversible.map((w) => `  ${w.opId}: ${w.reason}`));
  return lines.join('\n');
}

const SUBSCRIBER_LABELS: Record<string, string> = {
  decrease: 'decrease',
  unchanged: 'unchanged',
  'new-price': 'new territory',
  'increase-to-new-subscribers-only': 'new subscribers only',
  'increase-within-no-consent-threshold': 'notified, no consent',
  'increase-needs-consent': 'NEEDS CONSENT',
  'one-time-product': '-',
};
const MIGRATION_LABELS: Record<string, string> = { 'no-consent': 'no consent', 'opt-out-possible': 'opt-out possible', 'opt-in-required': 'opt-in' };

function subscribersCell(op: PlanSummary['products'][number]['ops'][number]): string {
  if (!op.existingSubscribers) return '';
  const label = `${SUBSCRIBER_LABELS[op.existingSubscribers] ?? op.existingSubscribers}${op.existingSubscribersVerified === false ? ' (unverified)' : ''}`;
  return op.ifMigrated ? `${label} (migrating: ${MIGRATION_LABELS[op.ifMigrated] ?? op.ifMigrated})` : label;
}

/**
 * Notes aren't covered by the plan hash, so diff doesn't take their class on
 * trust: it recomputes it from the op (before = the price subscribers pay now,
 * after, options.preserveCurrentPrice) with the note's inputs. A scheduled
 * change can't be recomputed (the op's before is the scheduled slot, not the
 * current price), so its stored class is shown as unverified.
 */
function recheckNote(op: BasePriceOp, note: PriceChangeNote, createdAt: string) {
  if (op.kind !== 'setPrice' || !op.after) {
    return { classification: note.classification as string, ifMigrated: note.ifMigrated as string | undefined, verified: false };
  }
  const c = classifyPriceChange({
    platform: op.platform,
    productType: op.target.product.type,
    territory: op.target.territory,
    current: op.before,
    after: op.after,
    effectiveDate: note.inputs?.effectiveDate ?? createdAt.slice(0, 10),
    ...(op.options?.preserveCurrentPrice !== undefined ? { preserveCurrentPrice: op.options.preserveCurrentPrice } : {}),
    context: noteConsentContext(note, op.after.currency),
  });
  const stored = `${note.classification}${note.ifMigrated ? ` (migrating: ${note.ifMigrated})` : ''}`;
  const recomputed = `${c.classification}${c.ifMigrated ? ` (migrating: ${c.ifMigrated})` : ''}`;
  return {
    classification: c.classification as string,
    ifMigrated: c.ifMigrated as string | undefined,
    verified: true,
    ...(stored !== recomputed ? { mismatch: { stored, recomputed } } : {}),
  };
}

function proceedsCell(op: PlanSummary['products'][number]['ops'][number]): string {
  const after = op.proceeds !== undefined ? `${op.proceeds}${op.proceedsEstimated ? ' (est.)' : ''}` : '';
  if (op.proceedsBefore !== undefined && op.proceeds !== undefined) return `${op.proceedsBefore} -> ${after}`;
  return after;
}

export async function diffCommand(ctx: CommandContext): Promise<CommandResult> {
  const workspacePlan = stringFlag(ctx.flags, 'workspace-plan');
  const fromFlag = stringFlag(ctx.flags, 'plan');
  if (workspacePlan) {
    if (fromFlag || ctx.positionals.length > 0) throw new UsageError('Give either plan files or --workspace-plan, not both');
    return diffWorkspaceCommand(ctx, workspacePlan);
  }
  if (fromFlag && ctx.positionals.length > 0) throw new UsageError('Give the plan file once: as an argument or with --plan');
  if (ctx.positionals.length > 1) return diffManyCommand(ctx, ctx.positionals);
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
  return { exitCode: summary.opCount > 0 || summary.manualActions.length > 0 ? EXIT_CHANGES : EXIT_OK, json: summary, text: formatPlanSummary(summary) };
}
