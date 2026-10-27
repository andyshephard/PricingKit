import { describe, expect, it } from 'vitest';
import { changePercent, countChanges, csvCell, planCsv, planFileName, type ReviewChange } from '../review-summary';

const change = (id: string, before: number | null, after: number | null, extra: Partial<ReviewChange> = {}): ReviewChange => ({
  id,
  label: id,
  before: before === null ? 'None' : String(before),
  after: after === null ? '' : String(after),
  beforeAmount: before,
  afterAmount: after,
  ...extra,
});

describe('countChanges', () => {
  it('counts decreases, increases, new prices and the rest', () => {
    const counts = countChanges([
      change('GB', 44.99, 39.99),
      change('DE', 49.99, 42.99),
      change('CH', 49.99, 54),
      change('BR', null, 139.9),
      change('US', 49.99, 49.99),
      { id: 'XX', label: 'XX', before: 'a', after: 'b' },
    ]);
    expect(counts).toEqual({ decreases: 2, increases: 1, added: 1, other: 2 });
  });
});

describe('changePercent', () => {
  it('formats the change to two decimals with a sign', () => {
    expect(changePercent(change('GB', 44.99, 39.99))).toBe('-11.11%');
    expect(changePercent(change('IN', 4499, 1799))).toBe('-60.01%');
    expect(changePercent(change('CH', 50, 52.5))).toBe('+5.00%');
    expect(changePercent(change('US', 9.99, 9.99))).toBe('0.00%');
  });

  it('marks new prices and leaves unknowns blank', () => {
    expect(changePercent(change('BR', null, 10))).toBe('New');
    expect(changePercent({ id: 'X', label: 'X', before: '', after: '' })).toBe('');
    expect(changePercent(change('Z', 0, 1))).toBe('');
  });
});

describe('planCsv', () => {
  it('writes a quoted header and one row per change', () => {
    const csv = planCsv([change('GB', 44.99, 39.99, { label: 'United Kingdom', before: '£44.99', after: '£39.99' })]);
    expect(csv).toBe(
      '"id","label","before","after","change","note"\n"GB","United Kingdom","£44.99","£39.99","-11.11%",""\n'
    );
  });

  it('neutralises spreadsheet formulas but keeps signed numbers', () => {
    const csv = planCsv([{ id: '=HYPERLINK("x")', label: '@cmd', before: '-1', after: '+2', note: 'a"b' }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")","'@cmd","-1","+2"`);
    expect(csv).toContain('"a""b"');
  });

  it('neutralises a cell that only starts like a number', () => {
    expect(csvCell('-1+HYPERLINK("http://example.invalid","x")')).toBe(`"'-1+HYPERLINK(""http://example.invalid"",""x"")"`);
    expect(csvCell('+1-2')).toBe(`"'+1-2"`);
    expect(csvCell('\t=1+1')).toBe(`"'\t=1+1"`);
    expect(csvCell('\r-5')).toBe(`"'\r-5"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    // Plain numbers and percentages keep their sign
    expect(csvCell('-1')).toBe('"-1"');
    expect(csvCell('+12.50')).toBe('"+12.50"');
    expect(csvCell('-11.11%')).toBe('"-11.11%"');
    expect(csvCell('9.99 USD')).toBe('"9.99 USD"');
  });
});

describe('planFileName', () => {
  it('slugs the subject and dates the file', () => {
    expect(planFileName('com.example.app / Annual', new Date('2026-10-27T12:00:00Z'))).toBe(
      'pricing-plan-com.example.app-Annual-2026-10-27.csv'
    );
    expect(planFileName('  ', new Date('2026-01-02T00:00:00Z'))).toBe('pricing-plan-changes-2026-01-02.csv');
  });
});
