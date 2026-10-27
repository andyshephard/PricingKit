// Signing with a browser-held key.
//
// Apple: an ES256 JWT for the App Store Connect API, sent to the PricingKit
// server, which forwards it (Apple's API has no CORS, so the browser can't
// call it directly).
// Google: an RS256 assertion the browser itself exchanges at Google's token
// endpoint. Only the resulting access token goes to the PricingKit server.
//
// Nothing here logs. Tokens live in memory only.

import { BrowserKeyError } from './types';
import { bytesToBase64Url, stringToBase64Url } from './encoding';

export const APPLE_AUDIENCE = 'appstoreconnect-v1';
/** Apple's maximum token life, used for every request (owner decision) */
export const APPLE_TOKEN_TTL_SECONDS = 20 * 60;
/** Sign a new Apple token once less than this is left */
export const APPLE_RESIGN_MARGIN_SECONDS = 2 * 60;

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
export const GOOGLE_ASSERTION_TTL_SECONDS = 3600;
/** Mint a new Google access token once less than this is left */
export const GOOGLE_REFRESH_MARGIN_SECONDS = 5 * 60;
const GOOGLE_TOKEN_TIMEOUT_MS = 15_000;
/** A Google access token is a few hundred characters; refuse anything absurd */
const MAX_ACCESS_TOKEN_CHARS = 4096;

/** Milliseconds since the epoch; injectable so tests can move time */
export type Clock = () => number;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function nowSeconds(clock: Clock): number {
  return Math.floor(clock() / 1000);
}

async function signJwt(
  header: Record<string, string>,
  claims: Record<string, string | number>,
  key: CryptoKey,
  algorithm: AlgorithmIdentifier | EcdsaParams
): Promise<string> {
  const signingInput = `${stringToBase64Url(JSON.stringify(header))}.${stringToBase64Url(JSON.stringify(claims))}`;
  // WebCrypto's ECDSA signature is raw r||s (IEEE P1363), which is the JOSE ES256 form as is
  const signature = await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

export interface AppleSigningIds {
  keyId: string;
  issuerId: string;
}

/** One App Store Connect JWT: { alg ES256, kid, typ JWT } / { iss, iat, exp, aud } */
export function signAppleJwt(key: CryptoKey, ids: AppleSigningIds, iat: number): Promise<string> {
  return signJwt(
    { alg: 'ES256', kid: ids.keyId, typ: 'JWT' },
    { iss: ids.issuerId, iat, exp: iat + APPLE_TOKEN_TTL_SECONDS, aud: APPLE_AUDIENCE },
    key,
    { name: 'ECDSA', hash: 'SHA-256' }
  );
}

export interface GoogleSigningIds {
  clientEmail: string;
  privateKeyId: string;
}

/** One service account assertion for Google's token endpoint (RFC 7523) */
export function signGoogleAssertion(key: CryptoKey, ids: GoogleSigningIds, iat: number): Promise<string> {
  return signJwt(
    { alg: 'RS256', typ: 'JWT', kid: ids.privateKeyId },
    { iss: ids.clientEmail, scope: GOOGLE_SCOPE, aud: GOOGLE_TOKEN_ENDPOINT, iat, exp: iat + GOOGLE_ASSERTION_TTL_SECONDS },
    key,
    { name: 'RSASSA-PKCS1-v1_5' }
  );
}

/** OAuth error codes worth a specific message (RFC 6749 section 5.2) */
function googleTokenError(status: number, body: unknown): BrowserKeyError {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown; error_description?: unknown };
  const code = typeof b.error === 'string' ? b.error : '';
  // The description is read only to pick a message, never shown or kept
  const description = typeof b.error_description === 'string' ? b.error_description.toLowerCase() : '';

  if (code === 'invalid_grant' && (description.includes('iat') || description.includes('exp') || description.includes('timeframe'))) {
    return new BrowserKeyError('token_rejected', "Google refused the sign-in because this computer's clock looks wrong. Set the clock automatically and try again.", status);
  }
  if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') {
    return new BrowserKeyError('token_rejected', 'Google refused this service account key. It may have been deleted or disabled. Create a new JSON key in Google Cloud.', status);
  }
  if (code === 'invalid_scope') {
    return new BrowserKeyError('token_rejected', 'Google refused the Play Console scope for this service account.', status);
  }
  if (status === 429 || status >= 500) {
    return new BrowserKeyError('network', `Google's sign-in service is unavailable (HTTP ${status}). Try again shortly.`, status);
  }
  return new BrowserKeyError('token_rejected', `Google refused the sign-in (HTTP ${status}).`, status);
}

/**
 * Exchange a signed assertion for an access token at Google's token endpoint.
 * Error responses become fixed messages; their bodies are never echoed.
 */
export async function exchangeGoogleAssertion(
  assertion: string,
  fetchFn: FetchLike
): Promise<{ accessToken: string; expiresIn: number }> {
  let response: Response;
  try {
    response = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      // No cookies or referrer go to Google with the assertion
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS) : undefined,
    });
  } catch {
    throw new BrowserKeyError('network', "Couldn't reach Google's sign-in service. Check your connection and try again.");
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw googleTokenError(response.status, body);

  const data = (typeof body === 'object' && body !== null ? body : {}) as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
  const accessToken = data.access_token;
  if (typeof accessToken !== 'string' || accessToken === '' || accessToken.length > MAX_ACCESS_TOKEN_CHARS || /[\s\u0000-\u001f\u007f]/.test(accessToken)) {
    throw new BrowserKeyError('network', "Google's sign-in service returned no usable access token.", response.status);
  }
  if (typeof data.token_type === 'string' && data.token_type.toLowerCase() !== 'bearer') {
    throw new BrowserKeyError('network', "Google's sign-in service returned an unexpected token type.", response.status);
  }
  const expiresIn =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
      ? Math.min(Math.floor(data.expires_in), GOOGLE_ASSERTION_TTL_SECONDS)
      : GOOGLE_ASSERTION_TTL_SECONDS;
  return { accessToken, expiresIn };
}

/** A token and when it stops being usable, in seconds since the epoch */
export interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Holds one token in memory and makes a new one when less than `margin`
 * seconds are left. Concurrent callers share one in-flight request, and a
 * reset() while a request is in flight stops its result from being cached.
 */
export class TokenSlot {
  private cached: CachedToken | null = null;
  private inflight: Promise<CachedToken> | null = null;
  private generation = 0;

  constructor(
    private readonly margin: number,
    private readonly clock: Clock
  ) {}

  async get(make: () => Promise<CachedToken>, options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!options.forceRefresh && this.cached && this.cached.expiresAt - nowSeconds(this.clock) > this.margin) {
      return this.cached.token;
    }
    if (options.forceRefresh) this.reset();
    if (!this.inflight) {
      const generation = this.generation;
      const pending = make().then((fresh) => {
        if (generation === this.generation) this.cached = fresh;
        return fresh;
      });
      this.inflight = pending;
      const clear = () => {
        if (this.inflight === pending) this.inflight = null;
      };
      pending.then(clear, clear);
    }
    return (await this.inflight).token;
  }

  /** Drop the cached token, e.g. after the server reports it was rejected */
  reset(): void {
    this.generation += 1;
    this.cached = null;
    this.inflight = null;
  }

  /** Seconds until the cached token expires, or null if none is cached */
  remaining(): number | null {
    return this.cached ? this.cached.expiresAt - nowSeconds(this.clock) : null;
  }
}
