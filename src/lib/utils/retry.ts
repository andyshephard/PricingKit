/**
 * Backoff helpers shared by the Apple and Google HTTP clients.
 */

export interface RetryOptions {
  /** Total attempts including the first request (default: 4) */
  maxAttempts?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseDelayMs?: number;
  /** Upper bound for a single backoff delay in ms (default: 30000) */
  maxDelayMs?: number;
  /**
   * Longest Retry-After the client will wait for in ms (default: 60000).
   * A longer Retry-After fails fast instead of holding the request open.
   */
  maxRetryAfterMs?: number;
}

export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
};

export function resolveRetryOptions(options?: RetryOptions): Required<RetryOptions> {
  const resolved = { ...DEFAULT_RETRY_OPTIONS, ...options };
  resolved.maxAttempts = Math.max(1, Math.floor(resolved.maxAttempts));
  return resolved;
}

/**
 * Exponential backoff with full jitter: random in [0.5, 1.5) * base * 2^attempt,
 * capped at maxDelayMs. `attempt` is zero-based (0 = delay after first failure).
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  return Math.min(maxDelayMs, Math.round(exponential * (0.5 + Math.random())));
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
