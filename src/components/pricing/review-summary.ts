/**
 * Pure helpers behind ReviewDialog: counting a set of price changes, the
 * percentage shown per row, and the plan file offered for download.
 */

export interface ReviewChange {
  /** Stable key, usually the region or territory code. */
  id: string;
  /** What changes, e.g. the country name. */
  label: string;
  /** Formatted prices, as shown. */
  before: string;
  after: string;
  /** Numeric prices in the same currency, when known; used for counts and %. */
  beforeAmount?: number | null;
  afterAmount?: number | null;
  /** A short tag such as "Base region". */
  note?: string;
}

export interface ReviewCounts {
  decreases: number;
  increases: number;
  /** New prices where there was none before. */
  added: number;
  /** Same price, or not comparable (no numbers). */
  other: number;
}

function hasAmount(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function countChanges(changes: readonly ReviewChange[]): ReviewCounts {
  const counts: ReviewCounts = { decreases: 0, increases: 0, added: 0, other: 0 };
  for (const c of changes) {
    if (!hasAmount(c.afterAmount)) counts.other++;
    else if (!hasAmount(c.beforeAmount)) counts.added++;
    else if (c.afterAmount < c.beforeAmount) counts.decreases++;
    else if (c.afterAmount > c.beforeAmount) counts.increases++;
    else counts.other++;
  }
  return counts;
}

/** "-11.11%", "+5.00%", "0.00%", "New" or "" when it cannot be worked out. */
export function changePercent(change: ReviewChange): string {
  const { beforeAmount: b, afterAmount: a } = change;
  if (!hasAmount(a)) return '';
  if (!hasAmount(b)) return 'New';
  if (b === 0) return a === 0 ? '0.00%' : '';
  const pct = ((a - b) / b) * 100;
  const rounded = Math.round(pct * 100) / 100;
  if (rounded === 0) return '0.00%';
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`;
}

/** A whole cell that is just a number (optionally signed, a percentage): a spreadsheet can't run it */
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?%?$/;

/** Quotes every cell, and neutralises any that a spreadsheet could read as a formula */
export function csvCell(value: string): string {
  // = + - @ start a formula; a leading tab or CR can hide one. Only a cell that
  // is entirely a plain number (e.g. "-1", "+5.00%") keeps its sign as is:
  // "-1+HYPERLINK(...)" starts like a number but is a formula.
  const safe = /^[=+\-@\t\r]/.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** The changes as CSV: one row per change, with a header. */
export function planCsv(changes: readonly ReviewChange[]): string {
  const rows = [['id', 'label', 'before', 'after', 'change', 'note']];
  for (const c of changes) rows.push([c.id, c.label, c.before, c.after, changePercent(c), c.note ?? '']);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** A file name such as "pricing-plan-com.example.app.annual-2026-10-27.csv". */
export function planFileName(subject: string, date = new Date()): string {
  const slug = subject.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'changes';
  return `pricing-plan-${slug}-${date.toISOString().slice(0, 10)}.csv`;
}
