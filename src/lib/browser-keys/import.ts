// Import store keys into WebCrypto as non-extractable CryptoKeys.
//
// The PEM text exists only for the length of one call: it is parsed, imported
// and then goes out of scope. Callers get the CryptoKey and the non-secret ids
// back, never the PEM, and no page script can read the key out of the
// CryptoKey afterwards (extractable: false).

import { BrowserKeyError } from './types';
import { MAX_PEM_CHARS, pkcs8PemToDer, rsaPkcs8KeyBits } from './encoding';

/** An App Store Connect key (P-256) is about 250 characters of PEM; anything far larger isn't one */
export const MAX_APPLE_PEM_CHARS = 2048;
/** Service account keys accepted: RSA of 2048 to 4096 bits (Google issues 2048), as on the server */
export const MIN_RSA_KEY_BITS = 2048;
export const MAX_RSA_KEY_BITS = 4096;
/** A service account JSON file is about 2.3 KB; the server caps request bodies at 16 KB */
export const MAX_SERVICE_ACCOUNT_JSON_CHARS = 16 * 1024;
const MAX_ID_CHARS = 64;
const MAX_GOOGLE_FIELD_CHARS = 256;

const APPLE_ALGORITHM: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' };
const GOOGLE_ALGORITHM: RsaHashedImportParams = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

export interface AppleKeyInput {
  /** The contents of the AuthKey_XXXXXXXXXX.p8 file */
  privateKeyPem: string;
  keyId: string;
  issuerId: string;
}

export interface ImportedAppleKey {
  key: CryptoKey;
  keyId: string;
  issuerId: string;
}

export interface ImportedGoogleKey {
  key: CryptoKey;
  clientEmail: string;
  privateKeyId: string;
  projectId: string;
}

/** Apple Key IDs are 10 characters and Issuer IDs are UUIDs; both fit this */
const APPLE_ID = /^[A-Za-z0-9-]+$/;

function appleId(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new BrowserKeyError('invalid_key', `Enter the ${name}.`);
  if (text.length > MAX_ID_CHARS || !APPLE_ID.test(text)) {
    throw new BrowserKeyError('invalid_key', `The ${name} should contain only letters, numbers and hyphens.`);
  }
  return text;
}

export async function importAppleKey(input: AppleKeyInput): Promise<ImportedAppleKey> {
  const keyId = appleId(input?.keyId, 'Key ID');
  const issuerId = appleId(input?.issuerId, 'Issuer ID');
  const pem = input?.privateKeyPem;
  if (typeof pem !== 'string' || pem.trim() === '') {
    throw new BrowserKeyError('invalid_key', 'Choose your .p8 key file.');
  }
  if (pem.includes('-----BEGIN EC PRIVATE KEY-----')) {
    throw new BrowserKeyError('invalid_key', 'This is an EC key in SEC1 form. Use the .p8 file App Store Connect gave you.');
  }
  const der = pem.length <= MAX_APPLE_PEM_CHARS ? pkcs8PemToDer(pem) : null;
  if (!der) {
    throw new BrowserKeyError('invalid_key', "This isn't a .p8 key file. Use the AuthKey_….p8 file App Store Connect gave you.");
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', der, APPLE_ALGORITHM, false, ['sign']);
  } catch {
    // The crypto error is never passed on
    throw new BrowserKeyError('invalid_key', "This .p8 file doesn't hold an App Store Connect (P-256) private key.");
  } finally {
    der.fill(0);
  }
  return { key, keyId, issuerId };
}

const REQUIRED_SERVICE_ACCOUNT_FIELDS = [
  'type',
  'project_id',
  'private_key_id',
  'private_key',
  'client_email',
  'client_id',
  'auth_uri',
  'token_uri',
  'auth_provider_x509_cert_url',
  'client_x509_cert_url',
] as const;

/**
 * The same structural rule as validateServiceAccountJson in
 * src/lib/google-play/client.ts: every standard field is a string and type
 * is "service_account". A test keeps the two in step.
 */
export function isServiceAccountShape(json: unknown): json is Record<(typeof REQUIRED_SERVICE_ACCOUNT_FIELDS)[number], string> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return false;
  const obj = json as Record<string, unknown>;
  return REQUIRED_SERVICE_ACCOUNT_FIELDS.every((field) => typeof obj[field] === 'string') && obj.type === 'service_account';
}

function googleField(value: string, name: string): string {
  const text = value.trim();
  if (!text || text.length > MAX_GOOGLE_FIELD_CHARS || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new BrowserKeyError('invalid_key', `The service account key's ${name} field is empty or invalid.`);
  }
  return text;
}

/**
 * Import a Google service account key from the JSON file's text (or the
 * already-parsed object).
 */
export async function importGoogleKey(json: string | object): Promise<ImportedGoogleKey> {
  let raw: unknown = json;
  if (typeof json === 'string') {
    if (json.length > MAX_SERVICE_ACCOUNT_JSON_CHARS) {
      throw new BrowserKeyError('invalid_key', "This file is too large to be a service account key.");
    }
    try {
      raw = JSON.parse(json);
    } catch {
      // JSON.parse messages quote the input; never pass them on
      throw new BrowserKeyError('invalid_key', "This file isn't valid JSON. Use the service account key file Google Cloud gave you.");
    }
  }
  if (!isServiceAccountShape(raw)) {
    throw new BrowserKeyError('invalid_key', "This isn't a service account key file. Create a JSON key for the service account in Google Cloud.");
  }
  const clientEmail = googleField(raw.client_email, 'client_email');
  if (!/^[^\s@]+@[^\s@]+$/.test(clientEmail)) {
    throw new BrowserKeyError('invalid_key', "The service account key's client_email field is empty or invalid.");
  }
  const privateKeyId = googleField(raw.private_key_id, 'private_key_id');
  const projectId = googleField(raw.project_id, 'project_id');

  const der = raw.private_key.length <= MAX_PEM_CHARS ? pkcs8PemToDer(raw.private_key) : null;
  // Checked before importing: WebCrypto spends time proportional to the key size
  const bits = der ? rsaPkcs8KeyBits(der) : null;
  if (!der || bits === null || bits < MIN_RSA_KEY_BITS || bits > MAX_RSA_KEY_BITS) {
    der?.fill(0);
    throw new BrowserKeyError('invalid_key', 'The service account key must be an RSA private key of 2048 to 4096 bits (Google issues 2048-bit keys).');
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', der, GOOGLE_ALGORITHM, false, ['sign']);
  } catch {
    throw new BrowserKeyError('invalid_key', "The service account key's private_key can't be used. Create a new JSON key in Google Cloud.");
  } finally {
    der.fill(0);
  }
  return { key, clientEmail, privateKeyId, projectId };
}
