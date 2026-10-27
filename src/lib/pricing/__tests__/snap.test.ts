import { describe, it, expect } from 'vitest';
import { deviationRatio, snapToPricePoints } from '../snap';

const ladder = [
  { id: 'p1', customerPrice: '0.99' },
  { id: 'p2', customerPrice: '1.99' },
  { id: 'p3', customerPrice: '2.49' },
  { id: 'p4', customerPrice: '2.99' },
];

describe('snapToPricePoints', () => {
  it('snaps to the nearest point', () => {
    const result = snapToPricePoints('2.40', ladder);
    expect(result?.point.id).toBe('p3');
    expect(result?.deviation).toBe('0.09');
    expect(result?.deviationRatio).toBe('0.0375');
  });

  it('breaks a tie toward the lower price', () => {
    // 2.74 is exactly between 2.49 and 2.99: the lower price wins, in any order
    expect(snapToPricePoints('2.74', ladder)?.point.id).toBe('p3');
    expect(snapToPricePoints('2.74', [ladder[3], ladder[2]])?.point.id).toBe('p3');
    expect(snapToPricePoints('2.75', ladder)?.point.id).toBe('p4');
    expect(snapToPricePoints('2.24', [ladder[2], ladder[1]])?.point.id).toBe('p2');
  });

  it('supports floor and ceil', () => {
    expect(snapToPricePoints('2.48', ladder, 'floor')?.point.id).toBe('p2');
    expect(snapToPricePoints('2.00', ladder, 'ceil')?.point.id).toBe('p3');
    expect(snapToPricePoints('0.50', ladder, 'floor')).toBeUndefined();
    expect(snapToPricePoints('5', ladder, 'ceil')).toBeUndefined();
  });

  it('matches an exact point and handles an empty ladder', () => {
    expect(snapToPricePoints('1.99', ladder)?.deviation).toBe('0');
    expect(snapToPricePoints('1', [])).toBeUndefined();
  });

  it('compares amounts exactly even when floats would not', () => {
    // 0.1 + 0.2 != 0.3 in floats; decimals compare exactly
    const points = [{ customerPrice: '0.3' }, { customerPrice: '0.31' }];
    expect(snapToPricePoints('0.3', points)?.deviation).toBe('0');
  });

  it('computes deviation ratios', () => {
    expect(deviationRatio('100', '95')).toBe('0.05');
    expect(deviationRatio('0', '1')).toBe('0');
  });
});
