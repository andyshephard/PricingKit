// "Write only if the price is still what was shown": the write helpers read
// the product or base plan fresh before patching it, and with `expected`
// they compare each region's current price to it first. Any difference
// refuses the whole write (one PATCH per product) with PRICE_CHANGED.

import { ApiError } from '../utils/api-error';
import type { Money } from './types';

export const PRICE_CHANGED = 'PRICE_CHANGED';

function sameMoney(a: Money | undefined, b: Money): boolean {
  return Boolean(a) && a!.currencyCode === b.currencyCode && String(a!.units ?? '0') === String(b.units ?? '0') && (a!.nanos ?? 0) === (b.nanos ?? 0);
}

/** Throws ApiError(409, PRICE_CHANGED) unless every expected region still has exactly that price */
export function assertExpectedPrices(current: Record<string, Money | undefined>, expected: Record<string, Money> | undefined): void {
  if (!expected) return;
  const changed = Object.entries(expected)
    .filter(([region, money]) => !sameMoney(current[region], money))
    .map(([region]) => region)
    .sort();
  if (changed.length > 0) {
    throw new ApiError(`PRICE_CHANGED: the price changed since the preview in ${changed.join(', ')}; nothing was written. Preview again.`, {
      status: 409,
      code: PRICE_CHANGED,
      platform: 'google',
      retryable: false,
    });
  }
}
