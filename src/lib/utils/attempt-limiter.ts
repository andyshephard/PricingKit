/**
 * Fixed-window attempt limiter, held in memory.
 *
 * Used to stop anonymous callers from turning an endpoint into a free proxy
 * (e.g. testing Open Exchange Rates keys). State is per process / per Worker
 * isolate, so this is a brake, not a guarantee: a determined caller spread
 * across isolates gets more attempts. Keys are client identifiers (an IP),
 * never credentials. The map is capped so it cannot grow without bound.
 */

export interface AttemptLimiterOptions {
  /** Attempts allowed per key within one window */
  limit: number;
  windowMs: number;
  /** Attempts allowed across all keys within one window */
  globalLimit?: number;
  /** Most keys tracked at once (oldest windows are dropped first) */
  maxKeys?: number;
  now?: () => number;
}

export type AttemptDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Window {
  start: number;
  count: number;
}

export class AttemptLimiter {
  private readonly windows = new Map<string, Window>();
  private global: Window = { start: 0, count: 0 };
  private readonly now: () => number;

  constructor(private readonly options: AttemptLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Count one attempt. With no key (the client can't be identified
   * reliably) only the global cap applies.
   */
  attempt(key: string | undefined): AttemptDecision {
    const now = this.now();
    const { limit, windowMs, globalLimit, maxKeys = 1000 } = this.options;

    if (now - this.global.start >= windowMs) this.global = { start: now, count: 0 };
    const retryAfter = (start: number) => Math.max(1, Math.ceil((start + windowMs - now) / 1000));
    if (key === undefined) {
      if (globalLimit !== undefined && this.global.count >= globalLimit) {
        return { allowed: false, retryAfterSeconds: retryAfter(this.global.start) };
      }
      this.global.count++;
      return { allowed: true };
    }
    let window = this.windows.get(key);
    if (!window || now - window.start >= windowMs) {
      window = { start: now, count: 0 };
      this.windows.delete(key);
      this.windows.set(key, window);
      while (this.windows.size > maxKeys) {
        const oldest = this.windows.keys().next().value as string;
        this.windows.delete(oldest);
      }
    }

    if (window.count >= limit) return { allowed: false, retryAfterSeconds: retryAfter(window.start) };
    if (globalLimit !== undefined && this.global.count >= globalLimit) {
      return { allowed: false, retryAfterSeconds: retryAfter(this.global.start) };
    }
    window.count++;
    this.global.count++;
    return { allowed: true };
  }
}

/**
 * The client IP from a header set by a proxy the operator trusts, or
 * undefined. Client-supplied headers such as cf-connecting-ip or
 * x-forwarded-for can be forged by anyone who reaches the app directly, so
 * nothing is read unless the operator names the header:
 *
 * - TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip  behind Cloudflare (including Workers)
 * - TRUSTED_CLIENT_IP_HEADER=x-real-ip         behind a proxy that sets it
 * - TRUSTED_CLIENT_IP_HEADER=x-forwarded-for   uses the LAST entry, the one your proxy appended
 *
 * Unset (the default), callers fall back to a per-instance cap only.
 */
export function trustedClientIp(headers: Headers, trustedHeader: string | undefined): string | undefined {
  const name = trustedHeader?.trim().toLowerCase();
  if (!name) return undefined;
  const value = headers.get(name);
  if (!value) return undefined;
  const ip = name === 'x-forwarded-for' ? value.split(',').at(-1)?.trim() : value.trim();
  return ip || undefined;
}

/**
 * Sign-in attempts (both login routes): 10 per client per 10 minutes when the
 * client IP comes from a trusted proxy header, and 300 per instance. Every
 * attempt that would contact Apple or Google counts, so the login routes
 * can't be used to check stolen keys at speed.
 */
export const signInAttempts = new AttemptLimiter({ limit: 10, globalLimit: 300, windowMs: 10 * 60 * 1000 });
