const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

/**
 * Derives a 256-bit AES-GCM key from the ENCRYPTION_KEY environment variable using PBKDF2.
 * Uses the Web Crypto API for Cloudflare Workers compatibility.
 */
async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY environment variable is required for secure session storage');
  }

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH * 8 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypts data using AES-256-GCM via Web Crypto API.
 * Returns a base64 string containing: salt + iv + ciphertext (authTag appended by GCM)
 */
export async function encrypt(plaintext: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(salt);

  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoder.encode(plaintext),
  );

  // Combine: salt (16) + iv (12) + ciphertext+authTag (GCM appends 16-byte tag)
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts data encrypted with the encrypt function.
 */
export async function decrypt(encryptedBase64: string): Promise<string> {
  const binaryStr = atob(encryptedBase64);
  const combined = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    combined[i] = binaryStr.charCodeAt(i);
  }

  // Extract components — use slice() to create copies with their own ArrayBuffers,
  // since subarray() shares the parent buffer and .buffer would return the entire thing
  const salt = combined.slice(0, SALT_LENGTH);
  const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertextWithTag = combined.slice(SALT_LENGTH + IV_LENGTH);

  const key = await deriveKey(salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    ciphertextWithTag,
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Checks if encryption is available (ENCRYPTION_KEY is set).
 */
export function isEncryptionAvailable(): boolean {
  return typeof process.env.ENCRYPTION_KEY === 'string' && process.env.ENCRYPTION_KEY.length > 0;
}
