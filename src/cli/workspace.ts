// Loading a workspace (pricingkit.workspace): the file itself, then each
// app's spec, rules and offer plan spec files, relative to the workspace file
// and contained in the working directory (the same checks as multipliersFile
// and pricesFile). Every app is checked against the PRICINGKIT_EXPECT_* pins
// before anything is read from a store or any credential is loaded.

import { dirname, join } from 'node:path';
import {
  appLabel,
  InvalidOfferRulesError,
  OFFER_PLAN_SPEC_KIND,
  parseOfferPlanSpec,
  parseOfferRules,
  parsePricingSpec,
  parseWorkspace,
  PRICING_SPEC_KIND,
  sameAppRef,
  WorkspaceError,
  workspaceAppSpec,
  type OfferPlanSpec,
  type OfferRules,
  type PricingSpec,
  type PricingWorkspace,
  type WorkspaceApp,
} from '@/lib/pricing';
import { assertExpectedApp, type CommandContext } from './context';
import { CliError } from './errors';
import { inlineMultiplierFiles, inlinePricesFiles, isYamlPath, readContainedFile, readSpecText, yamlToJson, type CsvImport } from './spec-file';

/** Largest spec, rules or offer plan spec a workspace may reference */
export const MAX_WORKSPACE_FILE_BYTES = 5_000_000;

export interface LoadedWorkspaceApp {
  entry: WorkspaceApp;
  /** Base prices: the app's own products plus parity targets (undefined when there are none) */
  spec?: PricingSpec;
  rules?: OfferRules;
  offers?: OfferPlanSpec;
  /** Prices imported from CSV files, for the plan's report */
  csvImports: CsvImport[];
}

export interface LoadedWorkspace {
  path: string;
  workspace: PricingWorkspace;
  apps: LoadedWorkspaceApp[];
}

function kindOf(text: string): unknown {
  try {
    return (JSON.parse(text) as { kind?: unknown })?.kind;
  } catch {
    return undefined;
  }
}

/** Read a file the workspace names, as JSON text (YAML converted) */
async function readReferenced(ctx: CommandContext, workspacePath: string, file: string, where: string): Promise<string> {
  const text = await readContainedFile(ctx, workspacePath, file, { where, extensions: ['.json', '.yaml', '.yml'], maxBytes: MAX_WORKSPACE_FILE_BYTES, code: 'INVALID_WORKSPACE' });
  return isYamlPath(file) ? yamlToJson(text, `${where} ${file}`) : text;
}

function invalid(error: unknown, where: string, code: string): never {
  if (error instanceof CliError) throw error;
  throw new CliError(`${where}: ${(error as Error).message}`, code);
}

/** The pins cover every app before anything else happens */
export function assertWorkspacePins(ctx: CommandContext, workspace: PricingWorkspace): void {
  for (const entry of workspace.apps) assertExpectedApp(ctx, entry.app);
}

export async function loadWorkspace(ctx: CommandContext, path: string): Promise<LoadedWorkspace> {
  let workspace: PricingWorkspace;
  try {
    workspace = parseWorkspace(await readSpecText(ctx, path, 'workspace file'));
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof WorkspaceError) throw new CliError(error.message, 'INVALID_WORKSPACE');
    throw error;
  }
  assertWorkspacePins(ctx, workspace);

  const apps: LoadedWorkspaceApp[] = [];
  for (const [index, entry] of workspace.apps.entries()) {
    const where = `apps.${index} (${entry.id})`;
    const csvImports: CsvImport[] = [];

    let loadedSpec: PricingSpec | undefined;
    let inlineProducts: unknown[] | undefined;
    if (entry.spec) {
      const raw = await readReferenced(ctx, path, entry.spec, `${where}.spec`);
      if (kindOf(raw) !== PRICING_SPEC_KIND) throw new CliError(`${where}.spec: ${entry.spec} is not a pricingkit.spec (offer plan specs go under "offers")`, 'INVALID_WORKSPACE');
      // multipliersFile / pricesFile are relative to the spec file itself
      const specPath = join(dirname(path), entry.spec);
      const inlined = await inlinePricesFiles(ctx, await inlineMultiplierFiles(ctx, raw, specPath), specPath);
      csvImports.push(...inlined.imports);
      try {
        loadedSpec = parsePricingSpec(inlined.text);
      } catch (error) {
        invalid(error, `${where}.spec ${entry.spec}`, 'INVALID_SPEC');
      }
    } else if (entry.products) {
      // Inline products: their CSV files are relative to the workspace file
      const asSpec = JSON.stringify({ kind: PRICING_SPEC_KIND, schemaVersion: 1, app: entry.app, products: entry.products });
      const inlined = await inlinePricesFiles(ctx, await inlineMultiplierFiles(ctx, asSpec, path), path);
      csvImports.push(...inlined.imports.map((i) => ({ ...i, where: `${where}.${i.where}` })));
      inlineProducts = (JSON.parse(inlined.text) as { products: unknown[] }).products;
    }

    let spec: PricingSpec | undefined;
    try {
      spec = workspaceAppSpec(workspace, inlineProducts ? { ...entry, products: inlineProducts } : entry, loadedSpec);
    } catch (error) {
      if (error instanceof WorkspaceError) throw new CliError(error.message, 'INVALID_WORKSPACE');
      throw error;
    }

    let rules: OfferRules | undefined;
    if (entry.rules) {
      try {
        rules = parseOfferRules(await readReferenced(ctx, path, entry.rules, `${where}.rules`));
      } catch (error) {
        if (error instanceof InvalidOfferRulesError) throw new CliError(`${where}.rules ${entry.rules}: ${error.message}`, 'INVALID_RULES');
        invalid(error, `${where}.rules ${entry.rules}`, 'INVALID_RULES');
      }
      if (!sameAppRef(rules.app, entry.app)) throw new CliError(`${where}.rules: ${entry.rules} is for ${appLabel(rules.app)}, not ${appLabel(entry.app)}`, 'INVALID_WORKSPACE');
    }

    let offers: OfferPlanSpec | undefined;
    if (entry.offers) {
      const raw = await readReferenced(ctx, path, entry.offers, `${where}.offers`);
      if (kindOf(raw) !== OFFER_PLAN_SPEC_KIND) throw new CliError(`${where}.offers: ${entry.offers} is not a pricingkit.offerPlanSpec`, 'INVALID_WORKSPACE');
      const offersPath = join(dirname(path), entry.offers);
      const inlined = await inlinePricesFiles(ctx, raw, offersPath);
      csvImports.push(...inlined.imports);
      try {
        offers = parseOfferPlanSpec(inlined.text);
      } catch (error) {
        invalid(error, `${where}.offers ${entry.offers}`, 'INVALID_SPEC');
      }
      if (!sameAppRef(offers.app, entry.app)) throw new CliError(`${where}.offers: ${entry.offers} is for ${appLabel(offers.app)}, not ${appLabel(entry.app)}`, 'INVALID_WORKSPACE');
    }

    apps.push({ entry, ...(spec ? { spec } : {}), ...(rules ? { rules } : {}), ...(offers ? { offers } : {}), csvImports });
  }
  return { path, workspace, apps };
}
