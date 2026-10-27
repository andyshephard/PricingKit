import type {
  AppleConnectCredentials,
  AppleConnection,
  AppleApiListResponse,
  AppleApiErrorResponse,
} from './types';
import { TokenCache, hashCredentialFields } from '../token-cache';
import type { AppleKeyCredentials } from '../token-source';
import { ApiError, isRetryableStatus, toApiError } from '../utils/api-error';
import type { RequestBudget, RequestContext } from '../utils/request-budget';
import {
  computeBackoffDelay,
  parseRetryAfter,
  resolveRetryOptions,
  sleep,
  type RetryOptions,
} from '../utils/retry';

const JWT_EXPIRY_SECONDS = 20 * 60; // 20 minutes (max allowed)
const TOKEN_REFRESH_MARGIN = 60; // Refresh 1 minute before expiry

// Cached JWTs, keyed on a hash of the full credential (including the private key)
// so different tenants sharing a key ID / issuer ID never reuse each other's token.
const tokenCache = new TokenCache();

// Hash credentials for cache lookup
function hashCredentials(credentials: AppleKeyCredentials): Promise<string> {
  return hashCredentialFields([
    credentials.keyId,
    credentials.issuerId,
    credentials.privateKey,
  ]);
}

// Generate JWT for App Store Connect API (AppleKeyTokenSource calls this; requests take a TokenSource)
export async function generateJWT(credentials: AppleKeyCredentials): Promise<string> {
  const credHash = await hashCredentials(credentials);

  // Check if we have a valid cached token
  const cached = tokenCache.get(credHash, TOKEN_REFRESH_MARGIN);
  if (cached) {
    return cached;
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + JWT_EXPIRY_SECONDS;

  // JWT Header
  const header = {
    alg: 'ES256',
    kid: credentials.keyId,
    typ: 'JWT',
  };

  // JWT Payload
  const payload = {
    iss: credentials.issuerId,
    iat: now,
    exp: expiresAt,
    aud: 'appstoreconnect-v1',
  };

  // Encode header and payload
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  // Create signature using Web Crypto API (works on both Node.js and Cloudflare Workers)
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  // Parse PEM private key to raw PKCS8 bytes
  const pemBody = credentials.privateKey
    .replace(/-----BEGIN (?:EC )?PRIVATE KEY-----/, '')
    .replace(/-----END (?:EC )?PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyBuffer = Buffer.from(pemBody, 'base64');

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(signatureInput)
  );

  // Web Crypto ECDSA output is already IEEE P1363 format (r‖s), which is what JWT ES256 requires
  const signature = Buffer.from(sigBuffer).toString('base64');

  // Convert base64 to base64url
  const encodedSignature = base64ToBase64Url(signature);

  const token = `${encodedHeader}.${encodedPayload}.${encodedSignature}`;

  // Cache the token
  tokenCache.set(credHash, { token, expiresAt });

  return token;
}

// Base64 URL encoding helpers
function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Clear token cache
export function clearTokenCache(): void {
  tokenCache.clear();
}

// Validate Apple Connect credentials structure
export function validateAppleCredentials(
  data: unknown
): data is AppleConnectCredentials {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;

  // Check required fields
  if (typeof obj.privateKey !== 'string' || !obj.privateKey) {
    return false;
  }
  if (typeof obj.keyId !== 'string' || !obj.keyId) {
    return false;
  }
  if (typeof obj.issuerId !== 'string' || !obj.issuerId) {
    return false;
  }

  // Validate private key format (should be a PEM-formatted key)
  const privateKey = obj.privateKey;
  if (
    !privateKey.includes('-----BEGIN PRIVATE KEY-----') &&
    !privateKey.includes('-----BEGIN EC PRIVATE KEY-----')
  ) {
    return false;
  }

  return true;
}

// Parsed App Store Connect X-Rate-Limit header
export interface AppleRateLimitInfo {
  /** Hourly request limit for the key (user-hour-lim) */
  limit?: number;
  /** Requests remaining in the current hour (user-hour-rem) */
  remaining?: number;
}

/**
 * Parse Apple's X-Rate-Limit header, e.g. "user-hour-lim:3600;user-hour-rem:123;"
 * Returns undefined if the header is absent or carries no known fields.
 */
export function parseAppleRateLimitHeader(header: string | null): AppleRateLimitInfo | undefined {
  if (!header) return undefined;
  const info: AppleRateLimitInfo = {};
  for (const part of header.split(';')) {
    const [rawKey, rawValue] = part.split(':');
    // Skip empty values: Number('') is 0, which would wrongly read as "quota spent"
    if (!rawKey || rawValue === undefined || rawValue.trim() === '') continue;
    const value = Number(rawValue.trim());
    if (!Number.isFinite(value)) continue;
    const key = rawKey.trim().toLowerCase();
    if (key === 'user-hour-lim') info.limit = value;
    if (key === 'user-hour-rem') info.remaining = value;
  }
  return info.limit === undefined && info.remaining === undefined ? undefined : info;
}

// Last X-Rate-Limit seen per API key (keyed by the token source's label, no secrets)
const lastRateLimitByKey = new Map<string, AppleRateLimitInfo & { updatedAt: number }>();

function rateLimitKey(connection: AppleConnection): string {
  return connection.tokens.label;
}

/** Most recent X-Rate-Limit info observed for this connection's key, if any */
export function getAppleRateLimitInfo(
  connection: AppleConnection
): (AppleRateLimitInfo & { updatedAt: number }) | undefined {
  return lastRateLimitByKey.get(rateLimitKey(connection));
}

export interface AppleApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  queryParams?: Record<string, string>;
  apiVersion?: 'v1' | 'v2';
  /**
   * Backoff settings for 429 / 5xx / network errors (default: 4 attempts).
   * POST (create) requests only ever retry 429; see appleApiRequest.
   */
  retry?: RetryOptions;
  /** Optional per-run budget; each attempt consumes one request */
  budget?: RequestBudget;
  /** Called with the parsed X-Rate-Limit header after every response */
  onRateLimit?: (info: AppleRateLimitInfo) => void;
}

// API request helper
export async function appleApiRequest<T>(
  connection: AppleConnection,
  endpoint: string,
  options: AppleApiRequestOptions = {}
): Promise<T> {
  const { method = 'GET', body, queryParams, apiVersion = 'v1', budget, onRateLimit } = options;
  const retry = resolveRetryOptions(options.retry);
  // A POST creates something. After a 5xx, timeout or dropped connection the
  // create may still have succeeded on Apple's side, so retrying could
  // duplicate it. Only a 429 (rejected before processing) is safe to retry.
  const retriesOnlyRateLimits = method === 'POST';

  const baseUrl = `https://api.appstoreconnect.apple.com/${apiVersion}`;
  let url = `${baseUrl}${endpoint}`;

  if (queryParams && Object.keys(queryParams).length > 0) {
    const params = new URLSearchParams(queryParams);
    url += `?${params.toString()}`;
  }

  // console.log('[Apple API Request]', method, url);

  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt + 1 >= retry.maxAttempts;

    // Throws BUDGET_EXCEEDED before anything is sent
    budget?.consume('apple');

    const token = await connection.tokens.getToken();
    const fetchOptions: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30_000), // 30 second timeout per attempt
    };
    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (networkError) {
      const apiError = toApiError(networkError, 'apple');
      // fetch() rejections are network failures / timeouts: transient
      const retryable =
        !retriesOnlyRateLimits && (apiError.retryable || networkError instanceof TypeError);
      if (!retryable || isLastAttempt) {
        throw new ApiError(apiError.message, {
          status: apiError.status === 500 ? 503 : apiError.status,
          code: apiError.code === 'UNKNOWN_ERROR' ? 'NETWORK_ERROR' : apiError.code,
          platform: 'apple',
          // Non-transient failures are terminal; a transient one that ran out of
          // attempts follows its 503/504 status so an outer retry policy still applies
          retryable: retryable ? undefined : false,
          details: { attempts: attempt + 1 },
          cause: networkError,
        });
      }
      const delay = computeBackoffDelay(attempt, retry.baseDelayMs, retry.maxDelayMs);
      console.log(
        `[Apple API] Network error on ${method} ${endpoint}: ${apiError.message}. ` +
        `Retry ${attempt + 1}/${retry.maxAttempts - 1} in ${delay}ms...`
      );
      await sleep(delay);
      continue;
    }

    // console.log('[Apple API Response] Status:', response.status);

    const rateLimit = parseAppleRateLimitHeader(response.headers.get('X-Rate-Limit'));
    if (rateLimit) {
      lastRateLimitByKey.set(rateLimitKey(connection), { ...rateLimit, updatedAt: Date.now() });
      if (rateLimit.remaining !== undefined) {
        budget?.recordUpstreamRemaining(rateLimit.remaining);
      }
      onRateLimit?.(rateLimit);
    }

    if (response.ok) {
      // Handle 204 No Content
      if (response.status === 204) {
        return {} as T;
      }
      return response.json() as Promise<T>;
    }

    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
    // No point retrying a 429 when Apple says the hourly quota is spent
    const quotaSpent = status === 429 && rateLimit?.remaining === 0;
    const retryAfterTooLong =
      retryAfterMs !== undefined && retryAfterMs > retry.maxRetryAfterMs;
    const statusRetryable = retriesOnlyRateLimits ? status === 429 : isRetryableStatus(status);
    const shouldRetry = statusRetryable && !quotaSpent && !retryAfterTooLong && !isLastAttempt;

    if (shouldRetry) {
      // Wait at least Retry-After; jittered backoff spreads out concurrent retries
      const backoff = computeBackoffDelay(attempt, retry.baseDelayMs, retry.maxDelayMs);
      const delay = retryAfterMs !== undefined ? Math.max(retryAfterMs, backoff) : backoff;
      console.log(
        `[Apple API] ${status} on ${method} ${endpoint}. ` +
        `Retry ${attempt + 1}/${retry.maxAttempts - 1} in ${delay}ms...`
      );
      // Drain the body so the connection can be reused
      await response.text().catch(() => undefined);
      await sleep(delay);
      continue;
    }

    const text = await response.text().catch(() => '');
    let errorData: AppleApiErrorResponse | undefined;
    try {
      errorData = text ? (JSON.parse(text) as AppleApiErrorResponse) : undefined;
    } catch {
      // Non-JSON body (e.g. gateway HTML) - fall through to generic error
    }
    console.error('[Apple API Error] Response:', errorData ? JSON.stringify(errorData, null, 2) : `${status} ${text.slice(0, 500)}`);
    const error = errorData?.errors?.[0];
    const apiError = new AppleApiError(
      status,
      error?.code || 'UNKNOWN_ERROR',
      error?.title || 'Unknown error',
      error?.detail || `Request failed with status ${status}`
    );
    apiError.details = { errors: errorData?.errors, attempts: attempt + 1, rateLimit };
    // Only terminal conditions opt out of outer retries (e.g. executeWithRateLimit);
    // otherwise retryable follows the status so the caller's retry policy still applies
    if (quotaSpent || retryAfterTooLong || !statusRetryable) {
      apiError.retryable = false;
    }
    throw apiError;
  }
}

// Custom error class for Apple API errors
export class AppleApiError extends ApiError {
  constructor(
    public statusCode: number,
    public code: string,
    public title: string,
    public detail: string
  ) {
    super(`${title}: ${detail}`, { status: statusCode, code, platform: 'apple' });
    this.name = 'AppleApiError';
  }
}


// Test connection to App Store Connect
export async function testAppleConnection(
  connection: AppleConnection
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await appleApiRequest<AppleApiListResponse<unknown>>(
      connection,
      '/apps',
      { queryParams: { limit: '1' } }
    );
    if (!response.data || response.data.length === 0) {
      return {
        success: false,
        error: 'No apps found for this API key. Verify the key has at least one app assigned in App Store Connect → Users and Access.',
      };
    }
    return { success: true };
  } catch (error) {
    if (error instanceof AppleApiError) {
      if (error.statusCode === 401) {
        return {
          success: false,
          error: 'Invalid credentials. Please check your API key, Key ID, and Issuer ID.',
        };
      }
      if (error.statusCode === 403) {
        return {
          success: false,
          error: 'Access denied. The API key may not have sufficient permissions.',
        };
      }
      return { success: false, error: error.detail };
    }
    return {
      success: false,
      error: 'Failed to connect to App Store Connect. Please check your credentials.',
    };
  }
}

// Get app ID for a bundle ID
export async function getAppIdForBundleId(
  connection: AppleConnection,
  ctx: RequestContext = {}
): Promise<string | null> {
  try {
    // console.log('[Apple] getAppIdForBundleId - Looking up bundleId:', connection.bundleId);

    // Fetch apps matching the bundle ID filter (may return partial matches)
    // We need to find the exact match
    const response = await appleApiRequest<AppleApiListResponse<{
      id: string;
      attributes: { bundleId: string; name: string }
    }>>(
      connection,
      '/apps',
      {
        queryParams: {
          'filter[bundleId]': connection.bundleId,
          'fields[apps]': 'bundleId,name',
          limit: '200',
        },
        budget: ctx.budget,
      }
    );

    // console.log('[Apple] getAppIdForBundleId - Found', response.data?.length ?? 0, 'apps matching filter');

    if (response.data && response.data.length > 0) {
      // Find the app with the EXACT bundle ID match
      const exactMatch = response.data.find(
        app => app.attributes.bundleId === connection.bundleId
      );

      if (exactMatch) {
        // console.log('[Apple] getAppIdForBundleId - Found exact match:', exactMatch.id, exactMatch.attributes.name);
        return exactMatch.id;
      }

      // Log available apps for debugging
      /* console.log('[Apple] getAppIdForBundleId - Available apps:', response.data.map(app => ({
        id: app.id,
        bundleId: app.attributes.bundleId,
        name: app.attributes.name,
      }))); */

      // console.log('[Apple] getAppIdForBundleId - No exact match found for bundleId:', connection.bundleId);
      return null;
    }
    // console.log('[Apple] getAppIdForBundleId - No apps found for bundleId:', connection.bundleId);
    return null;
  } catch (error) {
    // null means "no app with this bundle ID"; API failures are thrown
    console.error('[Apple] getAppIdForBundleId - Error:', error);
    throw toApiError(error, 'apple');
  }
}
