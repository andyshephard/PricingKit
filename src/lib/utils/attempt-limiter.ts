/**
 * Fixed-window attempt limiter, held in memory.
 *
 * Used as per-instance brakes: on the connect checks (/api/apple/auth,
 * /api/auth) and on upstream fetches with users' own Open Exchange Rates
 * keys. State is per process / per Worker isolate, so this is a brake, not a
 * guarantee: a determined caller spread across isolates gets more attempts.
 * Keys are opaque identifiers (never a raw credential or token). The map is
 * capped so it cannot grow without bound.
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
