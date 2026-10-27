// Plain-text output helpers: aligned columns, no colours, no dependencies.

import { compareDecimal, divideDecimal, isZeroDecimal, subtractDecimal, type Decimal, type PriceValue } from '@/lib/pricing';

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
