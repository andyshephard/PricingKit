// Spec and rules files may be JSON or YAML (.yaml / .yml). YAML is turned
// into the same JSON text the core parsers already read, so both formats go
// through one set of checks.
//
// YAML numbers would lose what the author wrote (4.10 -> 4.1, an App Store ID
// 0123... -> 123), and the core takes amounts as decimal strings. So every
// number keeps its source text, except under the few keys whose value is a
// real integer (schemaVersion, periods, ...). Tags (!!binary, custom tags),
// several documents in one file, duplicate keys and alias bombs are refused.
// Error messages give the line and column only, never the file's text.

import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isPair, isScalar, parseDocument, visit } from 'yaml';
import {
  appRefSchema,
  fixedPricesFromCsv,
  OFFER_KINDS,
  offerPricesFromCsv,
  parseMultiplierCsv,
  parsePricesCsv,
  PricesCsvError,
  productKey,
  productRefSchema,
  type AppRef,
  type CsvPrices,
  type OfferKind,
  type PricesCsvRow,
  type ProductRef,
} from '@/lib/pricing';
import { readInputFile, type CommandContext } from './context';
import { CliError } from './errors';

/** Keys whose value the core schemas take as a JSON number */
const INTEGER_KEYS = new Set([
  'schemaVersion',
  'periods',
  'phase',
  'recurrenceCount',
  'paidSubscriptionDurationInMonths',
  'minimum',
  'maximum',
  'waitBetweenOffersInMonths',
  // pricing spec: pppStaleness.maxAgeYears and freshness.maxAgeDays.<data set>
  'maxAgeYears',
  'ppp',
  'bigmac',
  'netflix',
  'fallbackExchangeRates',
  'appleTiers',
]);

export function isYamlPath(path: string): boolean {
  return ['.yaml', '.yml'].includes(extname(path).toLowerCase());
}

export class YamlSpecError extends CliError {
  constructor(what: string, detail: string) {
    super(`${what} is not valid YAML (${detail})`, 'INVALID_YAML');
    this.name = 'YamlSpecError';
  }
}

/** YAML text -> JSON text for the core parsers. Throws YamlSpecError. */
export function yamlToJson(text: string, what = 'the file'): string {
  const doc = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true, prettyErrors: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    const offset = problem.pos?.[0];
    throw new YamlSpecError(what, `${offset !== undefined ? `${position(text, offset)}: ` : ''}${problem.code}`);
  }
  let tagged: { tag: string; at?: string } | undefined;
  visit(doc, {
    Node(_key, node) {
      if (node.tag === undefined) return undefined;
      tagged = { tag: node.tag, ...(node.range ? { at: position(text, node.range[0]) } : {}) };
      return visit.BREAK;
    },
  });
  if (tagged) throw new YamlSpecError(what, `${tagged.at ? `${tagged.at}: ` : ''}tags such as ${tagged.tag} aren't allowed`);
  visit(doc, {
    Scalar(key, node, path) {
      if (typeof node.value !== 'number' && typeof node.value !== 'bigint') return;
      if (key === 'key') return; // map keys are strings in JSON anyway
      const parent = path[path.length - 1];
      if (isPair(parent) && isScalar(parent.key) && INTEGER_KEYS.has(String(parent.key.value))) return;
      node.value = node.source ?? String(node.value);
    },
  });
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 100 });
  } catch {
    throw new YamlSpecError(what, 'too many aliases');
  }
  return JSON.stringify(value ?? null);
}

/** "line L, column C" (1-based) of an offset in text */
function position(text: string, offset: number): string {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length))).split('\n');
  return `line ${before.length}, column ${before[before.length - 1].length + 1}`;
}

/**
 * Read a spec or rules file as JSON text: JSON files as they are, YAML files
 * (.yaml / .yml) converted. `what` names the file in errors.
 */
export async function readSpecText(ctx: CommandContext, path: string, what: string): Promise<string> {
  const text = await readInputFile(ctx, path, what);
  return isYamlPath(path) ? yamlToJson(text, `${what} ${path}`) : text;
}

/**
 * Custom strategy targets may name their multiplier table as a CSV file
 * ("multipliersFile", see parseMultiplierCsv): read it and put the table in
 * the spec as "multipliers", so the core parser checks it like an inline one.
 * The path is relative to the spec file, must stay inside the working
 * directory (symlinks resolved), and must be a .csv file. Errors never quote
 * the file's contents.
 */
/** Largest multiplier CSV read (a table of ~250 territories is a few KB) */
export const MAX_MULTIPLIER_FILE_BYTES = 1_000_000;

/** Largest prices CSV read by "pricesFile" (a workspace export of many products and offers stays well below it) */
export const MAX_PRICES_CSV_BYTES = 5_000_000;

/** A relative path of safe characters, no ".." / "." / empty segments, nothing under .git, with one of the extensions */
export function isSafeRelativePath(file: unknown, extensions: string[]): file is string {
  return (
    typeof file === 'string' &&
    /^[A-Za-z0-9._/-]+$/.test(file) &&
    !file.startsWith('/') &&
    !file.split('/').some((s) => s === '..' || s === '.' || s === '' || s === '.git') &&
    extensions.includes(extname(file).toLowerCase())
  );
}

/**
 * Read a file a spec, rules or workspace file names: relative to that file,
 * inside the working directory once symlinks are resolved, a regular file,
 * at most `maxBytes`. `where` names the field in errors; errors never quote
 * the file's contents.
 */
export async function readContainedFile(
  ctx: CommandContext,
  fromFile: string,
  file: string,
  options: { where: string; extensions: string[]; maxBytes: number; code?: string }
): Promise<string> {
  const code = options.code ?? 'INVALID_SPEC';
  const { where } = options;
  if (!isSafeRelativePath(file, options.extensions)) {
    throw new CliError(`${where}: a relative ${options.extensions.join(' / ')} path (letters, digits, ".", "_", "-", "/"; no ".." segments)`, code);
  }
  const full = resolve(ctx.cwd, dirname(fromFile), file);
  const [root, real] = await Promise.all([realpath(ctx.cwd), realpath(full).catch(() => undefined)]);
  if (real === undefined) throw new CliError(`${where}: can't read ${file}`, code);
  // Inside the working directory: a relative path that doesn't climb out ("..x.csv" is a fine name)
  const rel = relative(root, real);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CliError(`${where}: ${file} is outside the working directory`, code);
  const info = await stat(real);
  if (!info.isFile()) throw new CliError(`${where}: ${file} is not a regular file`, code);
  if (info.size > options.maxBytes) throw new CliError(`${where}: ${file} is larger than ${options.maxBytes} bytes`, code);
  try {
    return await readFile(real, 'utf8');
  } catch (error) {
    throw new CliError(`${where}: can't read ${file}${(error as { code?: string }).code ? ` (${(error as { code?: string }).code})` : ''}`, code);
  }
}

export async function inlineMultiplierFiles(ctx: CommandContext, specText: string, specPath: string): Promise<string> {
  let spec: unknown;
  try {
    spec = JSON.parse(specText);
  } catch {
    return specText; // the spec parser reports it
  }
  const products = (spec as { products?: unknown })?.products;
  if (!Array.isArray(products)) return specText;
  let changed = false;
  for (const [index, entry] of products.entries()) {
    const targets = (entry as { targets?: Record<string, unknown> } | null)?.targets;
    if (!targets || typeof targets !== 'object' || !Object.hasOwn(targets, 'multipliersFile')) continue;
    const where = `products.${index}.targets.multipliersFile`;
    const file = targets.multipliersFile;
    if (!isSafeRelativePath(file, ['.csv'])) {
      throw new CliError(`${where}: a relative .csv path (letters, digits, ".", "_", "-", "/"; no ".." segments)`, 'INVALID_SPEC');
    }
    if (targets.multipliers !== undefined) throw new CliError(`${where}: give multipliers or multipliersFile, not both`, 'INVALID_SPEC');
    const text = await readContainedFile(ctx, specPath, file, { where, extensions: ['.csv'], maxBytes: MAX_MULTIPLIER_FILE_BYTES });
    try {
      targets.multipliers = parseMultiplierCsv(text);
    } catch (error) {
      throw new CliError(`${where}: ${(error as Error).message}`, 'INVALID_SPEC');
    }
    delete targets.multipliersFile;
    changed = true;
  }
  return changed ? JSON.stringify(spec) : specText;
}

/** Where each imported CSV price came from, for the plan's report on rows that don't snap exactly */
export interface CsvImport {
  /** The spec field, e.g. products.0.targets.pricesFile */
  where: string;
  file: string;
  app: AppRef;
  product: ProductRef;
  /** Set for an offer's prices */
  offer?: { kind: OfferKind; key: string };
  /** territory -> { CSV line, price, currency } */
  rows: Record<string, { line: number; amount: string; currency: string }>;
}

function parseCsvFor(text: string, where: string): PricesCsvRow[] {
  try {
    return parsePricesCsv(text);
  } catch (error) {
    if (error instanceof PricesCsvError) throw new CliError(`${where}: ${error.message}`, 'INVALID_CSV');
    throw error;
  }
}

/**
 * Fixed prices from a prices CSV ("pricesFile", see src/lib/pricing/prices-csv.ts):
 *   pricingkit.spec          products[].targets { "type": "fixed", "pricesFile": "prices.csv" }
 *   pricingkit.offerPlanSpec offers[].pricing  { "type": "fixed", "pricesFile": "offers.csv" }
 * The rows naming that product (and offer) become the prices, in the spec,
 * before the core parser checks it. The path gets the same checks as
 * multipliersFile (relative to the spec, inside the working directory, a
 * regular file, at most MAX_PRICES_CSV_BYTES). `app` defaults to the spec's own.
 */
export async function inlinePricesFiles(ctx: CommandContext, specText: string, specPath: string, fallbackApp?: AppRef): Promise<{ text: string; imports: CsvImport[] }> {
  let spec: { app?: unknown; products?: unknown; offers?: unknown };
  try {
    spec = JSON.parse(specText);
  } catch {
    return { text: specText, imports: [] };
  }
  if (!spec || typeof spec !== 'object') return { text: specText, imports: [] };
  const appParsed = appRefSchema.safeParse(spec.app ?? fallbackApp);
  const imports: CsvImport[] = [];
  const cache = new Map<string, PricesCsvRow[]>();
  const load = async (file: unknown, where: string) => {
    if (!isSafeRelativePath(file, ['.csv'])) throw new CliError(`${where}: a relative .csv path (letters, digits, ".", "_", "-", "/"; no ".." segments)`, 'INVALID_SPEC');
    if (!cache.has(file)) cache.set(file, parseCsvFor(await readContainedFile(ctx, specPath, file, { where, extensions: ['.csv'], maxBytes: MAX_PRICES_CSV_BYTES }), where));
    return { file, rows: cache.get(file)! };
  };
  const productOf = (value: unknown) => {
    const parsed = productRefSchema.safeParse(value);
    return parsed.success ? (parsed.data as ProductRef) : undefined;
  };

  for (const [index, entry] of (Array.isArray(spec.products) ? spec.products : []).entries()) {
    const targets = (entry as { targets?: Record<string, unknown> } | null)?.targets;
    if (!targets || typeof targets !== 'object' || !Object.hasOwn(targets, 'pricesFile')) continue;
    const where = `products.${index}.targets.pricesFile`;
    if (targets.type !== 'fixed') throw new CliError(`${where}: pricesFile goes with targets of type "fixed"`, 'INVALID_SPEC');
    if (targets.prices !== undefined) throw new CliError(`${where}: give prices or pricesFile, not both`, 'INVALID_SPEC');
    const product = productOf((entry as { product?: unknown }).product);
    if (!product || !appParsed.success) throw new CliError(`${where}: the spec's app and the product must be valid to pick their rows`, 'INVALID_SPEC');
    const { file, rows } = await load(targets.pricesFile, where);
    const found = fixedPricesFromCsv(rows, appParsed.data as AppRef, product);
    if (Object.keys(found.prices).length === 0) throw new CliError(`${where}: ${file} has no base price rows for ${productKey(product)} of this app`, 'INVALID_SPEC');
    targets.prices = found.prices;
    delete targets.pricesFile;
    imports.push({ where, file, app: appParsed.data as AppRef, product, rows: importRows(found) });
  }

  for (const [index, offer] of (Array.isArray(spec.offers) ? spec.offers : []).entries()) {
    const pricing = (offer as { pricing?: Record<string, unknown> } | null)?.pricing;
    if (!pricing || typeof pricing !== 'object' || !Object.hasOwn(pricing, 'pricesFile')) continue;
    const where = `offers.${index}.pricing.pricesFile`;
    if (pricing.type !== 'fixed') throw new CliError(`${where}: pricesFile goes with pricing of type "fixed"`, 'INVALID_SPEC');
    if (pricing.prices !== undefined) throw new CliError(`${where}: give prices or pricesFile, not both`, 'INVALID_SPEC');
    const o = offer as { productRef?: unknown; kind?: unknown; id?: unknown };
    const product = productOf(o.productRef);
    if (!product || !appParsed.success || typeof o.kind !== 'string' || !(OFFER_KINDS as readonly string[]).includes(o.kind) || typeof o.id !== 'string') {
      throw new CliError(`${where}: the spec's app and the offer's productRef, kind and id must be valid to pick its rows`, 'INVALID_SPEC');
    }
    if (o.kind === 'apple.intro') throw new CliError(`${where}: introductory offers have no key of their own to match CSV rows; give their prices inline`, 'INVALID_SPEC');
    const { file, rows } = await load(pricing.pricesFile, where);
    const key = { kind: o.kind as OfferKind, key: o.id };
    const found = offerPricesFromCsv(rows, appParsed.data as AppRef, product, key);
    if (Object.keys(found.prices).length === 0) throw new CliError(`${where}: ${file} has no rows for offer ${o.kind} of ${productKey(product)}`, 'INVALID_SPEC');
    // Offer fixed prices are amounts in each territory's own currency; the CSV's currency is checked against the plan
    pricing.prices = Object.fromEntries(Object.entries(found.prices).map(([t, p]) => [t, p.amount]));
    delete pricing.pricesFile;
    imports.push({ where, file, app: appParsed.data as AppRef, product, offer: key, rows: importRows(found) });
  }
  return imports.length > 0 ? { text: JSON.stringify(spec), imports } : { text: specText, imports };
}

function importRows(found: CsvPrices): CsvImport['rows'] {
  return Object.fromEntries(Object.entries(found.prices).map(([t, p]) => [t, { line: found.lines[t], amount: p.amount, currency: p.currency }]));
}
