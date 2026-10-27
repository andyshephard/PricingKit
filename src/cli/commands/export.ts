import {
  createStateSnapshot,
  pricesCsvRowsFromOffers,
  pricesCsvRowsFromState,
  productKey,
  serializePricesCsv,
  serializeStateSnapshot,
  type AppRef,
  type PricesCsvEntry,
  type ProductPriceState,
  type ProductRef,
} from '@/lib/pricing';
import { appSelection, stringFlag, type AppSelection, type Flags } from '../args';
import { adapterForApp, appleAdapter, playAdapter, writeOutputFile, type CommandContext, type CommandResult } from '../context';
import { loadWorkspace } from '../workspace';
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

/**
 * The product's current state: a subscription (--subscription, plus
 * --base-plan on Google Play) or an in-app purchase / one-time product
 * (--in-app <product ID>). Reads only.
 */
async function readProductState(ctx: CommandContext, app: AppSelection): Promise<ProductPriceState> {
  const inApp = stringFlag(ctx.flags, 'in-app');
  if (inApp === undefined) {
    const product = productFromFlags(app, ctx.flags);
    const adapter = app.platform === 'apple' ? await appleAdapter(ctx, app.bundleId) : await playAdapter(ctx, app.packageName);
    return adapter.fetchState(product);
  }
  if (ctx.flags.subscription !== undefined || ctx.flags['base-plan'] !== undefined) {
    throw new UsageError('Give either --in-app <product id> or --subscription (with --base-plan on Google Play), not both');
  }
  if (app.platform === 'apple') return (await appleAdapter(ctx, app.bundleId)).fetchInAppPurchaseState(inApp);
  // Google Play one-time product: its first purchase option, the one PricingKit edits
  return (await playAdapter(ctx, app.packageName)).fetchState({ platform: 'google', type: 'inapp', productId: inApp });
}

export async function exportCommand(ctx: CommandContext): Promise<CommandResult> {
  const format = stringFlag(ctx.flags, 'format') ?? 'json';
  if (format !== 'json' && format !== 'csv') throw new UsageError('--format must be json (a pricingkit.state snapshot) or csv (a pricingkit.prices CSV)');
  if (ctx.flags.offers === true && format !== 'csv') throw new UsageError('--offers goes with --format csv');
  if (format === 'csv' && ctx.json) throw new UsageError('--format csv prints the CSV itself; leave out --json');
  const workspace = stringFlag(ctx.flags, 'workspace');
  if (workspace) return exportWorkspace(ctx, workspace, format);

  const app = appSelection(ctx.flags)!;
  const out = stringFlag(ctx.flags, 'out');
  const state = await readProductState(ctx, app);
  if (format === 'csv') {
    const offers = ctx.flags.offers === true ? await readOffers(ctx, appRef(app), state.product) : undefined;
    return csvResult(ctx, out, [{ app: appRef(app), state, offers }]);
  }
  const snapshot = createStateSnapshot(appRef(app), [state], ctx.now().toISOString());
  const written = out ? await writeOutputFile(ctx, out, serializeStateSnapshot(snapshot)) : undefined;

  const lines = [
    `${Object.keys(state.territories).length} territories${state.baseTerritory ? ` (base territory ${state.baseTerritory})` : ''}`,
    stateTable(state),
    ...(state.warnings?.length ? ['Warnings:', ...state.warnings.map((w) => `  ${w}`)] : []),
    ...(written ? [`Snapshot written to ${written}`] : []),
  ];
  return { exitCode: EXIT_OK, json: snapshot, text: lines.join('\n') };
}

/** A subscription's offers (App Store subscription or Play base plan); one-time products and in-app purchases have none */
async function readOffers(ctx: CommandContext, app: AppRef, product: ProductRef) {
  if (product.type !== 'subscription') throw new UsageError('--offers is for subscriptions (App Store) and base plans (Google Play)');
  const adapter = await adapterForApp(ctx, app);
  return adapter.fetchOffers(product);
}

type CsvSource = { app: AppRef; state: ProductPriceState; offers?: Awaited<ReturnType<typeof readOffers>> };

async function csvResult(ctx: CommandContext, out: string | undefined, sources: CsvSource[]): Promise<CommandResult> {
  const rows: PricesCsvEntry[] = [];
  const notes: string[] = [];
  for (const { app, state, offers } of sources) {
    const base = pricesCsvRowsFromState(app, state);
    rows.push(...base.rows);
    for (const s of base.skipped) notes.push(`${productKey(state.product)} ${s.territory}: left out, ${s.reason}`);
    if (offers) {
      const fromOffers = pricesCsvRowsFromOffers(app, state.product, offers);
      rows.push(...fromOffers.rows);
      for (const s of fromOffers.skipped) notes.push(`${productKey(state.product)} ${s.offer}${s.territory ? ` ${s.territory}` : ''}: left out, ${s.reason}`);
    }
  }
  const csv = serializePricesCsv(rows);
  if (!out) {
    // The CSV is the result; notes go to stderr through the console
    for (const n of notes) console.warn(n);
    return { exitCode: EXIT_OK, json: null, text: csv.replace(/\r\n$/, '') };
  }
  const written = await writeOutputFile(ctx, out, csv);
  return {
    exitCode: EXIT_OK,
    json: null,
    text: [`${rows.length} rows (${sources.length} ${sources.length === 1 ? 'product' : 'products'}) written to ${written}`, ...notes.map((n) => `  ${n}`)].join('\n'),
  };
}

/** Every product a workspace names (its specs, rules, offer specs and parity mappings), app by app */
async function exportWorkspace(ctx: CommandContext, workspacePath: string, format: 'json' | 'csv'): Promise<CommandResult> {
  for (const flag of ['bundle-id', 'package-name', 'subscription', 'base-plan', 'in-app']) {
    if (ctx.flags[flag] !== undefined) throw new UsageError(`--workspace exports every product the workspace names; drop --${flag}`);
  }
  const loaded = await loadWorkspace(ctx, workspacePath);
  const out = stringFlag(ctx.flags, 'out');
  const sources: CsvSource[] = [];
  for (const app of loaded.apps) {
    const products = new Map<string, ProductRef>();
    for (const p of app.spec?.products ?? []) products.set(productKey(p.product), p.product);
    for (const r of app.rules?.offers ?? []) products.set(productKey(r.product), r.product);
    for (const o of app.offers?.offers ?? []) products.set(productKey(o.productRef), o.productRef);
    for (const m of loaded.workspace.parity ?? []) {
      if ('bundleId' in app.entry.app && m.apple.bundleId === app.entry.app.bundleId) products.set(`apple:subscription:${m.apple.subscription}`, { platform: 'apple', type: 'subscription', id: m.apple.subscription });
      if ('packageName' in app.entry.app && m.play.packageName === app.entry.app.packageName) {
        const ref: ProductRef = { platform: 'google', type: 'subscription', productId: m.play.subscription, basePlanId: m.play.basePlan };
        products.set(productKey(ref), ref);
      }
    }
    if (products.size === 0) continue;
    // Read through this app's own adapter, after checking each product belongs to it
    const adapter = await adapterForApp(ctx, app.entry.app);
    for (const product of [...products.values()].sort((a, b) => productKey(a).localeCompare(productKey(b)))) {
      await adapter.verifyProduct(product);
      const state = await adapter.fetchState(product);
      const offers = ctx.flags.offers === true && product.type === 'subscription' ? await adapter.fetchOffers(product) : undefined;
      sources.push({ app: app.entry.app, state, ...(offers ? { offers } : {}) });
    }
  }
  if (sources.length === 0) throw new UsageError('The workspace names no products to export');
  if (format === 'csv') return csvResult(ctx, out, sources);
  const now = ctx.now().toISOString();
  const byApp = new Map<string, { app: AppRef; states: ProductPriceState[] }>();
  for (const s of sources) {
    const key = JSON.stringify(s.app);
    if (!byApp.has(key)) byApp.set(key, { app: s.app, states: [] });
    byApp.get(key)!.states.push(s.state);
  }
  const snapshots = [...byApp.values()].map((a) => createStateSnapshot(a.app, a.states, now));
  const written = out ? await writeOutputFile(ctx, out, `${JSON.stringify(snapshots, null, 2)}\n`) : undefined;
  return {
    exitCode: EXIT_OK,
    json: snapshots,
    text: [...snapshots.map((s) => `${'bundleId' in s.app ? s.app.bundleId : s.app.packageName}: ${s.products.length} products`), ...(written ? [`Snapshots written to ${written}`] : [])].join('\n'),
  };
}
