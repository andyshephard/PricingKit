// Decimal helpers for price exports.
// Amounts are carried as canonical decimal strings end to end and never pass
// through a JS number, so exports round-trip exactly (e.g. "0.1" stays "0.1").

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;
const NANOS_PER_UNIT = 1000000000;

export class InvalidAmountError extends Error {
  constructor(value: unknown) {
    super(`Invalid price amount: ${JSON.stringify(value)}`);
    this.name = 'InvalidAmountError';
  }
}

function formatParts(negative: boolean, integer: string, fraction: string): string {
  const int = integer.replace(/^0+(?=\d)/, '');
  const frac = fraction.replace(/0+$/, '');
  const isZero = /^0+$/.test(int) && frac === '';
  const sign = negative && !isZero ? '-' : '';
  return frac ? `${sign}${int}.${frac}` : `${sign}${int}`;
}

/**
 * Normalize a decimal string to canonical form: no leading zeros on the
 * integer part, no trailing zeros on the fraction, no "-0".
 * "004.990" -> "4.99", "100.0" -> "100", "0.00" -> "0".
 * Throws InvalidAmountError for anything that is not a plain decimal string
 * (exponents, commas, whitespace, NaN, numbers).
 */
export function normalizeDecimal(value: string): string {
  if (typeof value !== 'string') throw new InvalidAmountError(value);
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new InvalidAmountError(value);
  return formatParts(match[1] === '-', match[2], match[3] ?? '');
}

/**
 * Convert a Google Play Money value (units + nanos) to a canonical decimal
 * string without floating point. Per the Money spec, units and nanos share
 * the same sign; mixed signs are rejected.
 */
export function moneyToDecimal(units: string | undefined, nanos: number | undefined): string {
  const unitsStr = units ?? '0';
  if (!/^-?\d+$/.test(unitsStr)) throw new InvalidAmountError(units);

  const nanosValue = nanos ?? 0;
  if (!Number.isInteger(nanosValue) || Math.abs(nanosValue) >= NANOS_PER_UNIT) {
    throw new InvalidAmountError(nanos);
  }

  const unitsNegative = unitsStr.startsWith('-');
  const unitsAbs = unitsNegative ? unitsStr.slice(1) : unitsStr;
  const unitsIsZero = /^0+$/.test(unitsAbs);
  if (!unitsIsZero && nanosValue !== 0 && unitsNegative !== nanosValue < 0) {
    throw new InvalidAmountError({ units, nanos });
  }

  const negative = unitsNegative || nanosValue < 0;
  const fraction = String(Math.abs(nanosValue)).padStart(9, '0');
  return formatParts(negative, unitsAbs, fraction);
}
