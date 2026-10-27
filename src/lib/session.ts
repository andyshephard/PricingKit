// Session and settings cookies: names, attributes, reading and writing.
//
// In production every cookie is named with the __Host- prefix, so the
// browser only accepts it from this exact host over HTTPS with Path=/ (no
// sibling subdomain can set or shadow it). Under `next dev` and in tests
// (plain http) the names have no prefix. Cookies under the old names
// (gplay_session, ...) are still read until LEGACY_SESSION_CUTOFF and moved
// to the new name on the request that reads them.

import { legacySessionsAccepted } from './encryption';
import {
  openSession,
  sealSession,
  SESSION_COOKIE_BASE,
  SESSION_LIFETIME_SECONDS,
  type SessionCredentials,
  type SessionKind,
} from './session-envelope';

export const COOKIE_NAMES = {
  googleSession: SESSION_COOKIE_BASE.google,
  googlePackage: 'gplay_package_name',
  appleSession: SESSION_COOKIE_BASE.apple,
  appleBundle: 'apple_bundle_id',
  exchangeRatesKey: 'exchange_rates_api_key',
} as const;
export type CookieBaseName = (typeof COOKIE_NAMES)[keyof typeof COOKIE_NAMES];

// Base names, as before the __Host- prefix (tests and older imports use these)
export const GOOGLE_SESSION_COOKIE = COOKIE_NAMES.googleSession;
export const GOOGLE_PACKAGE_NAME_COOKIE = COOKIE_NAMES.googlePackage;
export const APPLE_SESSION_COOKIE = COOKIE_NAMES.appleSession;
export const APPLE_BUNDLE_ID_COOKIE = COOKIE_NAMES.appleBundle;
export const EXCHANGE_RATES_KEY_COOKIE = COOKIE_NAMES.exchangeRatesKey;

/** Session cookie lifetime in seconds (24 hours); the server enforces it too (session-envelope.ts) */
export const SESSION_COOKIE_MAX_AGE = SESSION_LIFETIME_SECONDS;
/** The saved Open Exchange Rates key: 1 year */
export const EXCHANGE_RATES_KEY_MAX_AGE = 60 * 60 * 24 * 365;
/**
 * Largest Set-Cookie line (name, value and attributes) we write. Browsers keep
 * about 4096 bytes per cookie and silently drop a larger one, which would look
 * like a successful sign-in that didn't stick.
 */
export const MAX_SET_COOKIE_BYTES = 3800;

/** Secure (and __Host- prefixed) cookies in production builds */
export function secureCookies(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** The name a cookie is written under */
export function cookieName(base: CookieBaseName): string {
  return secureCookies() ? `__Host-${base}` : base;
}

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export interface CookieJar extends CookieReader {
  set(name: string, value: string, options?: Record<string, unknown>): void;
}

export class CookieTooLargeError extends Error {
  constructor() {
    super('These credentials are too large to keep in a browser cookie (about 4 KB). Use a standard 2048-bit service account key.');
    this.name = 'CookieTooLargeError';
  }
}

function attributes(maxAge: number) {
  return { httpOnly: true, secure: secureCookies(), sameSite: 'strict' as const, maxAge, path: '/' };
}

function setCookieLength(name: string, value: string, maxAge: number): number {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`.length;
}

/** A cookie's value, from its current name or (until the legacy cutoff) its old one */
export function readCookie(jar: CookieReader, base: CookieBaseName, nowMs: number = Date.now()): { value: string; legacyName: boolean } | undefined {
  const name = cookieName(base);
  const current = jar.get(name)?.value;
  if (current) return { value: current, legacyName: false };
  if (name !== base && legacySessionsAccepted(nowMs)) {
    const old = jar.get(base)?.value;
    if (old) return { value: old, legacyName: true };
  }
  return undefined;
}

/**
 * Deletes a cookie by name. Written as an expired cookie with the same
 * attributes: a __Host- cookie can only be replaced by one that is Secure with
 * Path=/, so a plain delete would be ignored.
 */
function expire(jar: CookieJar, name: string): void {
  jar.set(name, '', { ...attributes(0), secure: name.startsWith('__Host-') || secureCookies(), expires: new Date(0) });
}

/** Writes a cookie under its current name (and removes the old name). Throws CookieTooLargeError. */
export function writeCookie(jar: CookieJar, base: CookieBaseName, value: string, maxAge: number): void {
  const name = cookieName(base);
  if (setCookieLength(name, value, maxAge) > MAX_SET_COOKIE_BYTES) throw new CookieTooLargeError();
  jar.set(name, value, attributes(Math.max(0, Math.floor(maxAge))));
  if (name !== base && jar.get(base)) expire(jar, base);
}

/** Removes a cookie under its current and its old name */
export function clearCookie(jar: CookieJar, base: CookieBaseName): void {
  const name = cookieName(base);
  expire(jar, name);
  if (name !== base) expire(jar, base);
}

const SESSION_BASE: Record<SessionKind, CookieBaseName> = { google: COOKIE_NAMES.googleSession, apple: COOKIE_NAMES.appleSession };

/** Seals a new session (24 hours) and writes its cookie. Throws MissingEncryptionKeyError, CookieTooLargeError. */
export async function writeSessionCookie<K extends SessionKind>(jar: CookieJar, kind: K, credentials: unknown, nowMs: number = Date.now()): Promise<void> {
  const sealed = await sealSession(kind, credentials, { nowMs });
  writeCookie(jar, SESSION_BASE[kind], sealed.value, sealed.exp - Math.floor(nowMs / 1000));
}

/**
 * The credentials of a valid session cookie, or null. A legacy cookie (old
 * format or old name) is re-written as v3 under the current name with the
 * same expiry; best effort, since some cookie stores are read-only.
 */
export async function readSessionCookie<K extends SessionKind>(jar: CookieReader | CookieJar, kind: K, nowMs: number = Date.now()): Promise<SessionCredentials<K> | null> {
  const found = readCookie(jar, SESSION_BASE[kind], nowMs);
  if (!found) return null;
  const opened = await openSession(kind, found.value, { nowMs });
  if (!opened) return null;
  if ((opened.legacy || found.legacyName) && 'set' in jar) {
    try {
      const sealed = await sealSession(kind, opened.creds, { nowMs, exp: opened.exp });
      writeCookie(jar, SESSION_BASE[kind], sealed.value, sealed.exp - Math.floor(nowMs / 1000));
    } catch {
      // read-only cookie store here, or too large; the old cookie keeps working until the cutoff
    }
  }
  return opened.creds;
}

/** The selected app (package name or bundle ID), moved to its current cookie name when read from the old one */
export function readAppCookie(jar: CookieReader | CookieJar, base: typeof COOKIE_NAMES.googlePackage | typeof COOKIE_NAMES.appleBundle, nowMs: number = Date.now()): string | undefined {
  const found = readCookie(jar, base, nowMs);
  if (!found) return undefined;
  if (found.legacyName && 'set' in jar) {
    try {
      writeCookie(jar, base, found.value, SESSION_COOKIE_MAX_AGE);
    } catch {
      // read-only cookie store
    }
  }
  return found.value;
}

/**
 * True when the request carries a Google Play or Apple session cookie that
 * opens to valid credentials. Used to gate operations that cost operator
 * resources (e.g. forcing an upstream refresh on otherwise public endpoints).
 */
export async function hasAuthenticatedSession(jar: CookieReader | CookieJar): Promise<boolean> {
  return Boolean((await readSessionCookie(jar, 'google')) || (await readSessionCookie(jar, 'apple')));
}
