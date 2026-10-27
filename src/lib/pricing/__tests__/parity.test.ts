import { describe, it, expect } from 'vitest';
import {
  buildParityReport,
  compareParity,
  parityMappingReport,
  plannedParityMappingReport,
  type BasePriceOp,
  type ParityMapping,
  type ProductPriceState,
  type ProductRef,
} from '..';

const mapping: ParityMapping = {
  id: 'annual',
  apple: { bundleId: 'com.example.app', subscription: '9700000001' },
  play: { packageName: 'com.example.app', subscription: 'com.example.pro', basePlan: 'annual' },
};
const appleSub: ProductRef = { platform: 'apple', type: 'subscription', id: '9700000001' };
const playPlan: ProductRef = { platform: 'google', type: 'subscription', productId: 'com.example.pro', basePlanId: 'annual' };

function state(product: ProductRef, prices: Record<string, [string, string] | null>, problems: Record<string, string> = {}): ProductPriceState {
  return {
    product,
    capturedAt: '2030-01-01T00:00:00Z',
    territories: Object.fromEntries(
      Object.entries(prices).map(([t, p]) => [
        t,
        { territory: t, currency: p?.[1] ?? 'USD', current: p ? { currency: p[1], amount: p[0] } : null, ...(problems[t] ? { problems: { current: problems[t] } } : {}) },
      ])
    ),
  };
}

describe('compareParity', () => {
  it('classifies one territory: same, within the threshold, gap, not comparable, one store only', () => {
    const usd = (amount: string) => ({ amount, currency: 'USD' });
    expect(compareParity('US', usd('49.99'), usd('49.99'), '0.05')).toMatchObject({ status: 'same', difference: '0', ratio: '0' });
    // 2.00 / 49.99 = 4.0%
    expect(compareParity('US', usd('49.99'), usd('51.99'), '0.05')).toMatchObject({ status: 'withinThreshold', difference: '2', ratio: '0.04' });
    // Measured against the lower price, whichever store has it: 5 / 45 = 11.1%
    expect(compareParity('US', usd('50'), usd('45'), '0.05')).toMatchObject({ status: 'gap', difference: '-5', ratio: '0.1111' });
    // Exactly at the threshold is still within it
    expect(compareParity('US', usd('100'), usd('105'), '0.05').status).toBe('withinThreshold');
    expect(compareParity('GB', { amount: '44.99', currency: 'GBP' }, usd('49.99'), '0.05')).toMatchObject({ status: 'notComparable', reason: expect.stringMatching(/GBP.*USD/) });
    expect(compareParity('US', usd('1'), undefined, '0.05').status).toBe('appleOnly');
    expect(compareParity('US', undefined, usd('1'), '0.05').status).toBe('playOnly');
    expect(compareParity('US', usd('0'), usd('1'), '0.05')).toMatchObject({ status: 'gap', ratio: '1' });
  });

  it('compares the threshold exactly; the ratio is rounded for display only', () => {
    // 5.004 / 100 = 0.05004: above 0.05, although the displayed ratio rounds to 0.05
    const row = compareParity('US', { amount: '100', currency: 'USD' }, { amount: '105.004', currency: 'USD' }, '0.05');
    expect(row).toMatchObject({ status: 'gap', ratio: '0.05' });
    expect(compareParity('US', { amount: '100', currency: 'USD' }, { amount: '105.00', currency: 'USD' }, '0.05').status).toBe('withinThreshold');
  });
});

describe('parity outcome', () => {
  it('is NOT CHECKED when something could not be compared or nothing was, never in parity; a gap wins', () => {
    const report = (apple: Record<string, [string, string] | null>, play: Record<string, [string, string] | null>, problems: Record<string, string> = {}) =>
      parityMappingReport(mapping, state(appleSub, apple, problems), state(playPlan, play));
    expect(report({ US: ['1', 'USD'] }, { US: ['1', 'USD'] }).status).toBe('inParity');
    expect(report({ US: ['1', 'USD'], GB: ['1', 'GBP'] }, { US: ['1', 'USD'], GB: ['1', 'EUR'] })).toMatchObject({ status: 'notChecked', inParity: false });
    expect(report({ US: ['1', 'USD'], JP: ['1', 'JPY'] }, { US: ['1', 'USD'], JP: ['1', 'JPY'] }, { JP: 'two prices' }).status).toBe('notChecked');
    // Priced on one store only, nothing to compare
    expect(report({ US: ['1', 'USD'] }, { GB: ['1', 'GBP'] })).toMatchObject({ status: 'notChecked', inParity: false });
    expect(report({}, {}).status).toBe('notChecked');
    // A gap is reported as such even when something else couldn't be compared
    expect(report({ US: ['1', 'USD'], GB: ['1', 'GBP'] }, { US: ['2', 'USD'], GB: ['1', 'EUR'] }).status).toBe('gaps');
    const all = buildParityReport([report({ US: ['1', 'USD'] }, { US: ['1', 'USD'] }), report({ US: ['1', 'USD'] }, { GB: ['1', 'GBP'] })], 'current', 'x');
    expect(all).toMatchObject({ status: 'notChecked', inParity: false });
    expect(buildParityReport([], 'current', 'x').status).toBe('notChecked');
  });
});

describe('parityMappingReport', () => {
  const apple = state(appleSub, { US: ['49.99', 'USD'], GB: ['44.99', 'GBP'], DE: ['49.99', 'EUR'], JP: ['7800', 'JPY'], FR: null }, { JP: 'two prices' });
  const play = state(playPlan, { US: ['49.99', 'USD'], GB: ['49.99', 'GBP'], DE: ['51.99', 'EUR'], IN: ['999', 'INR'] });

  it('compares every territory either store prices, per territory', () => {
    const report = parityMappingReport(mapping, apple, play);
    expect(report.rows.map((r) => [r.territory, r.status])).toEqual([
      ['DE', 'withinThreshold'],
      ['GB', 'gap'],
      ['IN', 'playOnly'],
      ['JP', 'unreadable'],
      ['US', 'same'],
    ]);
    expect(report).toMatchObject({ inParity: false, threshold: '0.05', apple: appleSub, play: playPlan, appleApp: { bundleId: 'com.example.app' } });
    expect(report.summary).toEqual({ same: 1, withinThreshold: 1, gap: 1, notComparable: 0, appleOnly: 0, playOnly: 1, unreadable: 1 });
  });

  it('takes the mapping threshold and territory list', () => {
    const report = parityMappingReport({ ...mapping, threshold: '0.12', territories: ['GB', 'US', 'FR'] }, apple, play);
    expect(report.rows.map((r) => [r.territory, r.status])).toEqual([
      ['GB', 'withinThreshold'],
      ['US', 'same'],
    ]);
    expect(report.notPriced).toEqual(['FR']);
    expect(report.inParity).toBe(true);
  });

  it('reports on planned prices: each side with its own setPrice ops applied', () => {
    const op = (product: ProductRef, territory: string, amount: string, currency: string): BasePriceOp => ({
      id: 'op-0001',
      kind: 'setPrice',
      platform: product.platform,
      target: { product, territory },
      before: null,
      after: { currency, amount },
      idempotencyKey: 'k',
    });
    const planned = plannedParityMappingReport(mapping, apple, [op(appleSub, 'GB', '49.99', 'GBP')], play, [op(playPlan, 'DE', '49.99', 'EUR'), op(appleSub, 'US', '1', 'USD')]);
    expect(planned.rows.filter((r) => ['GB', 'DE', 'US'].includes(r.territory)).map((r) => [r.territory, r.status])).toEqual([
      ['DE', 'same'],
      ['GB', 'same'],
      ['US', 'same'],
    ]);
    const report = buildParityReport([planned], 'plan', '2030-01-01T00:00:00Z');
    // JP is unreadable on the App Store: no gap, but not checked either
    expect(report).toMatchObject({ kind: 'pricingkit.parity', schemaVersion: 1, basis: 'plan', status: 'notChecked', inParity: false });
    const clean = plannedParityMappingReport({ ...mapping, territories: ['DE', 'GB', 'US'] }, apple, [op(appleSub, 'GB', '49.99', 'GBP')], play, [op(playPlan, 'DE', '49.99', 'EUR')]);
    expect(buildParityReport([clean], 'plan', 'x')).toMatchObject({ status: 'inParity', inParity: true });
  });
});
