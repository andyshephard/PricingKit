// pricingkit parity: how far apart the App Store and Google Play prices of
// each mapped subscription are, territory by territory. Read-only: it reads
// both products' current prices, each through its own app's adapter.

import type { ParityReport, ParityRow } from '@/lib/pricing';
import { stringFlag } from '../args';
import type { CommandContext, CommandResult } from '../context';
import { EXIT_CHANGES, EXIT_ERROR, EXIT_OK, UsageError } from '../errors';
import { describeCounts, table } from '../format';
import { parityWorkspace } from './workspace';

function price(p: ParityRow['apple']): string {
  return p ? `${p.amount} ${p.currency}` : '-';
}

function percent(ratio: string | undefined): string {
  if (ratio === undefined) return '';
  const [whole, fraction = ''] = (Number(ratio) * 100).toFixed(2).split('.');
  return `${whole}.${fraction}%`;
}

const OUTCOME = { inParity: 'in parity', gaps: 'GAPS', notChecked: 'NOT CHECKED' } as const;

function oneStoreOnly(summary: ParityReport['mappings'][number]['summary']): string {
  const parts = [...(summary.appleOnly ? [`${summary.appleOnly} App Store only`] : []), ...(summary.playOnly ? [`${summary.playOnly} Google Play only`] : [])];
  return parts.length > 0 ? `; priced on one store only: ${parts.join(', ')}` : '';
}

export function formatParityReport(report: ParityReport): string {
  const appleOnly = report.mappings.reduce((n, m) => n + m.summary.appleOnly, 0);
  const playOnly = report.mappings.reduce((n, m) => n + m.summary.playOnly, 0);
  const lines = [
    `Parity (${report.basis === 'plan' ? 'prices once the plans are applied' : 'current prices'}): ${OUTCOME[report.status]} across ${report.mappings.length} ${report.mappings.length === 1 ? 'mapping' : 'mappings'}${oneStoreOnly({ same: 0, withinThreshold: 0, gap: 0, notComparable: 0, unreadable: 0, appleOnly, playOnly })}`,
  ];
  for (const m of report.mappings) {
    const counts = Object.fromEntries(Object.entries(m.summary).filter(([, n]) => n > 0));
    lines.push(
      '',
      `${m.id}: App Store ${m.appleApp.bundleId} subscription ${m.apple.id} vs Google Play ${m.playApp.packageName} ${m.play.productId}/${m.play.basePlanId}`,
      `  ${OUTCOME[m.status]} (threshold ${percent(m.threshold)} of the lower price): ${describeCounts(counts) || 'no territories'}${oneStoreOnly(m.summary)}`,
      ...(m.status === 'notChecked' ? ['  Not every territory could be compared (unreadable, different currencies, or nothing priced on both stores); see below.'] : [])
    );
    const notable = m.rows.filter((r) => r.status !== 'same');
    if (notable.length > 0) {
      lines.push(
        table([
          ['Territory', 'Status', 'App Store', 'Google Play', 'Play - App Store', 'Gap', 'Notes'],
          ...notable.map((r) => [r.territory, r.status, price(r.apple), price(r.play), r.difference ?? '', percent(r.ratio), r.reason ?? '']),
        ])
      );
    }
    if (m.notPriced?.length) lines.push(`  Not priced on either store: ${m.notPriced.join(', ')}`);
  }
  lines.push('', 'Prices are compared as each store lists them, in the territory\'s currency; territories billed in different currencies are not compared.');
  return lines.join('\n');
}

export async function parityCommand(ctx: CommandContext): Promise<CommandResult> {
  const workspace = stringFlag(ctx.flags, 'workspace');
  if (!workspace) throw new UsageError('Give the workspace: pricingkit parity --workspace <workspace file> [--mapping <id>]');
  const report = await parityWorkspace(ctx, workspace, stringFlag(ctx.flags, 'mapping'));
  // 2: a gap; 1: no gap, but something couldn't be compared; 0: in parity
  const exitCode = report.status === 'gaps' ? EXIT_CHANGES : report.status === 'notChecked' ? EXIT_ERROR : EXIT_OK;
  return { exitCode, json: report, text: formatParityReport(report) };
}
