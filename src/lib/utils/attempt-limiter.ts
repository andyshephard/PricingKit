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

  attempt(key: string): AttemptDecision {
    const now = this.now();
    const { limit, windowMs, globalLimit, maxKeys = 1000 } = this.options;

    if (now - this.global.start >= windowMs) this.global = { start: now, count: 0 };
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

    const retryAfter = (start: number) => Math.max(1, Math.ceil((start + windowMs - now) / 1000));
    if (window.count >= limit) return { allowed: false, retryAfterSeconds: retryAfter(window.start) };
    if (globalLimit !== undefined && this.global.count >= globalLimit) {
      return { allowed: false, retryAfterSeconds: retryAfter(this.global.start) };
    }
    window.count++;
    this.global.count++;
    return { allowed: true };
  }
}

/** Best-effort client identifier for rate limiting (Cloudflare, then proxies). */
export function clientKeyFromHeaders(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return headers.get('x-real-ip')?.trim() || 'unknown';
}
