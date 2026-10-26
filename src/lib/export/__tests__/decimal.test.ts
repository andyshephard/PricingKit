import { describe, it, expect } from 'vitest';
import { moneyToDecimal, normalizeDecimal, InvalidAmountError } from '../decimal';

describe('normalizeDecimal', () => {
  it.each([
    ['4.99', '4.99'],
    ['004.990', '4.99'],
    ['100.0', '100'],
    ['100', '100'],
    ['0.00', '0'],
    ['-0.0', '0'],
    ['0.1', '0.1'],
    ['12345678901234567890.123456789', '12345678901234567890.123456789'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDecimal(input)).toBe(expected);
  });

  it.each(['', '1e3', '1,99', ' 1.99', '1.', '.99', 'NaN', 'abc'])(
    'rejects %j',
    (input) => {
      expect(() => normalizeDecimal(input)).toThrow(InvalidAmountError);
    }
  );

  it('rejects non-string input', () => {
    expect(() => normalizeDecimal(4.99 as unknown as string)).toThrow(InvalidAmountError);
  });
});

describe('moneyToDecimal', () => {
  it.each<[string | undefined, number | undefined, string]>([
    ['4', 990000000, '4.99'],
    ['0', 990000000, '0.99'],
    ['100', undefined, '100'],
    ['100', 0, '100'],
    ['0', 10000000, '0.01'],
    ['0', 1, '0.000000001'],
    [undefined, undefined, '0'],
    ['1500', 0, '1500'],
    // 0.1 + 0.2 style values must stay exact
    ['0', 300000000, '0.3'],
    ['-1', -500000000, '-1.5'],
    ['0', -500000000, '-0.5'],
  ])('units=%s nanos=%s -> %s', (units, nanos, expected) => {
    expect(moneyToDecimal(units, nanos)).toBe(expected);
  });

  it('never returns a number', () => {
    expect(typeof moneyToDecimal('4', 990000000)).toBe('string');
  });

  it('rejects mixed signs', () => {
    expect(() => moneyToDecimal('1', -500000000)).toThrow(InvalidAmountError);
  });

  it('rejects out-of-range or fractional nanos', () => {
    expect(() => moneyToDecimal('1', 1000000000)).toThrow(InvalidAmountError);
    expect(() => moneyToDecimal('1', 0.5)).toThrow(InvalidAmountError);
  });

  it('rejects non-integer units', () => {
    expect(() => moneyToDecimal('1.5', 0)).toThrow(InvalidAmountError);
  });
});
