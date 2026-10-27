// Shared building blocks of the plan file formats: canonical JSON, the
// content hash, and the zod schemas for products, apps and prices. Kept apart
// from changeset.ts so modules that changeset.ts imports (offer ops) can use
// them without an import cycle.

import { z } from 'zod';
import { isDecimalString, normalizeDecimal } from './decimal';

// Canonical JSON and hashing

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** JSON with sorted keys and no undefined fields */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const FNV_OFFSET = BigInt('0xcbf29ce484222325');
const FNV_PRIME = BigInt('0x100000001b3');
const MASK_64 = BigInt('0xffffffffffffffff');

/** FNV-1a 64-bit of a UTF-8 string, as 16 hex digits. Not a security hash. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}


export const decimalSchema = z
  .string()
  .refine((v) => isDecimalString(v), { message: 'must be a plain decimal string such as "4.99"' })
  .transform((v) => normalizeDecimal(v));

export const territorySchema = z.string().regex(/^[A-Z]{2}$/, 'territory must be ISO 3166-1 alpha-2, e.g. "GB"');
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'currency must be ISO 4217, e.g. "EUR"');

export const priceValueSchema = z
  .object({
    currency: currencySchema,
    amount: decimalSchema,
    pricePointId: z.string().min(1).optional(),
    proceeds: decimalSchema.optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be a date, YYYY-MM-DD').optional(),
  })
  .strict();

export const productRefSchema = z.union([
  z.object({ platform: z.literal('apple'), type: z.enum(['subscription', 'inapp']), id: z.string().min(1), productId: z.string().min(1).optional() }).strict(),
  z.object({ platform: z.literal('google'), type: z.literal('subscription'), productId: z.string().min(1), basePlanId: z.string().min(1) }).strict(),
  z.object({ platform: z.literal('google'), type: z.literal('inapp'), productId: z.string().min(1), purchaseOptionId: z.string().min(1).optional() }).strict(),
]);

export const appRefSchema = z.union([
  z.object({ packageName: z.string().min(1) }).strict(),
  z.object({ bundleId: z.string().min(1) }).strict(),
]);

