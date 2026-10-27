// JSON export and import of current price state.
//
// A PricingStateSnapshot is what adapters' fetchState() returns, written to a
// file: the "before" picture to keep next to a plan. Phase 0 price exports
// (PriceExport, schemaVersion 1) can be imported as state too.

import { z } from 'zod';
import { appRefSchema, priceValueSchema, productRefSchema } from './changeset';
import { normalizeStartDate, type AppRef, type PriceValue, type ProductPriceState, type ProductRef, type TerritoryPriceState } from './model';
import type { PriceExport } from '../export/types';

export const STATE_SCHEMA_VERSION = 1 as const;
export const STATE_KIND = 'pricingkit.state' as const;

export interface PricingStateSnapshot {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  kind: typeof STATE_KIND;
  capturedAt: string;
  app: AppRef;
  products: ProductPriceState[];
}

const territoryStateSchema = z
  .object({
    territory: z.string().regex(/^[A-Z]{2}$/),
    currency: z.string(),
    current: priceValueSchema.nullable(),
    scheduled: priceValueSchema.nullable().optional(),
    availability: z.string().optional(),
    refs: z.object({ scheduledPriceId: z.string().optional() }).strict().optional(),
    problems: z.object({ current: z.string().optional(), scheduled: z.string().optional() }).strict().optional(),
  })
  .strict();

export const productPriceStateSchema = z
  .object({
    product: productRefSchema,
    capturedAt: z.string().min(1),
    territories: z.record(z.string(), territoryStateSchema),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

const snapshotSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    kind: z.literal(STATE_KIND),
    capturedAt: z.string().min(1),
    app: appRefSchema,
    products: z.array(productPriceStateSchema),
  })
  .strict();

export class StateValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid price state:\n- ${issues.join('\n- ')}`);
    this.name = 'StateValidationError';
  }
}

export function createStateSnapshot(app: AppRef, products: ProductPriceState[], capturedAt = new Date().toISOString()): PricingStateSnapshot {
  return { schemaVersion: STATE_SCHEMA_VERSION, kind: STATE_KIND, capturedAt, app, products };
}

export function serializeStateSnapshot(snapshot: PricingStateSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/**
 * Parse a state snapshot, or import a Phase 0 price export (a single
 * PriceExport or an array of them for the same app).
 */
export function parseStateSnapshot(input: string | unknown): PricingStateSnapshot {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw new StateValidationError([`not valid JSON: ${(error as Error).message}`]);
    }
  }
  const exports = Array.isArray(raw) ? raw : [raw];
  if (exports.length > 0 && exports.every(isPriceExport)) {
    return snapshotFromPriceExports(exports as PriceExport[]);
  }
  const result = snapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new StateValidationError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  for (const product of result.data.products) {
    for (const [key, territory] of Object.entries(product.territories)) {
      if (key !== territory.territory) {
        throw new StateValidationError([`territory key ${key} doesn't match its entry (${territory.territory})`]);
      }
    }
  }
  return result.data as PricingStateSnapshot;
}

function isPriceExport(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
      Array.isArray((value as { prices?: unknown }).prices) &&
      (value as { product?: unknown }).product
  );
}

function productRefFromExport(exp: PriceExport): ProductRef {
  const { product } = exp;
  if (exp.platform === 'apple') {
    return {
      platform: 'apple',
      type: product.type,
      id: product.storeId ?? product.id,
      productId: product.id,
    };
  }
  if (product.type === 'subscription') {
    if (!product.basePlanId) throw new StateValidationError([`Google subscription export for ${product.id} has no basePlanId`]);
    return { platform: 'google', type: 'subscription', productId: product.id, basePlanId: product.basePlanId };
  }
  return {
    platform: 'google',
    type: 'inapp',
    productId: product.id,
    ...(product.purchaseOptionId ? { purchaseOptionId: product.purchaseOptionId } : {}),
  };
}

/** Convert one Phase 0 PriceExport into core price state. Apple price point IDs aren't in exports, so Apple prices compare by amount. */
export function stateFromPriceExport(exp: PriceExport): ProductPriceState {
  const territories: Record<string, TerritoryPriceState> = {};
  for (const price of exp.prices) {
    const current: PriceValue | null =
      price.amount === null
        ? null
        : { currency: price.currency, amount: price.amount, ...(price.proceeds ? { proceeds: price.proceeds } : {}) };
    // More than one future price is ambiguous: report it, never pick one
    const several = (price.scheduled?.length ?? 0) > 1;
    const next = several ? undefined : price.scheduled?.[0];
    territories[price.territory] = {
      territory: price.territory,
      currency: price.currency,
      current,
      ...(several
        ? { problems: { scheduled: `${price.scheduled!.length} future prices (${price.scheduled!.map((p) => `${p.amount} from ${p.startDate}`).join(', ')})` } }
        : {}),
      ...(next
        ? { scheduled: { currency: price.currency, amount: next.amount, startDate: normalizeStartDate(next.startDate), ...(next.proceeds ? { proceeds: next.proceeds } : {}) } }
        : {}),
      ...(price.availability ? { availability: price.availability } : {}),
    };
  }
  return { product: productRefFromExport(exp), capturedAt: exp.exportedAt, territories };
}

export function snapshotFromPriceExports(exports: PriceExport[]): PricingStateSnapshot {
  const app = exports[0].app;
  const appKey = JSON.stringify(app);
  if (exports.some((e) => JSON.stringify(e.app) !== appKey)) {
    throw new StateValidationError(['all exports in one snapshot must belong to the same app']);
  }
  const capturedAt = exports.map((e) => e.exportedAt).sort()[0];
  return createStateSnapshot(app, exports.map(stateFromPriceExport), capturedAt);
}
