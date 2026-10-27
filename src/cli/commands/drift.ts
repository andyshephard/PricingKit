import { InvalidOfferSpecError, OfferRuleError, parsePercentOfCurrentRule, type OfferDriftReport, type PercentOfCurrentRule } from '@/lib/pricing';
import { appSelection, stringFlag } from '../args';
import { appleAdapter, type CommandContext, type CommandResult } from '../context';
import { CliError, EXIT_CHANGES, EXIT_OK, UsageError } from '../errors';
import { describeCounts, money, table } from '../format';
import { productFromFlags } from './export';
import { appleOnly, parseOfferKind } from './offers';

const BASES = ['perPeriod', 'totalOverDuration'] as const;
const SNAPS = ['nearest', 'floor', 'ceil'] as const;

function parseTerritories(value: string | undefined): 'all' | string[] | undefined {
  if (value === undefined || value === 'all') return value;
  const list = value.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (list.length === 0 || list.some((t) => !/^[A-Z]{2}$/.test(t))) {
    throw new UsageError('--territories takes "all" or a comma-separated list of ISO alpha-2 codes, e.g. GB,US');
  }
  return [...new Set(list)];
}

export function formatDriftReport(report: OfferDriftReport): string {
  const r = report.rule;
  const lines = [
    `Offer ${report.offer.kind} ${report.offer.key} (${report.offer.mode} ${report.offer.duration}), billing period ${report.billingPeriod}`,
    `Rule: ${r.percent}% of current price, ${r.basis}, snap ${r.snap}`,
    `${report.inSync ? 'In sync' : 'DRIFT'}: ${describeCounts(report.summary as unknown as Record<string, number>)}`,
  ];
  const drifted = report.territories.filter((t) => t.status !== 'match');
  if (drifted.length > 0) {
    lines.push(
      table([
        ['Territory', 'Status', 'Offer', 'Rule gives', 'Reason'],
        ...drifted.map((t) => [t.territory, t.status, money(t.actual), money(t.expected), t.reason ?? '']),
      ])
    );
  }
  for (const p of report.problems ?? []) lines.push(`problem: ${p}`);
  for (const w of report.warnings ?? []) lines.push(`warning: ${w.territory}: ${w.message}`);
  return lines.join('\n');
}

export async function driftCommand(ctx: CommandContext): Promise<CommandResult> {
  const app = appSelection(ctx.flags)!;
  appleOnly(app, 'drift');
  const product = productFromFlags(app, ctx.flags);
  const kind = parseOfferKind(stringFlag(ctx.flags, 'kind', true));
  const offer = stringFlag(ctx.flags, 'offer', true);
  const percent = stringFlag(ctx.flags, 'percent', true);
  const basis = stringFlag(ctx.flags, 'basis');
  const snap = stringFlag(ctx.flags, 'snap') ?? 'nearest';
  const threshold = stringFlag(ctx.flags, 'threshold');
  const territories = parseTerritories(stringFlag(ctx.flags, 'territories'));
  if (basis !== undefined && !(BASES as readonly string[]).includes(basis)) throw new UsageError(`--basis must be one of ${BASES.join(', ')}`);
  if (!(SNAPS as readonly string[]).includes(snap)) throw new UsageError(`--snap must be one of ${SNAPS.join(', ')}`);
  if (threshold !== undefined && !/^(0(\.\d{1,4})?|1)$/.test(threshold)) throw new UsageError('--threshold is a fraction between 0 and 1, e.g. 0.05');

  let rule: Omit<PercentOfCurrentRule, 'basis'> & { basis?: PercentOfCurrentRule['basis'] };
  try {
    // Validate with a placeholder basis; the offer's mode decides it when --basis is left out
    const parsed = parsePercentOfCurrentRule({ type: 'percentOfCurrent', percent, basis: basis ?? 'perPeriod', snap });
    rule = { type: parsed.type, percent: parsed.percent, snap: parsed.snap, ...(basis ? { basis: parsed.basis } : {}) };
  } catch (error) {
    if (error instanceof InvalidOfferSpecError) throw new UsageError(`Invalid rule: ${error.problems.join('; ')}`);
    throw error;
  }

  const adapter = await appleAdapter(ctx, app.bundleId);
  let report: OfferDriftReport | null;
  try {
    report = await adapter.checkOfferDrift(product, {
      kind,
      offer,
      rule,
      ...(territories ? { territories } : {}),
      ...(threshold ? { deviationThreshold: threshold } : {}),
    });
  } catch (error) {
    if (error instanceof OfferRuleError) throw new CliError(error.message, 'OFFER_RULE');
    throw error;
  }
  if (!report) throw new CliError(`No ${kind} offer "${offer}" on subscription ${product.platform === 'apple' ? product.id : ''}`, 'NOT_FOUND');
  return { exitCode: report.inSync ? EXIT_OK : EXIT_CHANGES, json: report, text: formatDriftReport(report) };
}
