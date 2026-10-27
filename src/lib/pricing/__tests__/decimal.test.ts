import { describe, it, expect } from 'vitest';
import {
  addDecimal,
  compareDecimal,
  decimalEquals,
  decimalFromNumber,
  decimalToMoney,
  divideDecimal,
  InvalidAmountError,
  moneyToDecimal,
  multiplyDecimal,
  normalizeDecimal,
  roundDecimal,
  subtractDecimal,
} from '../decimal';
import { currencyScale } from '../rounding';

describe('Decimal arithmetic', () => {
  it('adds and subtracts without float drift', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(subtractDecimal('12.99', '0.99')).toBe('12');
    expect(subtractDecimal('1', '1.5')).toBe('-0.5');
    expect(addDecimal('-0.5', '0.5')).toBe('0');
  });

  it('multiplies exactly', () => {
    expect(multiplyDecimal('19.99', '0.5')).toBe('9.995');
    expect(multiplyDecimal('3', '-1.25')).toBe('-3.75');
  });

  it('compares across scales', () => {
    expect(compareDecimal('4.9', '4.90')).toBe(0);
    expect(compareDecimal('4.89', '4.9')).toBe(-1);
    expect(compareDecimal('-1', '-2')).toBe(1);
    expect(decimalEquals('100.0', '100')).toBe(true);
  });

  it('rounds with each mode', () => {
    expect(roundDecimal('9.995', 2, 'half-up')).toBe('10');
    expect(roundDecimal('2.345', 2, 'half-even')).toBe('2.34');
    expect(roundDecimal('2.355', 2, 'half-even')).toBe('2.36');
    expect(roundDecimal('2.349', 2, 'floor')).toBe('2.34');
    expect(roundDecimal('-2.341', 2, 'floor')).toBe('-2.35');
    expect(roundDecimal('2.341', 2, 'ceil')).toBe('2.35');
    expect(roundDecimal('-2.349', 2, 'down')).toBe('-2.34');
    expect(roundDecimal('1234.5', 0, 'half-up')).toBe('1235');
    expect(roundDecimal('1.5', 2)).toBe('1.5');
  });

  it('divides to a scale', () => {
    expect(divideDecimal('10', '3', 4)).toBe('3.3333');
    expect(divideDecimal('2', '3', 2)).toBe('0.67');
    expect(divideDecimal('1', '-4', 2)).toBe('-0.25');
    expect(() => divideDecimal('1', '0', 2)).toThrow(RangeError);
  });

  it('converts to and from store Money without floats', () => {
    expect(moneyToDecimal('4', 990000000)).toBe('4.99');
    expect(decimalToMoney('4.99')).toEqual({ units: '4', nanos: 990000000 });
    expect(decimalToMoney('1200')).toEqual({ units: '1200' });
    expect(decimalToMoney('0.000000001')).toEqual({ units: '0', nanos: 1 });
    expect(() => decimalToMoney('0.0000000001')).toThrow(InvalidAmountError);
  });

  it('round-trips Money for every cent value', () => {
    for (let cents = 0; cents < 100; cents++) {
      const value = `7.${String(cents).padStart(2, '0')}`;
      const money = decimalToMoney(normalizeDecimal(value));
      expect(moneyToDecimal(money.units, money.nanos)).toBe(normalizeDecimal(value));
    }
  });

  it('crosses the float boundary only through decimalFromNumber', () => {
    expect(decimalFromNumber(4.99, 2)).toBe('4.99');
    expect(decimalFromNumber(0.1 + 0.2, 2)).toBe('0.3');
    expect(decimalFromNumber(-0.001, 2)).toBe('0');
    expect(() => decimalFromNumber(NaN, 2)).toThrow(InvalidAmountError);
    expect(() => decimalFromNumber(Infinity, 2)).toThrow(InvalidAmountError);
  });

  it('rejects non-decimal input', () => {
    for (const bad of ['1e3', '1,00', ' 1', 'NaN', '', '.5']) {
      expect(() => addDecimal(bad, '1')).toThrow(InvalidAmountError);
    }
  });

  it('knows each currency scale', () => {
    expect(currencyScale('USD')).toBe(2);
    expect(currencyScale('JPY')).toBe(0);
    expect(currencyScale('XOF')).toBe(0);
  });
});
