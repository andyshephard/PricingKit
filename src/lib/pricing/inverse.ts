// Inverting an op from its `before` snapshot, for undo.
// Pure: the platform rules live here so an undo plan can be built offline.

import { computeIdempotencyKey, type BasePriceOp } from './changeset';

export type InverseResult =
  | { op: Omit<BasePriceOp, 'id'> }
  | { notReversible: string };

function make(op: BasePriceOp, kind: BasePriceOp['kind'], before: BasePriceOp['before'], after: BasePriceOp['after']): InverseResult {
  const inverse: Omit<BasePriceOp, 'id' | 'idempotencyKey'> = {
    kind,
    platform: op.platform,
    target: op.target,
    before,
    after,
    ...(op.options ? { options: op.options } : {}),
    note: `undo of ${op.id}`,
  };
  return { op: { ...inverse, idempotencyKey: computeIdempotencyKey(inverse) } };
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
