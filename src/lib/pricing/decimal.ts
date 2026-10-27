// String-backed decimal money for the pricing core.
//
// Amounts are canonical decimal strings ("4.99", "1200", "0.5") end to end.
// Arithmetic runs on BigInt-scaled integers, so no amount ever passes through
// a JS floating-point number. The only exception is decimalFromNumber(), the
// explicit boundary where a strategy's floating-point result enters the core.

/** A canonical decimal string: no exponent, no leading zeros, no trailing fraction zeros, no "-0". */
export type Decimal = string;

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;
const NANOS_PER_UNIT = 1000000000;
const MAX_SCALE = 18;

// BigInt constants (the tsconfig target predates BigInt literals)
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);
const NANOS_BIG = BigInt(NANOS_PER_UNIT);

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
export function normalizeDecimal(value: string): Decimal {
  if (typeof value !== 'string') throw new InvalidAmountError(value);
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new InvalidAmountError(value);
  return formatParts(match[1] === '-', match[2], match[3] ?? '');
}

/** True when `value` is a plain decimal string (canonical or not). */
export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value);
}

/**
 * Convert a Google Play Money value (units + nanos) to a canonical decimal
 * string without floating point. Per the Money spec, units and nanos share
 * the same sign; mixed signs are rejected.
 */
export function moneyToDecimal(units: string | undefined, nanos: number | undefined): Decimal {
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

/**
 * Convert a decimal to Google Play Money parts. Throws if the amount has more
 * than 9 fraction digits (Money cannot represent it exactly).
 */
export function decimalToMoney(value: Decimal): { units: string; nanos?: number } {
  const { int, scale } = parse(value);
  if (scale > 9) throw new InvalidAmountError(value);
  const scaled = int * TEN ** BigInt(9 - scale);
  const units = scaled / NANOS_BIG;
  const nanos = Number(scaled % NANOS_BIG);
  return nanos === 0 ? { units: units.toString() } : { units: units.toString(), nanos };
}

// ---------------------------------------------------------------------------
// Arithmetic on scaled BigInts

interface Scaled {
  int: bigint;
  scale: number;
}

function parse(value: Decimal): Scaled {
  if (typeof value !== 'string') throw new InvalidAmountError(value);
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new InvalidAmountError(value);
  const fraction = match[3] ?? '';
  const digits = BigInt(`${match[2]}${fraction}`);
  return { int: match[1] === '-' ? -digits : digits, scale: fraction.length };
}

function format({ int, scale }: Scaled): Decimal {
  const negative = int < ZERO;
  const digits = (negative ? -int : int).toString().padStart(scale + 1, '0');
  const integer = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? digits.slice(digits.length - scale) : '';
  return formatParts(negative, integer, fraction);
}

function align(a: Scaled, b: Scaled): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [
    a.int * TEN ** BigInt(scale - a.scale),
    b.int * TEN ** BigInt(scale - b.scale),
    scale,
  ];
}

export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const [x, y] = align(parse(a), parse(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

export function decimalEquals(a: Decimal, b: Decimal): boolean {
  return compareDecimal(a, b) === 0;
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(parse(a), parse(b));
  return format({ int: x + y, scale });
}

export function subtractDecimal(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(parse(a), parse(b));
  return format({ int: x - y, scale });
}

export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  const x = parse(a);
  const y = parse(b);
  return format({ int: x.int * y.int, scale: x.scale + y.scale });
}

export function absDecimal(a: Decimal): Decimal {
  const x = parse(a);
  return format({ int: x.int < ZERO ? -x.int : x.int, scale: x.scale });
}

export function isNegativeDecimal(a: Decimal): boolean {
  return parse(a).int < ZERO;
}

export function isZeroDecimal(a: Decimal): boolean {
  return parse(a).int === ZERO;
}

export type DecimalRoundingMode = 'half-up' | 'half-even' | 'floor' | 'ceil' | 'down';

// Divide an integer by a positive power-of-ten-like divisor with rounding
function divRound(numerator: bigint, divisor: bigint, mode: DecimalRoundingMode): bigint {
  const quotient = numerator / divisor; // truncates toward zero
  const remainder = numerator % divisor;
  if (remainder === ZERO) return quotient;
  const negative = numerator < ZERO;
  const absRem2 = (remainder < ZERO ? -remainder : remainder) * TWO;
  switch (mode) {
    case 'down':
      return quotient;
    case 'floor':
      return negative ? quotient - ONE : quotient;
    case 'ceil':
      return negative ? quotient : quotient + ONE;
    case 'half-up':
      if (absRem2 >= divisor) return negative ? quotient - ONE : quotient + ONE;
      return quotient;
    case 'half-even': {
      if (absRem2 > divisor || (absRem2 === divisor && quotient % TWO !== ZERO)) {
        return negative ? quotient - ONE : quotient + ONE;
      }
      return quotient;
    }
  }
}

/** Round to `scale` fraction digits ("1.005", 2, half-up -> "1.01"). */
export function roundDecimal(a: Decimal, scale: number, mode: DecimalRoundingMode = 'half-up'): Decimal {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new RangeError(`Invalid decimal scale ${scale}`);
  }
  const x = parse(a);
  if (x.scale <= scale) return format(x);
  const divisor = TEN ** BigInt(x.scale - scale);
  return format({ int: divRound(x.int, divisor, mode), scale });
}

/** a / b rounded to `scale` fraction digits. Throws on division by zero. */
export function divideDecimal(
  a: Decimal,
  b: Decimal,
  scale: number,
  mode: DecimalRoundingMode = 'half-up'
): Decimal {
  const x = parse(a);
  const y = parse(b);
  if (y.int === ZERO) throw new RangeError('Division by zero');
  // result = (x.int / 10^xs) / (y.int / 10^ys) = x.int * 10^(ys + scale - xs) / y.int, at `scale`
  const shift = y.scale + scale - x.scale;
  let numerator = x.int;
  let denominator = y.int;
  if (shift >= 0) numerator *= TEN ** BigInt(shift);
  else denominator *= TEN ** BigInt(-shift);
  if (denominator < ZERO) {
    numerator = -numerator;
    denominator = -denominator;
  }
  return format({ int: divRound(numerator, denominator, mode), scale });
}

/**
 * The single float -> Decimal boundary. Strategy maths (FX rates, PPP
 * multipliers) runs in floating point; its result enters the core here,
 * rounded to `scale` digits. Throws for NaN / Infinity.
 */
export function decimalFromNumber(value: number, scale: number): Decimal {
  if (!Number.isFinite(value)) throw new InvalidAmountError(value);
  if (!Number.isInteger(scale) || scale < 0 || scale > 9) {
    throw new RangeError(`Invalid decimal scale ${scale}`);
  }
  // toFixed is exact for the digits it prints; it rounds half away from zero
  // on the binary value, which is the best a float can offer.
  return normalizeDecimal(value.toFixed(scale));
}

/** For display and sorting only: never feed the result back into a plan. */
export function decimalToNumber(value: Decimal): number {
  return Number(normalizeDecimal(value));
}
