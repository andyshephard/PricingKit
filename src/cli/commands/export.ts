import { createStateSnapshot, serializeStateSnapshot, type AppRef, type ProductPriceState, type ProductRef } from '@/lib/pricing';
import { appSelection, stringFlag, type AppSelection, type Flags } from '../args';
import { appleAdapter, playAdapter, writeOutputFile, type CommandContext, type CommandResult } from '../context';
import { EXIT_OK, UsageError } from '../errors';
import { priceCell, table } from '../format';

/** The product named by --subscription (and --base-plan on Google Play) */
export function productFromFlags(app: AppSelection, flags: Flags): ProductRef {
  const subscription = stringFlag(flags, 'subscription', true);
  if (app.platform === 'apple') {
    if (!/^\d+$/.test(subscription)) throw new UsageError('--subscription must be the numeric App Store Connect subscription ID');
    if (flags['base-plan'] !== undefined) throw new UsageError('--base-plan is for Google Play only');
    return { platform: 'apple', type: 'subscription', id: subscription };
  }
  return { platform: 'google', type: 'subscription', productId: subscription, basePlanId: stringFlag(flags, 'base-plan', true) };
}

export function appRef(app: AppSelection): AppRef {
  return app.platform === 'apple' ? { bundleId: app.bundleId } : { packageName: app.packageName };
}

export function stateTable(state: ProductPriceState): string {
  const rows = [['Territory', 'Current', 'Scheduled', 'Notes']];
  for (const territory of Object.keys(state.territories).sort()) {
    const t = state.territories[territory];
    const notes = [
      ...(t.availability && t.availability !== 'AVAILABLE' ? [t.availability] : []),
      ...(t.problems?.current ? [`current: ${t.problems.current}`] : []),
      ...(t.problems?.scheduled ? [`scheduled: ${t.problems.scheduled}`] : []),
    ];
    rows.push([territory, priceCell(t.current), priceCell(t.scheduled), notes.join('; ')]);
  }
  return table(rows);
}

export async function exportCommand(ctx: CommandContext): Promise<CommandResult> {
  const app = appSelection(ctx.flags)!;
  const product = productFromFlags(app, ctx.flags);
  const out = stringFlag(ctx.flags, 'out');
  const adapter = app.platform === 'apple' ? await appleAdapter(ctx, app.bundleId) : await playAdapter(ctx, app.packageName);

  const state = await adapter.fetchState(product);
  const snapshot = createStateSnapshot(appRef(app), [state], ctx.now().toISOString());
  const written = out ? await writeOutputFile(ctx, out, serializeStateSnapshot(snapshot)) : undefined;

  const lines = [
    `${Object.keys(state.territories).length} territories`,
    stateTable(state),
    ...(state.warnings?.length ? ['Warnings:', ...state.warnings.map((w) => `  ${w}`)] : []),
    ...(written ? [`Snapshot written to ${written}`] : []),
  ];
  return { exitCode: EXIT_OK, json: snapshot, text: lines.join('\n') };
}
