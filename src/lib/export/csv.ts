// CSV serialization for PriceExport: one row per territory (RFC 4180).

import type { PriceExport } from './types';

export const PRICE_EXPORT_CSV_COLUMNS = [
  'schema_version',
  'exported_at',
  'platform',
  'app_id',
  'product_type',
  'product_id',
  'base_plan_id',
  'territory',
  'currency',
  'amount',
  'proceeds',
  'availability',
  'scheduled_amount',
  'scheduled_start_date',
  'scheduled_proceeds',
] as const;

// Separator for multiple scheduled prices inside one cell
const MULTI_VALUE_SEPARATOR = '|';

/**
 * Escape a single CSV cell. Quotes cells containing delimiters, quotes or
 * line breaks, and neutralizes spreadsheet formula injection by prefixing
 * cells that start with =, +, @, tab, CR, LF, their full-width forms
 * (＝ ＋ ＠ －, which some spreadsheets treat the same), or "-" (unless a
 * plain number).
 */
export function escapeCsvCell(value: string): string {
  let cell = value;
  if (/^[=+@\t\r\n\uFF1D\uFF0B\uFF20\uFF0D]/.test(cell) || (cell.startsWith('-') && !/^-\d+(\.\d+)?$/.test(cell))) {
    cell = `'${cell}`;
  }
  if (/[",\r\n]/.test(cell) || cell !== cell.trim()) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function priceExportToCsv(data: PriceExport): string {
  const appId = 'packageName' in data.app ? data.app.packageName : data.app.bundleId;

  const rows = data.prices.map((price) => {
    const scheduled = price.scheduled ?? [];
    return [
      String(data.schemaVersion),
      data.exportedAt,
      data.platform,
      appId,
      data.product.type,
      data.product.id,
      data.product.basePlanId ?? '',
      price.territory,
      price.currency,
      price.amount ?? '',
      price.proceeds ?? '',
      price.availability ?? '',
      scheduled.map((s) => s.amount).join(MULTI_VALUE_SEPARATOR),
      scheduled.map((s) => s.startDate).join(MULTI_VALUE_SEPARATOR),
      scheduled.map((s) => s.proceeds ?? '').join(MULTI_VALUE_SEPARATOR),
    ];
  });

  return [PRICE_EXPORT_CSV_COLUMNS as readonly string[], ...rows]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\r\n') + '\r\n';
}

export function priceExportToJson(data: PriceExport): string {
  return JSON.stringify(data, null, 2) + '\n';
}

/** Build a filesystem-safe download filename for an export. */
export function buildExportFilename(data: PriceExport, format: 'json' | 'csv'): string {
  const timestamp = data.exportedAt.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const parts = ['prices', data.platform, data.product.type, data.product.id];
  if (data.product.basePlanId) parts.push(data.product.basePlanId);
  parts.push(timestamp);
  const base = parts.join('-').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${base}.${format}`;
}
