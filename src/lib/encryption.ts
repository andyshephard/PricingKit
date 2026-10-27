// Session cookie encryption (AES-256-GCM, Web Crypto, so it runs on Workers).
//
// Two formats:
// - v2 (written since Phase 8): "v2." + base64(iv(12) + ciphertext+tag). The
//   AES key is derived from ENCRYPTION_KEY once per process with HKDF-SHA-256
//   and cached, so a request costs one AES-GCM operation instead of 100,000
//   PBKDF2 iterations.
// - legacy (v1): base64(salt(16) + iv(12) + ciphertext+tag), key from PBKDF2
//   (100,000 iterations, SHA-256) with the per-cookie salt. Still read, so
//   sessions made before the upgrade keep working; the auth helpers
//   re-encrypt such a cookie as v2 on its next request (src/middleware/auth.ts).
//   Legacy base64 never contains ".", so the prefix can't be confused with it.
//
// HKDF does no key stretching: ENCRYPTION_KEY must be a random secret
// (`openssl rand -base64 32`), not a passphrase.

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

/** Prefix of v2 (HKDF) session ciphertexts */
export const SESSION_CIPHERTEXT_V2_PREFIX = 'v2.';
/** Fixed HKDF salt and info: domain separation for this one use of ENCRYPTION_KEY */
const HKDF_SALT = new TextEncoder().encode('pricingkit/session-cookie/salt/v2');
const HKDF_INFO = new TextEncoder().encode('pricingkit/session-cookie/aes-256-gcm/v2');
/** Below this many characters ENCRYPTION_KEY is unlikely to be a random 32-byte secret */
const MIN_RECOMMENDED_KEY_LENGTH = 32;

function requireEncryptionKey(): string {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY environment variable is required for secure session storage');
  }
  return encryptionKey;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Legacy key: PBKDF2 over ENCRYPTION_KEY with the cookie's own salt. Only
 * used to read cookies written before v2.
 */
async function deriveLegacyKey(salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(requireEncryptionKey()), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH * 8 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// One cached key per ENCRYPTION_KEY value (a changed env, e.g. in tests, derives again)
let cachedV2: { secret: string; key: Promise<CryptoKey> } | undefined;
let warnedShortKey = false;

/** v2 key: HKDF-SHA-256 over ENCRYPTION_KEY, derived once and cached */
function deriveV2Key(): Promise<CryptoKey> {
  const secret = requireEncryptionKey();
  if (cachedV2?.secret === secret) return cachedV2.key;
  if (secret.length < MIN_RECOMMENDED_KEY_LENGTH && !warnedShortKey) {
    warnedShortKey = true;
    console.warn(`ENCRYPTION_KEY is shorter than ${MIN_RECOMMENDED_KEY_LENGTH} characters. Use a random secret (openssl rand -base64 32): session keys are derived with HKDF, which does not stretch weak keys.`);
  }
  const key = (async () => {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(HKDF_SALT), info: toArrayBuffer(HKDF_INFO) },
      material,
      { name: ALGORITHM, length: KEY_LENGTH * 8 },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  cachedV2 = { secret, key };
  // A failed derivation isn't cached
  key.catch(() => {
    if (cachedV2?.key === key) cachedV2 = undefined;
  });
  return key;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binaryStr = atob(value);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return bytes;
}

/**
 * Encrypts with AES-256-GCM under the v2 (HKDF) key.
 * Returns "v2." + base64(iv + ciphertext), GCM's tag appended to the ciphertext.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveV2Key();
  const encrypted = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return SESSION_CIPHERTEXT_V2_PREFIX + toBase64(combined);
}

/** True for a ciphertext in the legacy (PBKDF2) format, which should be re-encrypted */
export function isLegacyCiphertext(value: string): boolean {
  return !value.startsWith(SESSION_CIPHERTEXT_V2_PREFIX);
}

/**
 * Decrypts a v2 ciphertext, or a legacy (PBKDF2) one. Throws if the value
 * is neither or doesn't authenticate under the current ENCRYPTION_KEY.
 */
export async function decrypt(value: string): Promise<string> {
  if (!isLegacyCiphertext(value)) {
    const combined = fromBase64(value.slice(SESSION_CIPHERTEXT_V2_PREFIX.length));
    // slice() copies, so each part has its own ArrayBuffer
    const iv = combined.slice(0, IV_LENGTH);
    const ciphertextWithTag = combined.slice(IV_LENGTH);
    const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, await deriveV2Key(), ciphertextWithTag);
    return new TextDecoder().decode(decrypted);
  }
  const combined = fromBase64(value);
  const salt = combined.slice(0, SALT_LENGTH);
  const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertextWithTag = combined.slice(SALT_LENGTH + IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, await deriveLegacyKey(salt), ciphertextWithTag);
  return new TextDecoder().decode(decrypted);
}

/**
 * Legacy cookie -> the same plaintext encrypted as v2. Returns null when the
 * value is already v2, encryption isn't configured, or it doesn't decrypt.
 * Used by the auth helpers to migrate sessions without logging anyone out.
 */
export async function reencryptLegacyCiphertext(value: string): Promise<string | null> {
  if (!isEncryptionAvailable() || !isLegacyCiphertext(value)) return null;
  try {
    return await encrypt(await decrypt(value));
  } catch {
    return null;
  }
}

/**
 * Checks if encryption is available (ENCRYPTION_KEY is set).
 */
export function isEncryptionAvailable(): boolean {
  return typeof process.env.ENCRYPTION_KEY === 'string' && process.env.ENCRYPTION_KEY.length > 0;
}

export const MISSING_ENCRYPTION_KEY_MESSAGE =
  'ENCRYPTION_KEY is not set, so credentials cannot be stored securely. Set ENCRYPTION_KEY to a random string of 32+ characters (e.g. `openssl rand -base64 32`) and restart the server.';

/**
 * Thrown when a session would have to be stored without encryption outside
 * `next dev`. The message is safe to show to the user (it contains no secrets).
 */
export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(MISSING_ENCRYPTION_KEY_MESSAGE);
    this.name = 'MissingEncryptionKeyError';
  }
}

/**
 * Plaintext (base64) session cookies are only permitted under `next dev`.
 * `next build` inlines NODE_ENV as 'production', so built servers always fail
 * closed; checking for 'development' (rather than !== 'production') also
 * covers code run outside Next, such as tests and scripts.
 */
export function isPlaintextSessionAllowed(): boolean {
  return process.env.NODE_ENV === 'development';
}

/**
 * Whether a new session can be stored at all. Login routes check this before
 * contacting the store, so a missing ENCRYPTION_KEY is reported with any
 * credentials and no upstream call is made.
 */
export function canStoreSessions(): boolean {
  return isEncryptionAvailable() || isPlaintextSessionAllowed();
}
