// Custom strategy multiplier tables from CSV.
//
// The CSV has a header row naming a "territory" column and a "multiplier"
// column; other columns are ignored. So a price export
// (pricingkit export / the web app's CSV, see src/lib/export/csv.ts) with a
// "multiplier" column added works as it is: rows with an empty multiplier
// are skipped. RFC 4180 quoting is understood. Errors give line numbers and
// column names only, never cell contents.
// Framework-free: no file access (the CLI reads the file).

import { isDecimalString, normalizeDecimal, type Decimal } from './decimal';

export class MultiplierCsvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid multiplier CSV:\n- ${issues.join('\n- ')}`);
    this.name = 'MultiplierCsvError';
  }
}

/** RFC 4180 rows (quoted fields, "" escapes, CRLF or LF). Throws on an unterminated quote. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && input[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (quoted) throw new MultiplierCsvError(['a quoted field is not closed']);
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** CSV text -> { territory: multiplier }. Throws MultiplierCsvError listing every problem by line. */
export function parseMultiplierCsv(text: string): Record<string, Decimal> {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new MultiplierCsvError(['the file is empty']);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const territoryCol = header.indexOf('territory');
  const multiplierCol = header.indexOf('multiplier');
  const issues: string[] = [];
  if (territoryCol < 0) issues.push('the header has no "territory" column');
  if (multiplierCol < 0) issues.push('the header has no "multiplier" column');
  if (issues.length > 0) throw new MultiplierCsvError(issues);
  const out: Record<string, Decimal> = {};
  rows.slice(1).forEach((row, index) => {
    const line = index + 2;
    const territory = (row[territoryCol] ?? '').trim();
    const multiplier = (row[multiplierCol] ?? '').trim();
    if (multiplier === '') return; // e.g. an export row left without a multiplier
    if (!/^[A-Z]{2}$/.test(territory)) {
      issues.push(`line ${line}: territory must be ISO 3166-1 alpha-2, e.g. "GB"`);
      return;
    }
    if (!isDecimalString(multiplier)) {
      issues.push(`line ${line}: multiplier for ${territory} must be a plain decimal such as 0.8`);
      return;
    }
    if (territory in out) {
      issues.push(`line ${line}: ${territory} is listed twice`);
      return;
    }
    out[territory] = normalizeDecimal(multiplier);
  });
  if (issues.length === 0 && Object.keys(out).length === 0) issues.push('no row has a multiplier');
  if (issues.length > 0) throw new MultiplierCsvError(issues);
  return out;
}
