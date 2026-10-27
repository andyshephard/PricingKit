import {
  describePlayRegionPrice,
  InvalidOfferRulesError,
  InvalidOfferSpecError,
  OfferRuleError,
  parseOfferRules,
  parsePercentOfCurrentRule,
  type OfferDriftReport,
  type OfferRules,
  type PercentOfCurrentRule,
  type PlayOfferDriftReport,
  type ProductRef,
  type RulesDriftReport,
} from '@/lib/pricing';
import { appSelection, stringFlag, type AppSelection } from '../args';
import { appleAdapter, playAdapter, type CommandContext, type CommandResult } from '../context';
import { readSpecText } from '../spec-file';
import { CliError, EXIT_CHANGES, EXIT_ERROR, EXIT_OK, UsageError, type ExitCode } from '../errors';
import { describeCounts, money, table } from '../format';
import { productFromFlags } from './export';
import { appleOnly, parseOfferKind } from './offers';
import { driftWorkspaceCommand } from './workspace';

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

function productLabel(product: ProductRef): string {
  return product.platform === 'apple' ? product.id : product.type === 'subscription' ? `${product.productId}/${product.basePlanId}` : product.productId;
}

export function formatPlayDriftReport(report: PlayOfferDriftReport): string {
  const r = report.rule;
  const rule =
    r.type === 'percentOfCurrent'
      ? `${r.percent}% of each region's base price${r.basis ? `, ${r.basis}` : ''} (a Play price per region)`
      : r.type === 'play.relativeDiscount'
        ? `${r.fraction} relative discount (follows the base price by itself)`
        : r.type === 'play.absoluteDiscount'
          ? 'a fixed amount off per region'
          : 'fixed prices per region';
  const lines = [
    `Play offer ${report.offer.key} (${report.offer.state}), phase ${report.phase} of: ${report.offer.phases.join('; ')}; billing period ${report.billingPeriod}`,
    `Eligibility: ${report.offer.eligibility}; tags: ${report.offer.tags.join(', ') || 'none'}`,
    `Rule: ${rule}`,
    `${report.inSync ? 'In sync' : 'DRIFT'}: ${describeCounts(report.summary as unknown as Record<string, number>)}`,
  ];
  const drifted = report.territories.filter((t) => t.status !== 'match');
  if (drifted.length > 0) {
    lines.push(
      table([
        ['Region', 'Status', 'Offer', 'Rule gives', 'Reason'],
        ...drifted.map((t) => [t.territory, t.status, describePlayRegionPrice(t.actual), describePlayRegionPrice(t.expected), t.reason ?? '']),
      ])
    );
  }
  if (report.outOfScope?.length) lines.push(`Not checked (outside the rule's regions): ${report.outOfScope.join(', ')}`);
  for (const p of report.problems ?? []) lines.push(`problem: ${p}`);
  for (const w of report.warnings ?? []) lines.push(`warning: ${w.territory}: ${w.message}`);
  return lines.join('\n');
}

export function formatDriftReport(report: OfferDriftReport | PlayOfferDriftReport): string {
  if (report.kind === 'pricingkit.playOfferDrift') return formatPlayDriftReport(report);
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
  if (report.outOfScope?.length) lines.push(`Not checked (outside --territories): ${report.outOfScope.join(', ')}`);
  for (const p of report.problems ?? []) lines.push(`problem: ${p}`);
  for (const w of report.warnings ?? []) lines.push(`warning: ${w.territory}: ${w.message}`);
  return lines.join('\n');
}

export async function driftCommand(ctx: CommandContext): Promise<CommandResult> {
  const workspacePath = stringFlag(ctx.flags, 'workspace');
  if (workspacePath) {
    const extra = ['rules', 'bundle-id', 'package-name', ...SINGLE_OFFER_FLAGS].filter((f) => ctx.flags[f] !== undefined);
    if (extra.length > 0) throw new UsageError(`--workspace checks every app's rules file; drop ${extra.map((f) => `--${f}`).join(', ')}`);
    return driftWorkspaceCommand(ctx, workspacePath);
  }
  const rulesPath = stringFlag(ctx.flags, 'rules');
  if (rulesPath) return rulesDriftCommand(ctx, rulesPath);
  const app = appSelection(ctx.flags)!;
  if (app.platform === 'google') return playDriftCommand(ctx, app);
  if (ctx.flags['relative-discount'] !== undefined) throw new UsageError('--relative-discount is for Google Play offers');
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

// ---------------------------------------------------------------------------
// pricingkit drift --rules: every offer in a rules file, one report

/** One Play offer, checked as a one-rule rules file: --percent (a price per region) or --relative-discount */
async function playDriftCommand(ctx: CommandContext, app: Extract<AppSelection, { platform: 'google' }>): Promise<CommandResult> {
  const productId = stringFlag(ctx.flags, 'subscription', true);
  const basePlanId = stringFlag(ctx.flags, 'base-plan', true);
  const offer = stringFlag(ctx.flags, 'offer', true);
  const kind = stringFlag(ctx.flags, 'kind');
  if (kind !== undefined && kind !== 'play.offer') throw new UsageError('On Google Play, --kind can only be play.offer');
  const percent = stringFlag(ctx.flags, 'percent');
  const fraction = stringFlag(ctx.flags, 'relative-discount');
  if ((percent === undefined) === (fraction === undefined)) throw new UsageError('Give one of --percent <n> (a price per region) or --relative-discount <0..1> (Play\'s native discount)');
  const basis = stringFlag(ctx.flags, 'basis');
  const threshold = stringFlag(ctx.flags, 'threshold');
  const territories = parseTerritories(stringFlag(ctx.flags, 'territories'));
  if (basis !== undefined && !(BASES as readonly string[]).includes(basis)) throw new UsageError(`--basis must be one of ${BASES.join(', ')}`);
  if (basis !== undefined && fraction !== undefined) throw new UsageError('--basis goes with --percent');
  if (threshold !== undefined && !/^(0(\.\d{1,4})?|1)$/.test(threshold)) throw new UsageError('--threshold is a fraction between 0 and 1, e.g. 0.05');
  if (ctx.flags.snap !== undefined) throw new UsageError("--snap doesn't apply on Google Play: Play's own price conversion makes each target a valid price");
  const product: ProductRef = { platform: 'google', type: 'subscription', productId, basePlanId };
  const rulesInput = {
    kind: 'pricingkit.offerRules',
    schemaVersion: 1,
    app: { packageName: app.packageName },
    offers: [
      {
        product,
        kind: 'play.offer',
        key: offer,
        pricing: percent !== undefined ? { type: 'percentOfCurrent', percent, ...(basis ? { basis } : {}), snap: 'nearest' } : { type: 'play.relativeDiscount', fraction },
        ...(territories ? { territories } : {}),
        ...(threshold ? { deviationThreshold: threshold } : {}),
        syncWithBase: false,
      },
    ],
  };
  let rules: OfferRules;
  try {
    rules = parseOfferRules(rulesInput);
  } catch (error) {
    if (error instanceof InvalidOfferRulesError) throw new UsageError(`Invalid rule: ${error.problems.map((p) => p.replace(/^offers\.0\.?/, '')).join('; ')}`);
    throw error;
  }
  const adapter = await playAdapter(ctx, app.packageName);
  const [entry] = (await adapter.checkRulesDrift(rules)).offers;
  if (entry.status === 'notFound') throw new CliError(`No Play offer "${offer}" on base plan ${productId}/${basePlanId}`, 'NOT_FOUND');
  if (entry.status === 'error' || !entry.report) throw new CliError(entry.error?.message ?? 'The offer could not be checked', entry.error?.code ?? 'OFFER_RULE');
  return { exitCode: entry.report.inSync ? EXIT_OK : EXIT_CHANGES, json: entry.report, text: formatDriftReport(entry.report) };
}

const SINGLE_OFFER_FLAGS = ['subscription', 'base-plan', 'kind', 'offer', 'percent', 'relative-discount', 'basis', 'snap', 'threshold', 'territories'];

/**
 * 2 when any offer drifted or is missing (the report says which), otherwise
 * 1 when an offer couldn't be checked, otherwise 0.
 */
export function rulesDriftExitCode(report: RulesDriftReport): ExitCode {
  if (report.summary.drifted > 0 || report.summary.notFound > 0) return EXIT_CHANGES;
  if (report.summary.errors > 0) return EXIT_ERROR;
  return EXIT_OK;
}

export function formatRulesDriftReport(report: RulesDriftReport): string {
  const app = 'bundleId' in report.app ? report.app.bundleId : report.app.packageName;
  const s = report.summary;
  // DRIFT whenever an offer drifted or is missing (exit 2, even with errors); NOT CHECKED when
  // nothing drifted but an offer couldn't be checked (exit 1)
  const status = report.inSync ? 'In sync' : s.drifted > 0 || s.notFound > 0 ? 'DRIFT' : 'NOT CHECKED';
  const errors = report.offers.filter((o) => o.status === 'error');
  const lines = [
    `Offer rules for ${app}, checked ${report.checkedAt}`,
    `${status}: ${s.offers} offers: ${s.inSync} in sync, ${s.drifted} drifted, ${s.notFound} not found, ${s.errors} not checkable`,
    ...(errors.length > 0
      ? [
          `ERRORS: ${errors.length} ${errors.length === 1 ? 'offer' : 'offers'} could not be checked${status === 'DRIFT' ? ' (the exit code reports the drift; fix these too)' : ''}:`,
          ...errors.map((o) => `  ${productLabel(o.product)} ${o.kind} "${o.key}": ${o.error?.message ?? 'unknown error'}`),
        ]
      : []),
    table(
      report.offers.map((o) => [
        productLabel(o.product),
        o.kind,
        o.key,
        o.status,
        o.status === 'drifted' && o.report ? describeCounts(Object.fromEntries(Object.entries(o.report.summary).filter(([k, n]) => k !== 'match' && n > 0))) : o.error?.message ?? '',
      ])
    ),
  ];
  for (const o of report.offers) {
    if (o.status === 'drifted' && o.report) lines.push('', formatDriftReport(o.report));
  }
  for (const n of report.notChecked ?? []) lines.push('', `Not checked: ${n}`);
  return lines.join('\n');
}

/** Does the --bundle-id / --package-name on the command line name this app? */
export function sameApp(selected: AppSelection, app: OfferRules['app']): boolean {
  return selected.platform === 'apple' ? 'bundleId' in app && app.bundleId === selected.bundleId : 'packageName' in app && app.packageName === selected.packageName;
}

async function rulesDriftCommand(ctx: CommandContext, rulesPath: string): Promise<CommandResult> {
  const extra = SINGLE_OFFER_FLAGS.filter((f) => ctx.flags[f] !== undefined);
  if (extra.length > 0) throw new UsageError(`--rules checks the offers and rules in the file; drop ${extra.map((f) => `--${f}`).join(', ')}`);
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
  const adapter = 'bundleId' in rules.app ? await appleAdapter(ctx, rules.app.bundleId) : await playAdapter(ctx, rules.app.packageName);
  const report = await adapter.checkRulesDrift(rules);
  return { exitCode: rulesDriftExitCode(report), json: report, text: formatRulesDriftReport(report) };
}
