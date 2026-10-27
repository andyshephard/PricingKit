// Session envelopes: what a session cookie holds, sealed by src/lib/encryption.ts.
//
// A v3 session cookie decrypts to { v, typ, iat, exp, creds }:
// - v     the session version (SESSION_VERSION, default "1"). Changing
//         SESSION_VERSION signs everyone out: it is also part of the
//         additional authenticated data, so older cookies no longer decrypt.
// - typ   "google" or "apple"; the cookie name is in the additional data too,
//         so one kind of session can't be presented as the other.
// - iat   issued at, exp absolute expiry (seconds). exp is at most 24 hours
//         after iat and is never extended: re-writing a cookie (for example
//         under its new name) keeps its exp.
// - creds only the fields the server needs (Google: client_email,
//         private_key_id, private_key, project_id), checked after decryption.
//
// Legacy cookies (no envelope) are read until LEGACY_SESSION_CUTOFF and only
// while SESSION_VERSION is unset; their exp is the earlier of 24 hours from
// the read and the cutoff, so re-writing one never outlives the legacy window.
//
// Under `next dev` without ENCRYPTION_KEY the envelope is stored unencrypted
// ("p3." + base64url JSON), expiry included.

import {
  fromBase64,
  isEncryptionAvailable,
  isLegacyCiphertext,
  isPlaintextSessionAllowed,
  LEGACY_SESSION_CUTOFF_MS,
  MissingEncryptionKeyError,
  openLegacy,
  openV3,
  sealV3,
  toBase64Url,
} from './encryption';

export type SessionKind = 'google' | 'apple';

/** Base names of the session cookies (src/lib/session.ts adds the __Host- prefix) */
export const SESSION_COOKIE_BASE: Record<SessionKind, string> = { google: 'gplay_session', apple: 'apple_session' };

/** Absolute session lifetime in seconds (24 hours) */
export const SESSION_LIFETIME_SECONDS = 24 * 60 * 60;
/** Accepted clock difference for iat, in seconds */
const MAX_CLOCK_SKEW_SECONDS = 300;
const PLAINTEXT_PREFIX = 'p3.';

/** The service-account fields a Google session keeps */
export interface GoogleSessionCredentials {
  client_email: string;
  private_key_id: string;
  private_key: string;
  project_id: string;
}

/** An App Store Connect key; the app is chosen separately (bundle ID cookie) */
export interface AppleSessionCredentials {
  privateKey: string;
  keyId: string;
  issuerId: string;
  bundleId?: string;
}

export type SessionCredentials<K extends SessionKind> = K extends 'google' ? GoogleSessionCredentials : AppleSessionCredentials;

export interface SessionEnvelope<K extends SessionKind = SessionKind> {
  v: string;
  typ: K;
  iat: number;
  exp: number;
  creds: SessionCredentials<K>;
}

export interface OpenedSession<K extends SessionKind = SessionKind> {
  creds: SessionCredentials<K>;
  iat: number;
  exp: number;
  /** Read from a legacy cookie: re-write it as v3 */
  legacy: boolean;
}

export class InvalidSessionCredentialsError extends Error {
  constructor() {
    super('The credentials are missing a required field');
    this.name = 'InvalidSessionCredentialsError';
  }
}

/** SESSION_VERSION, or "1". Changing it signs everyone out. */
export function sessionVersion(): string {
  return process.env.SESSION_VERSION?.trim() || '1';
}

function sessionVersionIsSet(): boolean {
  return Boolean(process.env.SESSION_VERSION?.trim());
}

/** Additional authenticated data: the cookie and the session version */
function additionalData(kind: SessionKind): string {
  return `pricingkit/session/v3|${SESSION_COOKIE_BASE[kind]}|${sessionVersion()}`;
}

const isText = (v: unknown, allowEmpty = false): v is string => typeof v === 'string' && (allowEmpty || v.length > 0) && v.length <= 8192;

/** Only the fields the server needs, each checked; null when one is missing */
export function sessionCredentials<K extends SessionKind>(kind: K, input: unknown): SessionCredentials<K> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (kind === 'google') {
    if (!isText(o.client_email) || !isText(o.private_key_id) || !isText(o.private_key) || !isText(o.project_id, true)) return null;
    const creds: GoogleSessionCredentials = { client_email: o.client_email, private_key_id: o.private_key_id, private_key: o.private_key, project_id: o.project_id };
    return creds as SessionCredentials<K>;
  }
  if (!isText(o.privateKey) || !isText(o.keyId) || !isText(o.issuerId)) return null;
  if (o.bundleId !== undefined && !isText(o.bundleId, true)) return null;
  const creds: AppleSessionCredentials = { privateKey: o.privateKey, keyId: o.keyId, issuerId: o.issuerId, ...(o.bundleId !== undefined ? { bundleId: o.bundleId as string } : {}) };
  return creds as SessionCredentials<K>;
}

const seconds = (nowMs: number) => Math.floor(nowMs / 1000);

/**
 * Seal a new session (exp 24 hours from now), or re-seal one keeping its
 * exp. Throws MissingEncryptionKeyError without a usable key outside
 * `next dev`, InvalidSessionCredentialsError for incomplete credentials.
 */
export async function sealSession<K extends SessionKind>(
  kind: K,
  credentials: unknown,
  options: { nowMs?: number; exp?: number } = {}
): Promise<{ value: string; exp: number }> {
  const now = seconds(options.nowMs ?? Date.now());
  const creds = sessionCredentials(kind, credentials);
  if (!creds) throw new InvalidSessionCredentialsError();
  const exp = Math.min(options.exp ?? now + SESSION_LIFETIME_SECONDS, now + SESSION_LIFETIME_SECONDS);
  const envelope: SessionEnvelope<K> = { v: sessionVersion(), typ: kind, iat: now, exp, creds };
  const json = JSON.stringify(envelope);
  if (isEncryptionAvailable()) return { value: await sealV3(json, additionalData(kind)), exp };
  if (isPlaintextSessionAllowed()) {
    console.warn('Warning: ENCRYPTION_KEY not set. Credentials stored in a plaintext cookie (next dev only).');
    return { value: PLAINTEXT_PREFIX + toBase64Url(new TextEncoder().encode(json)), exp };
  }
  throw new MissingEncryptionKeyError();
}

function checkEnvelope<K extends SessionKind>(kind: K, input: unknown, now: number): OpenedSession<K> | null {
  if (typeof input !== 'object' || input === null) return null;
  const e = input as Record<string, unknown>;
  if (e.v !== sessionVersion() || e.typ !== kind) return null;
  if (!Number.isSafeInteger(e.iat) || !Number.isSafeInteger(e.exp)) return null;
  const iat = e.iat as number;
  const exp = e.exp as number;
  if (exp <= iat || exp - iat > SESSION_LIFETIME_SECONDS || iat > now + MAX_CLOCK_SKEW_SECONDS || now >= exp) return null;
  const creds = sessionCredentials(kind, e.creds);
  return creds ? { creds, iat, exp, legacy: false } : null;
}

/**
 * The session a cookie holds, or null: not decryptable with this key, for
 * another cookie or session version, expired, malformed, or a legacy cookie
 * past the cutoff. Never throws.
 */
export async function openSession<K extends SessionKind>(kind: K, value: string, options: { nowMs?: number } = {}): Promise<OpenedSession<K> | null> {
  const nowMs = options.nowMs ?? Date.now();
  const now = seconds(nowMs);
  try {
    if (value.startsWith(PLAINTEXT_PREFIX)) {
      if (isEncryptionAvailable() || !isPlaintextSessionAllowed()) return null;
      return checkEnvelope(kind, JSON.parse(new TextDecoder().decode(fromBase64(value.slice(PLAINTEXT_PREFIX.length)))), now);
    }
    if (!isEncryptionAvailable()) return null;
    if (!isLegacyCiphertext(value)) return checkEnvelope(kind, JSON.parse(await openV3(value, additionalData(kind))), now);
    // Legacy: no envelope, so no expiry or version inside. Refused once SESSION_VERSION is set.
    if (sessionVersionIsSet()) return null;
    const creds = sessionCredentials(kind, JSON.parse(await openLegacy(value, nowMs)));
    if (!creds) return null;
    return { creds, iat: now, exp: Math.min(now + SESSION_LIFETIME_SECONDS, seconds(LEGACY_SESSION_CUTOFF_MS)), legacy: true };
  } catch {
    return null;
  }
}
