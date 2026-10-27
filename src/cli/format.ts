// Plain-text output helpers: aligned columns, no colours, no dependencies.

import { compareDecimal, divideDecimal, isZeroDecimal, subtractDecimal, type Decimal, type PriceValue } from '@/lib/pricing';

// Text a plan, a store or a file supplies (warnings, notes, offer keys, error
// messages) is printed as data, never as terminal control: an escape sequence
// in a plan could otherwise clear the screen or rewrite lines, so "diff"
// would show something other than what the hash confirms.
//
// Escaped, as visible \xNN / \uNNNN: C0 controls except newline and tab
// (ESC starts every ANSI CSI and OSC sequence; a CR not followed by a newline
// rewrites a line, while CRLF, as in CSV output, is left alone), DEL, the
// C1 controls (U+009B is a one-byte CSI, U+009D an OSC), and the Unicode
// line separators and bidirectional overrides that reorder what is shown.
const TERMINAL_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]|\r(?!\n)/g;

export function escapeTerminal(text: string): string {
  return text.replace(TERMINAL_UNSAFE, (c) => {
    const code = c.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).toUpperCase().padStart(2, '0')}` : `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

// JSON.stringify escapes C0 controls but leaves DEL, C1 and the Unicode
// separators/overrides raw; inside a JSON string \uNNNN is equivalent.
const JSON_UNSAFE = /[\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** JSON text with every terminal-unsafe character as a \uNNNN escape (same JSON value) */
export function escapeJsonForTerminal(json: string): string {
  return json.replace(JSON_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Align rows into columns separated by two spaces. */
export function table(rows: string[][], indent = '  '): string {
  if (rows.length === 0) return '';
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows
    .map((row) => indent + row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd())
    .join('\n');
}

export function money(value: { amount: Decimal; currency: string } | null | undefined): string {
  return value ? `${value.amount} ${value.currency}` : '-';
}

export function priceCell(value: PriceValue | null | undefined): string {
  if (!value) return '-';
  return value.startDate ? `${money(value)} from ${value.startDate}` : money(value);
}

/** "+10.02%" / "-5.00%" / "+8.00%" (always two decimals) for after vs before in the same currency; undefined otherwise */
export function percentChange(before: PriceValue | null | undefined, after: PriceValue | null | undefined): string | undefined {
  if (!before || !after || before.currency !== after.currency || isZeroDecimal(before.amount)) return undefined;
  const ratio = divideDecimal(subtractDecimal(after.amount, before.amount), before.amount, 6);
  const pct = fixed2(divideDecimal(ratio, '0.01', 2));
  return compareDecimal(pct, '0') > 0 ? `+${pct}%` : `${pct}%`;
}

/** A Decimal with exactly two fraction digits: "8" -> "8.00", "-0.5" -> "-0.50" */
export function fixed2(value: Decimal): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

export function describeCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
}
