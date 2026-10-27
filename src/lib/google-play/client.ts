import type { ServiceAccountCredentials } from './types';
import type { GoogleKeyCredentials, TokenSource } from '../token-source';
import { TokenCache, hashCredentialFields } from '../token-cache';
import { ApiError, getErrorStatus, isRetryableStatus, toApiError } from '../utils/api-error';
import type { RequestBudget } from '../utils/request-budget';
import {
  computeBackoffDelay,
  parseRetryAfter,
  resolveRetryOptions,
  sleep,
  type RetryOptions,
} from '../utils/retry';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ANDROID_PUBLISHER_BASE = 'https://androidpublisher.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_TTL_SECONDS = 3600; // 1 hour
const TOKEN_REFRESH_MARGIN = 60; // refresh 60s before expiry

// Cached access tokens, keyed on a hash of the full credential (including the
// private key) so different tenants sharing a client_email / private_key_id never
// reuse each other's token.
const accessTokenCache = new TokenCache();

function hashCredentials(credentials: GoogleKeyCredentials): Promise<string> {
  return hashCredentialFields([
    credentials.client_email,
    credentials.private_key_id,
    credentials.private_key,
  ]);
}

function base64UrlEncodeString(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64UrlEncodeBytes(bytes: ArrayBuffer): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/** Service account keys PricingKit accepts: RSA of 2048 to 4096 bits (Google issues 2048) */
export const MIN_RSA_KEY_BITS = 2048;
export const MAX_RSA_KEY_BITS = 4096;
const RSA_ENCRYPTION_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

/** One DER TLV: the content's start and end, and where the next one starts */
function derItem(der: Uint8Array, pos: number, tag: number): { start: number; end: number } {
  if (der[pos] !== tag) throw new Error('unexpected DER tag');
  let len = der[pos + 1];
  let start = pos + 2;
  if (len === undefined) throw new Error('truncated DER');
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3) throw new Error('unsupported DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | der[start + i];
    start += n;
  }
  const end = start + len;
  if (end > der.length) throw new Error('truncated DER');
  return { start, end };
}

/**
 * The modulus size in bits of a PKCS#8 RSA private key in PEM, read from its
 * DER without importing it (importing a huge key costs real CPU), or null
 * when it isn't one.
 */
export function rsaPrivateKeyBits(pem: string): number | null {
  if (typeof pem !== 'string' || pem.length > 8192) return null;
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem);
  if (!match) return null;
  const body = match[1].replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const der = new Uint8Array(Buffer.from(body, 'base64'));
  try {
    const outer = derItem(der, 0, 0x30);
    const version = derItem(der, outer.start, 0x02);
    const algorithm = derItem(der, version.end, 0x30);
    const oid = derItem(der, algorithm.start, 0x06);
    const oidBytes = der.subarray(oid.start, oid.end);
    if (oidBytes.length !== RSA_ENCRYPTION_OID.length || RSA_ENCRYPTION_OID.some((b, i) => oidBytes[i] !== b)) return null;
    const octets = derItem(der, algorithm.end, 0x04);
    const rsaKey = derItem(der, octets.start, 0x30);
    const rsaVersion = derItem(der, rsaKey.start, 0x02);
    const modulus = derItem(der, rsaVersion.end, 0x02);
    let first = modulus.start;
    while (first < modulus.end && der[first] === 0) first++;
    if (first === modulus.end) return null;
    return (modulus.end - first - 1) * 8 + (32 - Math.clz32(der[first]));
  } catch {
    return null;
  }
}

/** True for an RSA key PricingKit will import (2048 to 4096 bits) */
export function isAcceptedServiceAccountKey(pem: string): boolean {
  const bits = rsaPrivateKeyBits(pem);
  return bits !== null && bits >= MIN_RSA_KEY_BITS && bits <= MAX_RSA_KEY_BITS;
}

async function importPrivateKey(pemKey: string): Promise<CryptoKey> {
  // Checked before importing: Web Crypto spends time proportional to the key size
  if (!isAcceptedServiceAccountKey(pemKey)) {
    throw new GooglePlayApiError({
      code: 400,
      message: 'The service account key must be an RSA private key of 2048 to 4096 bits',
      errors: [{ reason: 'unsupportedKey' }],
      retryable: false,
    });
  }
  const pemBody = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyBuffer = Buffer.from(pemBody, 'base64');
  return crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function mintAccessToken(credentials: GoogleKeyCredentials): Promise<{
  token: string;
  expiresAt: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + TOKEN_TTL_SECONDS;

  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: credentials.private_key_id,
  };
  const payload = {
    iss: credentials.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: expiresAt,
  };

  const encodedHeader = base64UrlEncodeString(JSON.stringify(header));
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await importPrivateKey(credentials.private_key);
  const signatureBytes = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const encodedSignature = base64UrlEncodeBytes(signatureBytes);
  const assertion = `${signingInput}.${encodedSignature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new GooglePlayApiError({
      code: 401,
      message: `Failed to obtain Google access token (${response.status}): ${text}`,
      errors: [{ reason: 'invalidCredentials', message: text }],
      retryable: false,
    });
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new GooglePlayApiError({
      code: 401,
      message: 'Google token endpoint returned no access_token',
      errors: [{ reason: 'invalidCredentials', message: 'No access_token in response' }],
      retryable: false,
    });
  }

  const ttl = typeof data.expires_in === 'number' ? data.expires_in : TOKEN_TTL_SECONDS;
  return { token: data.access_token, expiresAt: now + ttl };
}

// GoogleKeyTokenSource calls this; requests take a TokenSource
export async function getGoogleAccessToken(
  credentials: GoogleKeyCredentials
): Promise<string> {
  const credHash = await hashCredentials(credentials);

  const cached = accessTokenCache.get(credHash, TOKEN_REFRESH_MARGIN);
  if (cached) {
    return cached;
  }

  const { token, expiresAt } = await mintAccessToken(credentials);
  accessTokenCache.set(credHash, { token, expiresAt });
  return token;
}

export function clearGoogleAccessTokenCache(): void {
  accessTokenCache.clear();
}

interface GoogleErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

/**
 * Error thrown by googlePlayFetch. Extends the shared ApiError; `code` stays
 * the numeric HTTP code and `errors` the Google reasons, so existing
 * `err.code === 403` / `err.errors[0].reason` checks keep working.
 */
export class GooglePlayApiError extends ApiError {
  code: number;
  errors: Array<{ reason?: string; message?: string }>;
  /** Google's canonical status string, e.g. "PERMISSION_DENIED" */
  googleStatus?: string;
  /** Requests this call sent before failing (1 = no client-side retry); set by googlePlayFetch */
  attempts?: number;

  constructor(init: {
    code: number;
    message: string;
    googleStatus?: string;
    errors?: Array<{ reason?: string; message?: string }>;
    retryable?: boolean;
    cause?: unknown;
    attempts?: number;
  }) {
    super(init.message, {
      status: init.code,
      code: init.code,
      platform: 'google',
      retryable: init.retryable,
      details: { googleStatus: init.googleStatus, errors: init.errors ?? [] },
      cause: init.cause,
    });
    this.name = 'GooglePlayApiError';
    this.code = init.code;
    this.errors = init.errors ?? [];
    this.googleStatus = init.googleStatus;
    if (init.attempts !== undefined) this.attempts = init.attempts;
  }
}

export interface GooglePlayFetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Backoff settings for 429 / 5xx / network errors (default: 4 attempts) */
  retry?: RetryOptions;
  /** Optional per-run budget; each attempt consumes one request */
  budget?: RequestBudget;
  /**
   * Retry only 429 (the request was not processed). For non-idempotent
   * writes such as offer creates: after a 5xx, a timeout or a network error
   * the write may have taken effect, so it is never sent again here; the
   * error is final (retryable: false) and the caller re-reads to find out.
   */
  retryOnlyRateLimited?: boolean;
}

function buildUrl(path: string, query?: GooglePlayFetchOptions['query']): string {
  let url = `${ANDROID_PUBLISHER_BASE}${path}`;
  if (!query) return url;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (parts.length > 0) {
    url += `?${parts.join('&')}`;
  }
  return url;
}

export async function googlePlayFetch<T>(
  tokens: TokenSource,
  path: string,
  options: GooglePlayFetchOptions = {}
): Promise<T> {
  const { method = 'GET', body, query, budget, retryOnlyRateLimited = false } = options;
  const retry = resolveRetryOptions(options.retry);
  const url = buildUrl(path, query);

  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt + 1 >= retry.maxAttempts;

    // Throws BUDGET_EXCEEDED before anything is sent
    budget?.consume('google');

    let response: Response;
    try {
      // Inside the try so a network failure while minting the token is retried too
      const token = await tokens.getToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (networkError) {
      // Token endpoint HTTP errors (e.g. 401 invalid credentials) keep their shape
      if (getErrorStatus(networkError) !== undefined) {
        throw networkError;
      }
      const normalised = toApiError(networkError, 'google');
      // fetch() rejections are network failures / timeouts: transient
      const retryable = normalised.retryable || networkError instanceof TypeError;
      if (!retryable || isLastAttempt || retryOnlyRateLimited) {
        throw new GooglePlayApiError({
          code: normalised.status === 500 ? 503 : normalised.status,
          message: normalised.message,
          errors: [{ reason: 'networkError', message: normalised.message }],
          // Non-transient failures are terminal; a transient one that ran out of
          // attempts follows its 503/504 status so an outer retry policy still applies.
          // A write that may have been sent (retryOnlyRateLimited) is never retryable.
          retryable: retryable && !retryOnlyRateLimited ? undefined : false,
          cause: networkError,
          attempts: attempt + 1,
        });
      }
      const delay = computeBackoffDelay(attempt, retry.baseDelayMs, retry.maxDelayMs);
      console.log(
        `[googlePlayFetch] Network error on ${method} ${path}: ${normalised.message}. ` +
        `Retry ${attempt + 1}/${retry.maxAttempts - 1} in ${delay}ms...`
      );
      await sleep(delay);
      continue;
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON body — leave parsed undefined.
      }
    }

    if (response.ok) {
      return parsed as T;
    }

    const envelope = (parsed as GoogleErrorEnvelope) ?? {};
    const errInfo = envelope.error ?? {};
    // Google puts the HTTP status in error.code; prefer it, fall back to the response
    const code = typeof errInfo.code === 'number' ? errInfo.code : response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
    const retryAfterTooLong =
      retryAfterMs !== undefined && retryAfterMs > retry.maxRetryAfterMs;

    const mayRetry = retryOnlyRateLimited ? code === 429 : isRetryableStatus(code);
    if (mayRetry && !retryAfterTooLong && !isLastAttempt) {
      // Wait at least Retry-After; jittered backoff spreads out concurrent retries
      const backoff = computeBackoffDelay(attempt, retry.baseDelayMs, retry.maxDelayMs);
      const delay = retryAfterMs !== undefined ? Math.max(retryAfterMs, backoff) : backoff;
      console.log(
        `[googlePlayFetch] ${method} ${path} → ${code}. ` +
        `Retry ${attempt + 1}/${retry.maxAttempts - 1} in ${delay}ms...`
      );
      await sleep(delay);
      continue;
    }

    const apiError = new GooglePlayApiError({
      code,
      message: errInfo.message || response.statusText || `HTTP ${response.status}`,
      googleStatus: errInfo.status,
      errors: Array.isArray(errInfo.errors) ? errInfo.errors : [],
      // Only a too-long Retry-After is terminal; otherwise retryable follows the
      // status so a caller's own retry policy (e.g. executeWithRateLimit) still applies.
      // A write limited to 429 retries that failed otherwise may have taken effect: terminal.
      retryable: retryAfterTooLong || (retryOnlyRateLimited && code !== 429) ? false : undefined,
      attempts: attempt + 1,
    });
    console.error(
      `[googlePlayFetch] ${method} ${url} → ${response.status}`,
      JSON.stringify({ code: apiError.code, status: apiError.googleStatus, message: apiError.message, errors: apiError.errors })
    );
    throw apiError;
  }
}

export function validateServiceAccountJson(json: unknown): json is ServiceAccountCredentials {
  if (typeof json !== 'object' || json === null) {
    return false;
  }

  const obj = json as Record<string, unknown>;

  const requiredFields = [
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
  ];

  for (const field of requiredFields) {
    if (typeof obj[field] !== 'string') {
      return false;
    }
  }

  if (obj.type !== 'service_account') {
    return false;
  }

  return true;
}

