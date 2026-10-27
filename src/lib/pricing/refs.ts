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

// SHA-256 (FIPS 180-4), synchronous and dependency-free: the core runs in the
// browser, on Workers and in the CLI, and Web Crypto's digest is async only.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a UTF-8 string, as 64 hex digits */
export function sha256Hex(text: string): string {
  const message = new TextEncoder().encode(text);
  const bitLength = message.length * 8;
  const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * Confirm-hash algorithms. 'sha256' (plans from schema version 3, workspace
 * plan indexes from version 2): the first 32 hex digits (128 bits) of
 * SHA-256, so finding two plans with one hash costs about 2^64 work.
 * 'fnv1a64' (older files): 16 hex digits of FNV-1a 64, which someone who
 * writes both plans can collide; still accepted, with a warning.
 */
export type HashAlg = 'sha256' | 'fnv1a64';
export const CONFIRM_HASH_HEX_DIGITS = 32;

export function contentHash(text: string, alg: HashAlg): string {
  return alg === 'sha256' ? sha256Hex(text).slice(0, CONFIRM_HASH_HEX_DIGITS) : fnv1a64(text);
}

/** A confirm hash of either algorithm: 32 or 16 lowercase hex digits */
export const confirmHashSchema = z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{16})$/, 'must be a plan hash (32 hex digits; 16 for older plans)');


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

