// Session cookie encryption (AES-256-GCM, Web Crypto, so it runs on Workers).
//
// The key: ENCRYPTION_KEY must be base64 (or base64url) of at least 32 bytes
// with at least 16 distinct byte values (`openssl rand -base64 32` always
// qualifies). Outside `next dev` anything else is refused: sessions can't be
// created or read. This checks format, length and that the bytes aren't an
// obvious repeat; it can't tell whether the key is random, so generate it,
// never type it. The decoded bytes are the HKDF
// input, so a cookie's known plaintext can't be used to guess a short
// passphrase cheaply. Under `next dev` a non-conforming key still works, with
// a warning (its UTF-8 bytes are the HKDF input).
//
// Formats:
// - v3 (current): "v3." + base64url(iv(12) + ciphertext+tag), AES key from
//   HKDF-SHA-256 over the key bytes, with additional authenticated data the
//   caller supplies (src/lib/session-envelope.ts binds the cookie name and
//   the session version). What is encrypted is a session envelope with an
//   absolute expiry.
// - legacy v2: "v2." + base64(iv + ciphertext+tag), key from HKDF over the
//   UTF-8 text of ENCRYPTION_KEY, no additional data, no expiry inside.
// - legacy v1: base64(salt(16) + iv(12) + ciphertext+tag), key from PBKDF2
//   (100,000 iterations, SHA-256) with the per-cookie salt.
//   Legacy cookies are read only until LEGACY_SESSION_CUTOFF, after a strict
//   shape and length check (so junk is refused before any key derivation),
//   and are re-written as v3 when read.

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;
/** ENCRYPTION_KEY must decode to at least this many bytes */
export const MIN_ENCRYPTION_KEY_BYTES = 32;
/**
 * ...with at least this many distinct byte values. 32 random bytes have
 * about 30 (never below 24 in 20,000 trials); "AAAA...", "abab..." or a
 * repeated word have a handful.
 */
export const MIN_ENCRYPTION_KEY_DISTINCT_BYTES = 16;

/**
 * Legacy (v1 and v2) session cookies are accepted until this instant and
 * refused from then on. Set two weeks after the v3 envelope shipped: browser
 * cookies lasted 24 hours, so every active session has been re-written as v3
 * long before. Remove the legacy read path once this date has passed.
 */
export const LEGACY_SESSION_CUTOFF = '2026-11-10T00:00:00Z';
export const LEGACY_SESSION_CUTOFF_MS = Date.parse(LEGACY_SESSION_CUTOFF);

export const SESSION_CIPHERTEXT_V3_PREFIX = 'v3.';
/** Prefix of legacy v2 (HKDF over the key text) session ciphertexts */
export const SESSION_CIPHERTEXT_V2_PREFIX = 'v2.';

/** Longest cookie value considered at all (browsers keep about 4 KB per cookie) */
const MAX_CIPHERTEXT_CHARS = 4096;
/** The smallest credentials a real legacy session held (an App Store Connect key) are well above this */
const MIN_LEGACY_PLAINTEXT_BYTES = 128;
const MAX_LEGACY_BYTES = 3072;

const V3_SALT = new TextEncoder().encode('pricingkit/session-cookie/salt/v3');
const V3_INFO = new TextEncoder().encode('pricingkit/session-cookie/aes-256-gcm/v3');
const V2_SALT = new TextEncoder().encode('pricingkit/session-cookie/salt/v2');
const V2_INFO = new TextEncoder().encode('pricingkit/session-cookie/aes-256-gcm/v2');

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64_ANY = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Plaintext (base64) session cookies and weak keys are only permitted under `next dev` */
export function isPlaintextSessionAllowed(): boolean {
  // `next build` inlines NODE_ENV as 'production', so built servers always fail
  // closed; checking for 'development' (rather than !== 'production') also
  // covers code run outside Next, such as tests and scripts.
  return process.env.NODE_ENV === 'development';
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64 or base64url; throws on anything else */
export function fromBase64(value: string): Uint8Array {
  if (!BASE64_ANY.test(value)) throw new Error('not base64');
  const standard = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (standard.length % 4 === 1) throw new Error('not base64');
  const binaryStr = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// The key

export type EncryptionKeyProblem = 'missing' | 'weak';

/** The decoded key bytes, or null when ENCRYPTION_KEY isn't base64 of at least 32 bytes with enough distinct values */
function decodedKeyBytes(secret: string): Uint8Array | null {
  const trimmed = secret.trim();
  if (!BASE64_ANY.test(trimmed)) return null;
  try {
    const bytes = fromBase64(trimmed);
    return bytes.length >= MIN_ENCRYPTION_KEY_BYTES && new Set(bytes).size >= MIN_ENCRYPTION_KEY_DISTINCT_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/** What is wrong with ENCRYPTION_KEY, if anything */
export function encryptionKeyProblem(): EncryptionKeyProblem | null {
  const secret = process.env.ENCRYPTION_KEY;
  if (typeof secret !== 'string' || secret.trim() === '') return 'missing';
  return decodedKeyBytes(secret) ? null : 'weak';
}

/**
 * True when sessions can be encrypted: a conforming ENCRYPTION_KEY, or under
 * `next dev` any non-empty one.
 */
export function isEncryptionAvailable(): boolean {
  const problem = encryptionKeyProblem();
  return problem === null || (problem === 'weak' && isPlaintextSessionAllowed());
}

export const MISSING_ENCRYPTION_KEY_MESSAGE =
  'ENCRYPTION_KEY is not set, so credentials cannot be stored securely. Set ENCRYPTION_KEY to 32 random bytes in base64 (`openssl rand -base64 32`) and restart the server.';

export const WEAK_ENCRYPTION_KEY_MESSAGE =
  'ENCRYPTION_KEY must be base64 of at least 32 bytes that are not an obvious repeat; generate one with `openssl rand -base64 32` (PricingKit checks the format, not the randomness). Sessions are refused until it is replaced; everyone signs in again afterwards.';

/** The message for the current key problem (safe to show: it contains no secrets) */
export function encryptionKeyMessage(): string {
  return encryptionKeyProblem() === 'weak' ? WEAK_ENCRYPTION_KEY_MESSAGE : MISSING_ENCRYPTION_KEY_MESSAGE;
}

/**
 * Thrown when a session would have to be stored without a usable key outside
 * `next dev`. The message is safe to show to the user (it contains no secrets).
 */
export class MissingEncryptionKeyError extends Error {
  constructor(message: string = encryptionKeyMessage()) {
    super(message);
    this.name = 'MissingEncryptionKeyError';
  }
}

/**
 * Whether a new session can be stored at all. Login routes check this before
 * contacting the store, so a missing or weak ENCRYPTION_KEY is reported with
 * any credentials and no upstream call is made.
 */
export function canStoreSessions(): boolean {
  return isEncryptionAvailable() || (encryptionKeyProblem() === 'missing' && isPlaintextSessionAllowed());
}

function requireSecret(): string {
  if (!isEncryptionAvailable()) throw new MissingEncryptionKeyError();
  return process.env.ENCRYPTION_KEY!;
}

type CachedKey = { secret: string; key: Promise<CryptoKey> };
let cachedV3: CachedKey | undefined;
let cachedV2: CachedKey | undefined;
let warnedWeakKey = false;

function hkdfKey(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  return (async () => {
    const material = await crypto.subtle.importKey('raw', toArrayBuffer(ikm), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(salt), info: toArrayBuffer(info) },
      material,
      { name: ALGORITHM, length: KEY_LENGTH * 8 },
      false,
      ['encrypt', 'decrypt']
    );
  })();
}

/** One cached key per ENCRYPTION_KEY value (a changed env, e.g. in tests, derives again); failures aren't cached */
function cached(slot: 'v3' | 'v2', secret: string, derive: () => Promise<CryptoKey>): Promise<CryptoKey> {
  const current = slot === 'v3' ? cachedV3 : cachedV2;
  if (current?.secret === secret) return current.key;
  const entry: CachedKey = { secret, key: derive() };
  if (slot === 'v3') cachedV3 = entry;
  else cachedV2 = entry;
  entry.key.catch(() => {
    if (slot === 'v3' && cachedV3 === entry) cachedV3 = undefined;
    if (slot === 'v2' && cachedV2 === entry) cachedV2 = undefined;
  });
  return entry.key;
}

/** v3 key: HKDF-SHA-256 over the decoded key bytes (under `next dev` a weak key's UTF-8 bytes) */
function v3Key(): Promise<CryptoKey> {
  const secret = requireSecret();
  return cached('v3', secret, () => {
    let ikm = decodedKeyBytes(secret);
    if (!ikm) {
      if (!warnedWeakKey) {
        warnedWeakKey = true;
        console.warn(`${WEAK_ENCRYPTION_KEY_MESSAGE} (Accepted under next dev only.)`);
      }
      ikm = new TextEncoder().encode(secret);
    }
    return hkdfKey(ikm, V3_SALT, V3_INFO);
  });
}

/** Legacy v2 key: HKDF over the UTF-8 text of ENCRYPTION_KEY */
function v2Key(): Promise<CryptoKey> {
  const secret = requireSecret();
  return cached('v2', secret, () => hkdfKey(new TextEncoder().encode(secret), V2_SALT, V2_INFO));
}

/** Legacy v1 key: PBKDF2 over ENCRYPTION_KEY with the cookie's own salt */
async function v1Key(salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(requireSecret()), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: ALGORITHM, length: KEY_LENGTH * 8 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------------
// v3

/** "v3." + base64url(iv + ciphertext+tag), authenticated with `aad` */
export async function sealV3(plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, additionalData: toArrayBuffer(new TextEncoder().encode(aad)) },
    await v3Key(),
    new TextEncoder().encode(plaintext)
  );
  const combined = new Uint8Array(IV_LENGTH + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), IV_LENGTH);
  return SESSION_CIPHERTEXT_V3_PREFIX + toBase64Url(combined);
}

/** Opens a v3 ciphertext; throws unless it is well formed and authenticates with this key and `aad` */
export async function openV3(value: string, aad: string): Promise<string> {
  if (!value.startsWith(SESSION_CIPHERTEXT_V3_PREFIX) || value.length > MAX_CIPHERTEXT_CHARS) throw new Error('not a v3 session');
  const body = value.slice(SESSION_CIPHERTEXT_V3_PREFIX.length);
  if (!BASE64URL.test(body)) throw new Error('not a v3 session');
  const combined = fromBase64(body);
  if (combined.length <= IV_LENGTH + TAG_LENGTH) throw new Error('not a v3 session');
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: combined.slice(0, IV_LENGTH), additionalData: toArrayBuffer(new TextEncoder().encode(aad)) },
    await v3Key(),
    combined.slice(IV_LENGTH)
  );
  return new TextDecoder().decode(decrypted);
}

// ---------------------------------------------------------------------------
// Legacy (read only, until LEGACY_SESSION_CUTOFF)

export function isLegacyCiphertext(value: string): boolean {
  return !value.startsWith(SESSION_CIPHERTEXT_V3_PREFIX);
}

/** Whether legacy cookies (and legacy cookie names) are still accepted at `nowMs` */
export function legacySessionsAccepted(nowMs: number = Date.now()): boolean {
  return nowMs < LEGACY_SESSION_CUTOFF_MS;
}

/**
 * Opens a legacy v1 or v2 ciphertext. Throws after the cutoff, and for
 * anything that isn't strictly base64 of a plausible size, before any key
 * is derived (a v1 key costs 100,000 PBKDF2 iterations).
 */
export async function openLegacy(value: string, nowMs: number = Date.now()): Promise<string> {
  if (!legacySessionsAccepted(nowMs)) throw new Error('legacy sessions are no longer accepted');
  if (value.length > MAX_CIPHERTEXT_CHARS) throw new Error('not a session');
  if (value.startsWith(SESSION_CIPHERTEXT_V2_PREFIX)) {
    const body = value.slice(SESSION_CIPHERTEXT_V2_PREFIX.length);
    if (!BASE64.test(body)) throw new Error('not a session');
    const combined = fromBase64(body);
    if (combined.length < IV_LENGTH + TAG_LENGTH + MIN_LEGACY_PLAINTEXT_BYTES || combined.length > MAX_LEGACY_BYTES) throw new Error('not a session');
    const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv: combined.slice(0, IV_LENGTH) }, await v2Key(), combined.slice(IV_LENGTH));
    return new TextDecoder().decode(decrypted);
  }
  if (!BASE64.test(value)) throw new Error('not a session');
  const combined = fromBase64(value);
  if (combined.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH + MIN_LEGACY_PLAINTEXT_BYTES || combined.length > MAX_LEGACY_BYTES) {
    throw new Error('not a session');
  }
  const salt = combined.slice(0, SALT_LENGTH);
  const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, await v1Key(salt), combined.slice(SALT_LENGTH + IV_LENGTH));
  return new TextDecoder().decode(decrypted);
}
