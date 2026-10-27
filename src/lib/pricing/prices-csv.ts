// Prices CSV (pricingkit.prices v1): base prices and offer prices per
// territory, for review in a spreadsheet and for import as fixed targets.
//
// Layout:
//   line 1   "# pricingkit.prices v1"           the format and its version
//   line 2   the column header                   (PRICES_CSV_COLUMNS, any order)
//   line 3+  one row per product (or offer) and territory
//
// Columns:
//   app         bundle ID (App Store) or package name (Google Play)
//   platform    apple | google
//   product     App Store: the numeric subscription ID. Google Play: the product ID
//   base_plan   Google Play base plan ID (empty for a one-time product and on the App Store)
//   offer_kind  empty for a base price; otherwise apple.promo, apple.offerCode,
//               apple.winBack, apple.intro or play.offer
//   offer_key   the offer's key (promo offer code, offer code name, win-back offer ID,
//               Play offer ID); empty for a base price
//   territory   ISO 3166-1 alpha-2
//   currency    ISO 4217
//   price       the customer price, a plain decimal ("4.99")
//   proceeds    informational (Apple's proceeds for the price); ignored on import
//
// A spreadsheet may add trailing empty cells to the first line; they are
// allowed. Every cell is written with the export's formula-injection guard.
//
// Import (parsePricesCsv) never quotes a cell in an error: problems name the
// line and the column only. The rows of one product (or offer) become the
// "fixed" prices of a spec entry (fixedPricesFromCsv / offerPricesFromCsv);
// planning then snaps them to real price points like any fixed target.
// Framework-free: no file access (the CLI reads the file).

import { escapeCsvCell } from '../export/csv';
import type { PriceExport } from '../export/types';
import { stateFromPriceExport } from './state';
import { isDecimalString, isNegativeDecimal, normalizeDecimal, type Decimal } from './decimal';
import type { AppRef, ProductPriceState, ProductRef } from './model';
import { OFFER_KINDS, type OfferKind, type StoreOffer } from './offers';

export const PRICES_CSV_FORMAT = 'pricingkit.prices' as const;
export const PRICES_CSV_VERSION = 1 as const;
export const PRICES_CSV_HEADER_LINE = `# ${PRICES_CSV_FORMAT} v${PRICES_CSV_VERSION}`;

export const PRICES_CSV_COLUMNS = ['app', 'platform', 'product', 'base_plan', 'offer_kind', 'offer_key', 'territory', 'currency', 'price', 'proceeds'] as const;
export type PricesCsvColumn = (typeof PRICES_CSV_COLUMNS)[number];
const REQUIRED_COLUMNS: PricesCsvColumn[] = ['app', 'platform', 'product', 'territory', 'currency', 'price'];

/** Most problems listed in one error (the rest are counted) */
const MAX_LISTED_ISSUES = 50;

export interface PricesCsvRow {
  /** 1-based line of the row in the file */
  line: number;
  app: string;
  platform: 'apple' | 'google';
  product: string;
  basePlan?: string;
  offerKind?: OfferKind;
  offerKey?: string;
  territory: string;
  currency: string;
  price: Decimal;
  proceeds?: Decimal;
}

export class PricesCsvError extends Error {
  constructor(public readonly issues: string[]) {
    const listed = issues.slice(0, MAX_LISTED_ISSUES);
    const more = issues.length - listed.length;
    super(`Invalid prices CSV:\n- ${listed.join('\n- ')}${more > 0 ? `\n- and ${more} more` : ''}`);
    this.name = 'PricesCsvError';
  }
}

// ---------------------------------------------------------------------------
// Reading

/** RFC 4180 records with the line each starts on (quoted fields may span lines). Throws on an unterminated quote. */
export function parseCsvRecords(text: string): Array<{ line: number; cells: string[] }> {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let quoteLine = 0;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const endRecord = () => {
    cells.push(field);
    records.push({ line: recordLine, cells });
    cells = [];
    field = '';
  };
  while (i < input.length) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      quoteLine = line;
      i++;
    } else if (ch === ',') {
      cells.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      endRecord();
      i += ch === '\r' && input[i + 1] === '\n' ? 2 : 1;
      line++;
      recordLine = line;
    } else {
      field += ch;
      i++;
    }
  }
  if (quoted) throw new PricesCsvError([`line ${quoteLine}: a quoted field is not closed`]);
  if (field !== '' || cells.length > 0) endRecord();
  return records.filter((r) => !r.cells.every((c) => c.trim() === ''));
}

const FORMAT_LINE = /^#\s*pricingkit\.prices\s+v(\d+)\s*$/;
const APP_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;
const PLAY_ID_PATTERN = /^[A-Za-z0-9._-]{1,150}$/;

/**
 * Parse a prices CSV. Throws PricesCsvError listing every problem as
 * `line N, column "x": ...`; never a cell's contents.
 */
export function parsePricesCsv(text: string): PricesCsvRow[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) throw new PricesCsvError(['the file is empty']);
  const first = records[0];
  const firstCell = first.cells[0]?.trim() ?? '';
  const format = FORMAT_LINE.exec(firstCell);
  if (!format || first.cells.slice(1).some((c) => c.trim() !== '')) {
    throw new PricesCsvError([`line ${first.line}: the first line must be "${PRICES_CSV_HEADER_LINE}"`]);
  }
  const version = Number(format[1]);
  if (version > PRICES_CSV_VERSION) throw new PricesCsvError([`line ${first.line}: written by a newer PricingKit (${PRICES_CSV_FORMAT} v${version}); this one reads v${PRICES_CSV_VERSION}`]);
  if (version < 1) throw new PricesCsvError([`line ${first.line}: unknown version`]);
  const headerRecord = records[1];
  if (!headerRecord) throw new PricesCsvError([`line ${first.line + 1}: the column header is missing`]);

  const issues: string[] = [];
  const columns = new Map<PricesCsvColumn, number>();
  headerRecord.cells.forEach((raw, index) => {
    const name = raw.trim().toLowerCase();
    if (name === '') {
      issues.push(`line ${headerRecord.line}: column ${index + 1} has no name`);
      return;
    }
    if (!(PRICES_CSV_COLUMNS as readonly string[]).includes(name)) {
      // A name we don't know may be anything; refer to it by position only
      issues.push(`line ${headerRecord.line}: column ${index + 1} is not a ${PRICES_CSV_FORMAT} v${PRICES_CSV_VERSION} column (${PRICES_CSV_COLUMNS.join(', ')})`);
      return;
    }
    if (columns.has(name as PricesCsvColumn)) issues.push(`line ${headerRecord.line}: column "${name}" appears twice`);
    else columns.set(name as PricesCsvColumn, index);
  });
  for (const required of REQUIRED_COLUMNS) if (!columns.has(required)) issues.push(`line ${headerRecord.line}: the column "${required}" is missing`);
  if (issues.length > 0) throw new PricesCsvError(issues);

  const rows: PricesCsvRow[] = [];
  const seen = new Map<string, number>();
  for (const record of records.slice(2)) {
    const { line } = record;
    if (record.cells.length > headerRecord.cells.length && record.cells.slice(headerRecord.cells.length).some((c) => c.trim() !== '')) {
      issues.push(`line ${line}: more cells than the header has columns`);
      continue;
    }
    const cell = (name: PricesCsvColumn) => {
      const index = columns.get(name);
      return index === undefined ? '' : (record.cells[index] ?? '').trim();
    };
    const bad = (column: PricesCsvColumn, message: string) => issues.push(`line ${line}, column "${column}": ${message}`);
    const before = issues.length;

    const platform = cell('platform');
    if (platform !== 'apple' && platform !== 'google') bad('platform', 'must be apple or google');
    const app = cell('app');
    if (!APP_PATTERN.test(app)) bad('app', 'must be a bundle ID or package name (letters, digits, ".", "_", "-")');
    const product = cell('product');
    const basePlan = cell('base_plan');
    if (platform === 'apple') {
      if (!/^\d{1,20}$/.test(product)) bad('product', 'must be the numeric App Store Connect subscription ID');
      if (basePlan !== '') bad('base_plan', 'must be empty for an App Store product');
    } else if (platform === 'google') {
      if (!PLAY_ID_PATTERN.test(product)) bad('product', 'must be a Google Play product ID');
      if (basePlan !== '' && !PLAY_ID_PATTERN.test(basePlan)) bad('base_plan', 'must be a Google Play base plan ID');
    }
    const offerKind = cell('offer_kind');
    const offerKey = cell('offer_key');
    if (offerKind !== '') {
      if (!(OFFER_KINDS as readonly string[]).includes(offerKind)) bad('offer_kind', `must be empty (a base price) or one of ${OFFER_KINDS.join(', ')}`);
      else if (platform === 'apple' && !offerKind.startsWith('apple.')) bad('offer_kind', 'an App Store row takes an apple.* offer kind');
      else if (platform === 'google' && offerKind !== 'play.offer') bad('offer_kind', 'a Google Play row takes play.offer');
      else if (platform === 'google' && basePlan === '') bad('base_plan', 'a Play offer row needs its base plan');
      if (offerKey === '') bad('offer_key', 'an offer row needs the offer key');
      else if (offerKey.length > 200) bad('offer_key', 'is longer than 200 characters');
    } else if (offerKey !== '') {
      bad('offer_key', 'a base price row has no offer key (or give offer_kind)');
    }
    const territory = cell('territory');
    if (!/^[A-Z]{2}$/.test(territory)) bad('territory', 'must be ISO 3166-1 alpha-2, e.g. GB');
    const currency = cell('currency');
    if (!/^[A-Z]{3}$/.test(currency)) bad('currency', 'must be ISO 4217, e.g. EUR');
    const price = cell('price');
    if (!isDecimalString(price) || isNegativeDecimal(price)) bad('price', 'must be a plain non-negative decimal such as 4.99');
    const proceeds = cell('proceeds');
    if (proceeds !== '' && !isDecimalString(proceeds)) bad('proceeds', 'must be empty or a plain decimal');
    if (issues.length > before) continue;

    const key = [app, platform, product, basePlan, offerKind, offerKey, territory].join('\u0000');
    const firstLine = seen.get(key);
    if (firstLine !== undefined) {
      issues.push(`line ${line}: the same product${offerKind ? ' offer' : ''} and territory as line ${firstLine}`);
      continue;
    }
    seen.set(key, line);
    rows.push({
      line,
      app,
      platform: platform as 'apple' | 'google',
      product,
      ...(basePlan ? { basePlan } : {}),
      ...(offerKind ? { offerKind: offerKind as OfferKind, offerKey } : {}),
      territory,
      currency,
      price: normalizeDecimal(price),
      ...(proceeds ? { proceeds: normalizeDecimal(proceeds) } : {}),
    });
  }
  if (issues.length > 0) throw new PricesCsvError(issues);
  if (rows.length === 0) throw new PricesCsvError(['the file has no price rows']);
  return rows;
}

// ---------------------------------------------------------------------------
// Matching rows to a spec entry

function appId(app: AppRef): string {
  return 'bundleId' in app ? app.bundleId : app.packageName;
}

function appPlatform(app: AppRef): 'apple' | 'google' {
  return 'bundleId' in app ? 'apple' : 'google';
}

/** Does the row belong to this product (base price rows, or offer rows when `offer` is given)? */
export function csvRowMatches(row: PricesCsvRow, app: AppRef, product: ProductRef, offer?: { kind: OfferKind; key: string }): boolean {
  if (row.app !== appId(app) || row.platform !== appPlatform(app) || row.platform !== product.platform) return false;
  if (product.platform === 'apple') {
    if (row.product !== product.id || row.basePlan) return false;
  } else if (product.type === 'subscription') {
    if (row.product !== product.productId || row.basePlan !== product.basePlanId) return false;
  } else if (row.product !== product.productId || row.basePlan) {
    return false;
  }
  if (!offer) return row.offerKind === undefined;
  return row.offerKind === offer.kind && row.offerKey === offer.key;
}

export interface CsvPrices {
  /** territory -> price with its currency */
  prices: Record<string, { amount: Decimal; currency: string }>;
  /** territory -> the CSV line it came from (for reports) */
  lines: Record<string, number>;
}

/** The base prices of one product, from the rows that name it */
export function fixedPricesFromCsv(rows: PricesCsvRow[], app: AppRef, product: ProductRef): CsvPrices {
  const out: CsvPrices = { prices: {}, lines: {} };
  for (const row of rows) {
    if (!csvRowMatches(row, app, product)) continue;
    out.prices[row.territory] = { amount: row.price, currency: row.currency };
    out.lines[row.territory] = row.line;
  }
  return out;
}

/** One offer's prices, from the rows that name it */
export function offerPricesFromCsv(rows: PricesCsvRow[], app: AppRef, product: ProductRef, offer: { kind: OfferKind; key: string }): CsvPrices {
  const out: CsvPrices = { prices: {}, lines: {} };
  for (const row of rows) {
    if (!csvRowMatches(row, app, product, offer)) continue;
    out.prices[row.territory] = { amount: row.price, currency: row.currency };
    out.lines[row.territory] = row.line;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing

export type PricesCsvEntry = Omit<PricesCsvRow, 'line'>;

function productCells(product: ProductRef): { product: string; basePlan?: string } {
  if (product.platform === 'apple') return { product: product.id };
  return product.type === 'subscription' ? { product: product.productId, basePlan: product.basePlanId } : { product: product.productId };
}

/** Rows for a product's current base prices (territories without a current price, or unreadable, are left out) */
export function pricesCsvRowsFromState(app: AppRef, state: ProductPriceState): { rows: PricesCsvEntry[]; skipped: Array<{ territory: string; reason: string }> } {
  const rows: PricesCsvEntry[] = [];
  const skipped: Array<{ territory: string; reason: string }> = [];
  for (const territory of Object.keys(state.territories).sort()) {
    const t = state.territories[territory];
    if (t.problems?.current) {
      skipped.push({ territory, reason: `current price can't be read unambiguously: ${t.problems.current}` });
      continue;
    }
    if (!t.current) continue;
    rows.push({
      app: appId(app),
      platform: state.product.platform,
      ...productCells(state.product),
      territory,
      currency: t.current.currency,
      price: t.current.amount,
      ...(t.current.proceeds ? { proceeds: t.current.proceeds } : {}),
    });
  }
  return { rows, skipped };
}

/**
 * Rows for a product's offers. App Store offers: one row per priced
 * territory (free-trial territories as 0). Google Play offers: only offers
 * with a single phase priced in every region with a price (PricingKit's own
 * fixed-price offers); others are listed in `skipped` with the reason.
 * Offers or territories the adapter couldn't read are skipped too.
 */
export function pricesCsvRowsFromOffers(app: AppRef, product: ProductRef, offers: StoreOffer[]): { rows: PricesCsvEntry[]; skipped: Array<{ offer: string; territory?: string; reason: string }> } {
  const rows: PricesCsvEntry[] = [];
  const skipped: Array<{ offer: string; territory?: string; reason: string }> = [];
  const cells = productCells(product);
  for (const offer of [...offers].sort((a, b) => `${a.kind} ${a.key}`.localeCompare(`${b.kind} ${b.key}`))) {
    const label = `${offer.kind} ${offer.key}`;
    if (offer.problems?.length) {
      skipped.push({ offer: label, reason: `the offer couldn't be read exactly (${offer.problems.length} problems)` });
      continue;
    }
    for (const territory of Object.keys(offer.territoryProblems ?? {}).sort()) skipped.push({ offer: label, territory, reason: 'its price could not be read exactly' });
    const base = { app: appId(app), platform: product.platform, ...cells, offerKind: offer.kind, offerKey: offer.key };
    if (offer.kind === 'play.offer') {
      const phases = offer.play?.offer.phases ?? [];
      if (phases.length !== 1) {
        skipped.push({ offer: label, reason: `${phases.length} phases; only single-phase offers are exported` });
        continue;
      }
      for (const region of Object.keys(phases[0].regions).sort()) {
        const config = phases[0].regions[region];
        if (config.type !== 'price') {
          skipped.push({ offer: label, territory: region, reason: `priced as ${config.type}, not a fixed price` });
          continue;
        }
        rows.push({ ...base, territory: region, currency: config.currency, price: config.amount });
      }
      continue;
    }
    for (const territory of Object.keys(offer.prices).sort()) {
      const p = offer.prices[territory];
      rows.push({ ...base, territory, currency: p.currency, price: p.amount, ...(p.proceeds ? { proceeds: p.proceeds } : {}) });
    }
  }
  return { rows, skipped };
}

/** Serialise rows: the format line, the header, then rows sorted by app, product, offer and territory */
export function serializePricesCsv(rows: PricesCsvEntry[]): string {
  const sortKey = (r: PricesCsvEntry) => [r.platform, r.app, r.product, r.basePlan ?? '', r.offerKind ?? '', r.offerKey ?? '', r.territory].join('\u0000');
  const sorted = [...rows].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const lines = [
    PRICES_CSV_HEADER_LINE,
    PRICES_CSV_COLUMNS.join(','),
    ...sorted.map((r) =>
      [r.app, r.platform, r.product, r.basePlan ?? '', r.offerKind ?? '', r.offerKey ?? '', r.territory, r.currency, r.price, r.proceeds ?? ''].map(escapeCsvCell).join(',')
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** A Phase 0 price export (the web app's /api/export) as a prices CSV: current base prices only */
export function priceExportToPricesCsv(exp: PriceExport): string {
  return serializePricesCsv(pricesCsvRowsFromState(exp.app, stateFromPriceExport(exp)).rows);
}
