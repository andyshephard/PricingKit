// Snapping a target amount to a store's valid price points.
// Pure and exact: compares Decimal strings, never floats.

import {
  absDecimal,
  compareDecimal,
  divideDecimal,
  isZeroDecimal,
  subtractDecimal,
  type Decimal,
} from './decimal';

/**
 * nearest - closest point; a tie goes to the lower price (never overshoot)
 * floor   - highest point at or below the target
 * ceil    - lowest point at or above the target
 */
export type SnapMode = 'nearest' | 'floor' | 'ceil';

export interface PricePointCandidate {
  /** Store price point ID (Apple). Undefined for stores without IDs (Google). */
  id?: string;
  customerPrice: Decimal;
  proceeds?: Decimal;
}

export interface SnapResult<P extends PricePointCandidate = PricePointCandidate> {
  point: P;
  /** point.customerPrice - target */
  deviation: Decimal;
  /** |deviation| / target as a decimal fraction with 4 digits ("0.0125" = 1.25%); "0" for a zero target */
  deviationRatio: Decimal;
}

export function deviationRatio(target: Decimal, actual: Decimal): Decimal {
  if (isZeroDecimal(target)) return '0';
  return divideDecimal(absDecimal(subtractDecimal(actual, target)), absDecimal(target), 4);
}

/**
 * Snap `target` to one of `points`. Returns undefined when no point
 * qualifies (empty ladder, or floor/ceil with nothing on that side).
 */
export function snapToPricePoints<P extends PricePointCandidate>(
  target: Decimal,
  points: readonly P[],
  mode: SnapMode = 'nearest'
): SnapResult<P> | undefined {
  let best: P | undefined;
  for (const point of points) {
    const cmp = compareDecimal(point.customerPrice, target);
    if (mode === 'floor' && cmp > 0) continue;
    if (mode === 'ceil' && cmp < 0) continue;
    if (!best) {
      best = point;
      continue;
    }
    if (mode === 'floor') {
      if (compareDecimal(point.customerPrice, best.customerPrice) > 0) best = point;
    } else if (mode === 'ceil') {
      if (compareDecimal(point.customerPrice, best.customerPrice) < 0) best = point;
    } else {
      const d = compareDecimal(
        absDecimal(subtractDecimal(point.customerPrice, target)),
        absDecimal(subtractDecimal(best.customerPrice, target))
      );
      if (d < 0 || (d === 0 && compareDecimal(point.customerPrice, best.customerPrice) < 0)) {
        best = point;
      }
    }
  }
  if (!best) return undefined;
  return {
    point: best,
    deviation: subtractDecimal(best.customerPrice, target),
    deviationRatio: deviationRatio(target, best.customerPrice),
  };
}
