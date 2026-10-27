// Inverting an op from its `before` snapshot, for undo.
// Pure: the platform rules live here so an undo plan can be built offline.

import { computeIdempotencyKey, type BasePriceOp } from './changeset';
import { compareDecimal } from './decimal';

export type InverseResult =
  | { op: Omit<BasePriceOp, 'id'>; /** Something a reviewer of the undo plan must know */ warning?: string }
  | { notReversible: string };

/** An App Store price going up, in the same currency */
function isIncrease(before: BasePriceOp['before'], after: BasePriceOp['after']): boolean {
  return Boolean(before && after && before.currency === after.currency && compareDecimal(after.amount, before.amount) > 0);
}

function make(op: BasePriceOp, kind: BasePriceOp['kind'], before: BasePriceOp['before'], after: BasePriceOp['after']): InverseResult {
  let options = op.options;
  let warning: string | undefined;
  // preserveCurrentPrice: false on a decrease is how the decrease reached existing App Store
  // subscribers. Copied onto its undo (an increase) it would raise their price too, which needs
  // their consent in most storefronts. The undo keeps their price unless someone edits it.
  if (op.platform === 'apple' && options?.preserveCurrentPrice === false && isIncrease(before, after)) {
    options = { ...options, preserveCurrentPrice: true };
    warning =
      `${op.id} moved existing subscribers in ${op.target.territory} to ${before?.amount} ${before?.currency} (preserveCurrentPrice: false). ` +
      `Its undo raises the price back to ${after?.amount} ${after?.currency} for new subscribers only (preserveCurrentPrice: true): existing subscribers keep the lower price. ` +
      'To raise theirs too, set preserveCurrentPrice to false on this op and plan for consent.';
  }
  const inverse: Omit<BasePriceOp, 'id' | 'idempotencyKey'> = {
    kind,
    platform: op.platform,
    target: op.target,
    before,
    after,
    ...(options ? { options } : {}),
    note: `undo of ${op.id}`,
  };
  return { op: { ...inverse, idempotencyKey: computeIdempotencyKey(inverse) }, ...(warning ? { warning } : {}) };
}

/**
 * The op that restores what `op` changed.
 *
 * - setPrice      -> setPrice back to `before`; with no `before`, Google removes
 *                    the region again and Apple can't (it has no way to delete a
 *                    current price), so that op is reported as not reversible
 * - schedulePrice -> restore the replaced scheduled price, or delete the new one
 * - deleteScheduled -> schedule the deleted price again
 * - removePrice   -> set the removed price again (Google)
 */
export function invertOp(op: BasePriceOp): InverseResult {
  switch (op.kind) {
    case 'setPrice':
      if (op.before) return make(op, 'setPrice', op.after, op.before);
      if (op.platform === 'google') return make(op, 'removePrice', op.after, null);
      return { notReversible: `Apple can't remove the current price ${op.after?.amount} ${op.after?.currency} in ${op.target.territory}; set a different price instead` };
    case 'schedulePrice':
      if (op.before) return make(op, 'schedulePrice', op.after, op.before);
      return make(op, 'deleteScheduled', op.after, null);
    case 'deleteScheduled':
      return make(op, 'schedulePrice', null, op.before);
    case 'removePrice':
      return make(op, 'setPrice', null, op.before);
  }
}
