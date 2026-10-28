/**
 * Authentication for API routes: the single place that turns request headers
 * into store token sources. Route files must use these helpers instead of
 * reading the headers themselves.
 *
 * The browser keeps the store keys and sends only short-lived tokens:
 * - X-PK-Apple-Token: an App Store Connect JWT the browser signed (ES256, at
 *   most 20 minutes)
 * - X-PK-Google-Token: a Google access token the browser minted itself
 * - X-PK-App: the selected app (bundle ID or package name)
 *
 * The checks here are cheap shape checks that save a pointless store round
 * trip. They read the Apple JWT's claims WITHOUT verifying its signature, so
 * nothing here grants access: the store verifies every token. Claims are used
 * only for refusals and for a non-secret log label. Tokens and these headers
 * are never logged, cached or echoed.
 */

import { NextResponse } from 'next/server';
import type { AppleConnection } from '@/lib/apple-connect/types';
import { HeaderTokenSource, MAX_HEADER_TOKEN_CHARS, type TokenSource } from '@/lib/token-source';
import { bundleIdSchema, packageNameSchema } from '@/lib/validation';

export const APPLE_TOKEN_HEADER = 'x-pk-apple-token';
export const GOOGLE_TOKEN_HEADER = 'x-pk-google-token';
export const APP_HEADER = 'x-pk-app';
/** The user's own Open Exchange Rates app ID (optional; never stored server-side) */
export const OER_KEY_HEADER = 'x-pk-oer-key';

export const APPLE_AUDIENCE = 'appstoreconnect-v1';
/** Apple refuses tokens that live longer than 20 minutes */
export const APPLE_MAX_TOKEN_LIFETIME_SECONDS = 20 * 60;
/** How far ahead of this server's clock a token may be issued before it reads as a wrong browser clock */
export const APPLE_MAX_CLOCK_SKEW_SECONDS = 60;
/**
 * Routes that write or run long (applies, bulk, batches) refuse an Apple
 * token with less than this left, so it can't expire halfway; the browser
 * re-signs with minValidSeconds (APPLE_APPLY_MIN_VALID_SECONDS) and retries.
 */
export const APPLE_LONG_MIN_REMAINING_SECONDS = 10 * 60;

/** 401 codes from the checks here: nothing has been sent to a store yet */
export type AuthErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_TOO_SHORT'
  | 'CLOCK_SKEW';

/**
 * Marks a 401 from these checks (header and body `stage`): the request was
 * refused before anything reached a store, so the browser may retry it, even
 * a write. Only this module sets it.
 */
export const AUTH_STAGE_HEADER = 'X-PK-Auth-Stage';
export const PRECHECK_STAGE = 'precheck';

/** Code for a 401 the store itself gave (after the route started); never marked as a precheck */
export const STORE_REFUSED_TOKEN = 'STORE_REFUSED_TOKEN';

/**
 * A 401 from the checks here. Carries the server time (Date) so the browser
 * can correct its clock before signing again, and the precheck marker.
 */
export function unauthorizedResponse(message: string = 'Not authenticated', code: AuthErrorCode = 'NOT_AUTHENTICATED') {
  return NextResponse.json(
    { error: message, code, stage: PRECHECK_STAGE },
    { status: 401, headers: { Date: new Date().toUTCString(), [AUTH_STAGE_HEADER]: PRECHECK_STAGE } }
  );
}

/**
 * A 401 because the store refused the token. Not a precheck: the browser
 * retries it only for reads. Carries the server time too.
 */
export function storeRefusedTokenResponse(message: string) {
  return NextResponse.json({ error: message, code: STORE_REFUSED_TOKEN }, { status: 401, headers: { Date: new Date().toUTCString() } });
}

/** Standard 403 response for unauthorized requests */
export function forbiddenResponse(message: string = 'Access denied') {
  return NextResponse.json({ error: message }, { status: 403 });
}

function badRequest(message: string, code: string) {
  return NextResponse.json({ error: message, code }, { status: 400 });
}

// ---------------------------------------------------------------------------
// Apple JWT pre-checks

/** Key IDs are 10 characters and issuer IDs UUIDs; these bounds only keep the log label sane */
const KID_PATTERN = /^[A-Za-z0-9]{1,64}$/;
const ISS_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;

export interface AppleTokenClaims {
  kid: string;
  iss: string;
  iat: number;
  exp: number;
}

export type AppleTokenCheck =
  | { ok: true; claims: AppleTokenClaims }
  | { ok: false; code: Exclude<AuthErrorCode, 'NOT_AUTHENTICATED'>; message: string };

function decodeJsonPart(part: string): Record<string, unknown> | null {
  try {
    if (part.length > MAX_HEADER_TOKEN_CHARS) return null;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const invalid = (message: string): AppleTokenCheck => ({ ok: false, code: 'INVALID_TOKEN', message });

/**
 * Shape checks on an App Store Connect JWT, without verifying it: three
 * base64url parts, alg ES256, a key ID, aud appstoreconnect-v1, an issuer,
 * a lifetime of at most 20 minutes, not issued in the future (CLOCK_SKEW),
 * not expired, and (minRemainingSeconds)
 * enough time left. Apple verifies the signature on every call.
 */
export function checkAppleToken(token: string, nowSeconds: number, minRemainingSeconds = 0): AppleTokenCheck {
  if (token.length > MAX_HEADER_TOKEN_CHARS) return invalid('The App Store Connect token is too long.');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => BASE64URL_PART.test(p))) return invalid('The App Store Connect token is not a JWT.');
  const header = decodeJsonPart(parts[0]);
  const payload = decodeJsonPart(parts[1]);
  if (!header || !payload) return invalid('The App Store Connect token is not a JWT.');
  if (header.alg !== 'ES256') return invalid('The App Store Connect token must be signed with ES256.');
  if (typeof header.kid !== 'string' || !KID_PATTERN.test(header.kid)) return invalid('The App Store Connect token has no valid key ID.');
  if (payload.aud !== APPLE_AUDIENCE) return invalid('The App Store Connect token has the wrong audience.');
  if (typeof payload.iss !== 'string' || !ISS_PATTERN.test(payload.iss)) return invalid('The App Store Connect token has no valid issuer ID.');
  const { iat, exp } = payload;
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat) {
    return invalid('The App Store Connect token has no valid lifetime.');
  }
  if (exp - iat > APPLE_MAX_TOKEN_LIFETIME_SECONDS) return invalid('The App Store Connect token lives longer than 20 minutes.');
  // Issued in the future (or valid for longer than a token issued now could be): the browser's clock is ahead
  if (iat > nowSeconds + APPLE_MAX_CLOCK_SKEW_SECONDS || exp > nowSeconds + APPLE_MAX_TOKEN_LIFETIME_SECONDS + APPLE_MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, code: 'CLOCK_SKEW', message: "The App Store Connect token was signed with a clock that is ahead of this server's. Sign a new one." };
  }
  if (exp <= nowSeconds) return { ok: false, code: 'TOKEN_EXPIRED', message: 'The App Store Connect token has expired.' };
  if (exp - nowSeconds < minRemainingSeconds) {
    return { ok: false, code: 'TOKEN_TOO_SHORT', message: 'The App Store Connect token expires too soon for this request. Sign a new one.' };
  }
  return { ok: true, claims: { kid: header.kid, iss: payload.iss, iat, exp } };
}

/** Non-secret log label for an Apple token: issuer and key ID, as the key-backed source uses */
function appleLabel(claims: AppleTokenClaims): string {
  return `${claims.iss}:${claims.kid}`;
}

// ---------------------------------------------------------------------------
// Helpers for routes

export interface RequireOptions {
  /**
   * Refuse a token that may expire during the request (TOKEN_TOO_SHORT).
   * Defaults to true for POST, PUT, PATCH and DELETE.
   */
  long?: boolean;
  /**
   * 'required' (default): X-PK-App must name a valid app.
   * 'none': no app needed (app list, app switch, sign-in); bundleId is ''.
   */
  app?: 'required' | 'none';
}

export type AppleAuth = { ok: true; connection: AppleConnection; claims: AppleTokenClaims } | { ok: false; response: NextResponse };
export type GoogleAuth = { ok: true; tokens: TokenSource; packageName: string } | { ok: false; response: NextResponse };

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isLong(request: Request, options: RequireOptions): boolean {
  return options.long ?? WRITE_METHODS.has(request.method.toUpperCase());
}

function header(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  return value === null ? null : value.trim();
}

/** The app named in X-PK-App, checked against the store's format, or a 400 */
function readApp(request: Request, platform: 'apple' | 'google'): { ok: true; app: string } | { ok: false; response: NextResponse } {
  const raw = header(request, APP_HEADER);
  if (!raw) {
    return { ok: false, response: badRequest('No app selected. Choose an app first.', 'APP_REQUIRED') };
  }
  const parsed = (platform === 'apple' ? bundleIdSchema : packageNameSchema).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: badRequest(platform === 'apple' ? 'Invalid bundle ID' : 'Invalid package name', 'INVALID_APP') };
  }
  return { ok: true, app: parsed.data };
}

/**
 * The App Store Connect connection for this request (X-PK-Apple-Token, and
 * X-PK-App unless options.app is 'none'), or the 401/400 to send.
 */
export function requireAppleAuth(request: Request, options: RequireOptions = {}): AppleAuth {
  const token = header(request, APPLE_TOKEN_HEADER);
  if (!token) return { ok: false, response: unauthorizedResponse() };
  const minRemaining = isLong(request, options) ? APPLE_LONG_MIN_REMAINING_SECONDS : 0;
  const check = checkAppleToken(token, Math.floor(Date.now() / 1000), minRemaining);
  if (!check.ok) return { ok: false, response: unauthorizedResponse(check.message, check.code) };

  let bundleId = '';
  if ((options.app ?? 'required') === 'required') {
    const app = readApp(request, 'apple');
    if (!app.ok) return app;
    bundleId = app.app;
  }
  let tokens: HeaderTokenSource;
  try {
    tokens = new HeaderTokenSource('apple', token, appleLabel(check.claims));
  } catch {
    return { ok: false, response: unauthorizedResponse('The App Store Connect token is malformed.', 'INVALID_TOKEN') };
  }
  return { ok: true, connection: { tokens, bundleId }, claims: check.claims };
}

/** Google access tokens are a few hundred characters; anything shorter than this isn't one */
const MIN_GOOGLE_TOKEN_CHARS = 20;
const GOOGLE_LABEL = 'google-access-token';

/**
 * The Google Play token source for this request (X-PK-Google-Token, and
 * X-PK-App unless options.app is 'none'), or the 401/400 to send.
 *
 * A Google access token is opaque, so its remaining life can't be checked
 * here: the browser asks for one with at least GOOGLE_APPLY_MIN_VALID_SECONDS
 * left before a write.
 */
export function requireGoogleAuth(request: Request, options: Pick<RequireOptions, 'app'> = {}): GoogleAuth {
  const token = header(request, GOOGLE_TOKEN_HEADER);
  if (!token) return { ok: false, response: unauthorizedResponse() };
  if (token.length < MIN_GOOGLE_TOKEN_CHARS || token.length > MAX_HEADER_TOKEN_CHARS) {
    return { ok: false, response: unauthorizedResponse('The Google access token is malformed.', 'INVALID_TOKEN') };
  }
  let packageName = '';
  if ((options.app ?? 'required') === 'required') {
    const app = readApp(request, 'google');
    if (!app.ok) return app;
    packageName = app.app;
  }
  let tokens: HeaderTokenSource;
  try {
    tokens = new HeaderTokenSource('google', token, GOOGLE_LABEL);
  } catch {
    return { ok: false, response: unauthorizedResponse('The Google access token is malformed.', 'INVALID_TOKEN') };
  }
  return { ok: true, tokens, packageName };
}

/**
 * True when the request carries a store token that passes the shape checks.
 * NOT authentication (the token isn't verified): a cheap speed bump in front
 * of optional upstream refreshes on public endpoints, which have their own
 * caps (see exchange-rates/client.ts and world-bank/ppp.ts).
 */
export function hasStoreTokenHeader(request: Request): boolean {
  const apple = header(request, APPLE_TOKEN_HEADER);
  if (apple && checkAppleToken(apple, Math.floor(Date.now() / 1000)).ok) return true;
  const google = header(request, GOOGLE_TOKEN_HEADER);
  return Boolean(google && google.length >= MIN_GOOGLE_TOKEN_CHARS && google.length <= MAX_HEADER_TOKEN_CHARS && /^[\x21-\x7e]+$/.test(google));
}

/** Open Exchange Rates app IDs are 32 hex characters; this is the shape the Settings page accepts */
const OER_KEY_PATTERN = /^[A-Za-z0-9]{8,64}$/;

/** The user's Open Exchange Rates app ID from X-PK-OER-Key, when well formed */
export function readUserOerKey(request: Request): string | undefined {
  const value = header(request, OER_KEY_HEADER);
  return value && OER_KEY_PATTERN.test(value) ? value : undefined;
}
