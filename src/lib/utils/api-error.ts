/**
 * Normalised API error shared by the Apple and Google clients.
 *
 * Both platforms historically threw different shapes (AppleApiError with
 * `statusCode`, Google plain objects with a numeric `code`). ApiError gives
 * callers one shape to branch on, and toApiError() converts anything thrown
 * into it without losing the message (no "[object Object]").
 */

export type ApiPlatform = 'apple' | 'google';

export interface ApiErrorInit {
  status: number;
  code?: string | number;
  platform: ApiPlatform;
  /** Defaults to isRetryableStatus(status) */
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

export class ApiError extends Error {
  status: number;
  code?: string | number;
  platform: ApiPlatform;
  retryable: boolean;
  details?: unknown;

  constructor(message: string, init: ApiErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.platform = init.platform;
    this.retryable = init.retryable ?? isRetryableStatus(init.status);
    this.details = init.details;
  }
}

/** 408, 429 and 5xx (except 501 Not Implemented) are transient */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 501 && status < 600);
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value < 600;
}

/**
 * Read an HTTP status from any error shape: `statusCode` (AppleApiError),
 * numeric `status` (ApiError, fetch Response-like), or numeric `code`
 * (Google API errors). Returns undefined if none is present.
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const obj = error as Record<string, unknown>;
  if (isHttpStatus(obj.statusCode)) return obj.statusCode;
  if (isHttpStatus(obj.status)) return obj.status;
  if (isHttpStatus(obj.code)) return obj.code;
  // Google error envelope: { error: { code, message, status } }
  if (obj.error && typeof obj.error === 'object') {
    return getErrorStatus(obj.error);
  }
  return undefined;
}

function safeStringify(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return json && json !== '{}' ? json : undefined;
  } catch {
    return undefined;
  }
}

function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error || 'Unknown error';
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    if (typeof obj.detail === 'string' && obj.detail) return obj.detail;
    if (obj.error && typeof obj.error === 'object') {
      const nested = obj.error as Record<string, unknown>;
      if (typeof nested.message === 'string' && nested.message) return nested.message;
    }
    if (typeof obj.error === 'string' && obj.error) return obj.error;
    return safeStringify(error) ?? 'Unknown error';
  }
  if (error === undefined || error === null) return 'Unknown error';
  return String(error);
}

function inferPlatform(error: unknown, fallback: ApiPlatform): ApiPlatform {
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (obj.platform === 'apple' || obj.platform === 'google') return obj.platform;
    if (obj.name === 'AppleApiError' || isHttpStatus(obj.statusCode)) return 'apple';
    if (isHttpStatus(obj.code) || Array.isArray(obj.errors)) return 'google';
  }
  return fallback;
}

/**
 * Convert anything thrown by an API call into an ApiError.
 *
 * - ApiError (incl. AppleApiError and GooglePlayApiError) is returned as-is
 * - Google plain objects `{ code, message, status, errors }` keep their numeric `code`
 * - Timeout/abort errors become 504 (retryable)
 * - Other Errors / unknown values become 500 (not retryable)
 *
 * @param platform - used when the platform can't be inferred from the error
 */
export function toApiError(error: unknown, platform: ApiPlatform = 'google'): ApiError {
  if (error instanceof ApiError) return error;

  const message = getErrorMessage(error);
  const resolvedPlatform = inferPlatform(error, platform);
  const status = getErrorStatus(error);

  if (status !== undefined) {
    const obj = error as Record<string, unknown>;
    const code =
      typeof obj.code === 'string' || typeof obj.code === 'number' ? obj.code : status;
    return new ApiError(message, {
      status,
      code,
      platform: resolvedPlatform,
      details: error instanceof Error ? undefined : error,
      cause: error,
    });
  }

  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new ApiError(message, {
      status: 504,
      code: 'TIMEOUT',
      platform: resolvedPlatform,
      retryable: true,
      cause: error,
    });
  }

  return new ApiError(message, {
    status: 500,
    code: 'UNKNOWN_ERROR',
    platform: resolvedPlatform,
    retryable: false,
    details: error instanceof Error ? undefined : error,
    cause: error,
  });
}
