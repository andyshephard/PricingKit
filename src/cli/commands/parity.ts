// pricingkit parity: how far apart the App Store and Google Play prices of
// each mapped subscription are, territory by territory. Read-only: it reads
// both products' current prices, each through its own app's adapter.

import type { ParityReport, ParityRow } from '@/lib/pricing';
import { stringFlag } from '../args';
import type { CommandContext, CommandResult } from '../context';
import { EXIT_CHANGES, EXIT_OK, UsageError } from '../errors';
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

export function formatParityReport(report: ParityReport): string {
  const lines = [
    `Parity (${report.basis === 'plan' ? "prices once the plans are applied" : 'current prices'}): ${report.inParity ? 'in parity' : 'GAPS'} across ${report.mappings.length} ${report.mappings.length === 1 ? 'mapping' : 'mappings'}`,
  ];
  for (const m of report.mappings) {
    const counts = Object.fromEntries(Object.entries(m.summary).filter(([, n]) => n > 0));
    lines.push(
      '',
      `${m.id}: App Store ${m.appleApp.bundleId} subscription ${m.apple.id} vs Google Play ${m.playApp.packageName} ${m.play.productId}/${m.play.basePlanId}`,
      `  ${m.inParity ? 'In parity' : 'GAPS'} (threshold ${percent(m.threshold)} of the lower price): ${describeCounts(counts) || 'no territories'}`
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
  return { exitCode: report.inParity ? EXIT_OK : EXIT_CHANGES, json: report, text: formatParityReport(report) };
}
