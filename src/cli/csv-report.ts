// After planning a spec whose fixed prices came from a prices CSV: which rows
// became exactly the price planned, which were snapped to a different valid
// price, and which weren't imported at all (and why). Rows that don't snap
// exactly become plan warnings, so `diff` shows them too. An offer row whose
// currency differs from the territory's is refused before a plan is written.

import {
  basePriceOps,
  compareDecimal,
  isOfferOp,
  isPlayOfferOp,
  productKey,
  type ChangeSet,
  type ProductPriceState,
} from '@/lib/pricing';
import type { CsvImport } from './spec-file';
import { CliError } from './errors';

export interface CsvRowOutcome {
  file: string;
  line: number;
  territory: string;
  product: string;
  offer?: string;
  status: 'exact' | 'snapped' | 'notImported';
  csv: { amount: string; currency: string };
  planned?: { amount: string; currency: string };
  reason?: string;
}

const same = (a: { amount: string; currency: string }, b: { amount: string; currency: string }) => a.currency === b.currency && compareDecimal(a.amount, b.amount) === 0;

/** What became of every imported row. Throws CliError (CSV_CURRENCY_MISMATCH) for an offer row in the wrong currency. */
export function csvImportOutcomes(imports: CsvImport[], changeSet: ChangeSet, states: ProductPriceState[] = []): CsvRowOutcome[] {
  const out: CsvRowOutcome[] = [];
  const mismatches: string[] = [];
  const baseOps = basePriceOps(changeSet);
  const offerOps = changeSet.ops.filter(isOfferOp);
  for (const imp of imports) {
    const key = productKey(imp.product);
    const state = states.find((s) => productKey(s.product) === key);
    for (const territory of Object.keys(imp.rows).sort()) {
      const row = imp.rows[territory];
      const csv = { amount: row.amount, currency: row.currency };
      const base = { file: imp.file, line: row.line, territory, product: key, ...(imp.offer ? { offer: `${imp.offer.kind} ${imp.offer.key}` } : {}), csv };
      const skip = (changeSet.skipped ?? []).find(
        (s) => productKey(s.product) === key && s.territory === territory && (imp.offer ? s.offerKey === imp.offer.key : s.offerKey === undefined)
      );
      if (!imp.offer) {
        const op = baseOps.find((o) => productKey(o.target.product) === key && o.target.territory === territory);
        if (op?.after) {
          const planned = { amount: op.after.amount, currency: op.after.currency };
          out.push({ ...base, status: same(csv, planned) ? 'exact' : 'snapped', planned });
        } else if (skip?.reason === 'ALREADY_AT_TARGET') {
          const current = state?.territories[territory]?.current;
          const planned = current ? { amount: current.amount, currency: current.currency } : undefined;
          out.push({ ...base, status: planned && same(csv, planned) ? 'exact' : 'snapped', ...(planned ? { planned } : {}) });
        } else {
          out.push({ ...base, status: 'notImported', reason: skip ? `${skip.reason}${skip.detail ? `: ${skip.detail}` : ''}` : 'not planned' });
        }
        continue;
      }
      const op = offerOps.find((o) => productKey(o.target.product) === key && o.target.offer.kind === imp.offer!.kind && o.target.offer.key === imp.offer!.key);
      let planned: { amount: string; currency: string } | undefined;
      if (op?.after) {
        if (isPlayOfferOp(op)) {
          const config = op.after.phases[0]?.regions[territory];
          if (config && (config.type === 'price' || config.type === 'absoluteDiscount')) planned = { amount: config.amount, currency: config.currency };
        } else {
          const price = op.after.prices[territory];
          if (price) planned = { amount: price.amount, currency: price.currency };
        }
      }
      if (planned && planned.currency !== csv.currency) {
        mismatches.push(`${imp.file} line ${row.line}, column "currency": not the currency the territory is priced in`);
        continue;
      }
      if (skip) out.push({ ...base, status: 'notImported', reason: `${skip.reason}${skip.detail ? `: ${skip.detail}` : ''}` });
      else if (planned) out.push({ ...base, status: same(csv, planned) ? 'exact' : 'snapped', planned });
      // No op and no skip: the offer already has this price
      else out.push({ ...base, status: 'exact' });
    }
  }
  if (mismatches.length > 0) {
    throw new CliError(`Offer prices from a CSV are in the wrong currency; no plan was written:\n  ${mismatches.join('\n  ')}`, 'CSV_CURRENCY_MISMATCH');
  }
  return out;
}

/** Plan warnings for the rows that didn't become exactly the planned price */
export function csvImportWarnings(outcomes: CsvRowOutcome[], changeSet: ChangeSet): Array<{ opId: string; message: string }> {
  const warnings: Array<{ opId: string; message: string }> = [];
  for (const o of outcomes) {
    if (o.status === 'exact') continue;
    const op = changeSet.ops.find((x) => productKey(x.target.product) === o.product && (isOfferOp(x) ? `${x.target.offer.kind} ${x.target.offer.key}` === o.offer : !o.offer && x.target.territory === o.territory));
    const message =
      o.status === 'snapped'
        ? `CSV ${o.file} line ${o.line} (${o.territory}): ${o.csv.amount} ${o.csv.currency} is not a valid store price; planned as ${o.planned ? `${o.planned.amount} ${o.planned.currency}` : 'the current price'}`
        : `CSV ${o.file} line ${o.line} (${o.territory}): not imported (${o.reason})`;
    warnings.push({ opId: op?.id ?? '-', message });
  }
  return warnings;
}

/** Add the CSV warnings to a plan (planner notes: not covered by its hash) */
export function withCsvWarnings(changeSet: ChangeSet, outcomes: CsvRowOutcome[]): ChangeSet {
  const extra = csvImportWarnings(outcomes, changeSet);
  if (extra.length === 0) return changeSet;
  return { ...changeSet, warnings: [...(changeSet.warnings ?? []), ...extra] };
}

export function formatCsvOutcomes(outcomes: CsvRowOutcome[]): string[] {
  if (outcomes.length === 0) return [];
  const exact = outcomes.filter((o) => o.status === 'exact').length;
  const snapped = outcomes.filter((o) => o.status === 'snapped');
  const missing = outcomes.filter((o) => o.status === 'notImported');
  return [
    '',
    `CSV import: ${outcomes.length} rows, ${exact} exact, ${snapped.length} snapped to another price, ${missing.length} not imported`,
    ...snapped.map((o) => `  line ${o.line} (${o.territory}${o.offer ? `, ${o.offer}` : ''}): ${o.csv.amount} ${o.csv.currency} -> ${o.planned ? `${o.planned.amount} ${o.planned.currency}` : 'current price'}`),
    ...missing.map((o) => `  line ${o.line} (${o.territory}${o.offer ? `, ${o.offer}` : ''}): not imported, ${o.reason}`),
  ];
}
