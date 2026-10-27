/**
 * Per-run request budget.
 *
 * Create one per bulk run (or per API key) and pass it to appleApiRequest /
 * googlePlayFetch via the `budget` option. Every outgoing HTTP request,
 * including retries, consumes one unit. Once the budget is spent - or the
 * upstream X-Rate-Limit header reports 0 remaining - further requests throw
 * ApiError(429, 'BUDGET_EXCEEDED') before anything is sent.
 *
 * Budgets are plain objects with no module-level state, so they are safe on
 * shared hosted instances: each run/user gets its own.
 */

import { ApiError, type ApiPlatform } from './api-error';

/** App Store Connect allows 3600 requests per hour per API key */
export const DEFAULT_REQUEST_BUDGET_LIMIT = 3600;
export const DEFAULT_REQUEST_BUDGET_WINDOW_MS = 60 * 60 * 1000;

export const BUDGET_EXCEEDED_CODE = 'BUDGET_EXCEEDED';

export interface RequestBudgetOptions {
  /** Max requests within the window (default: 3600) */
  limit?: number;
  /** Sliding window length in ms (default: 1 hour) */
  windowMs?: number;
  /** Clock override, for tests */
  now?: () => number;
}

export class RequestBudget {
  readonly limit: number;
  readonly windowMs: number;
  private readonly now: () => number;
  private timestamps: number[] = [];
  private upstreamRemaining: number | undefined;

  constructor(options: RequestBudgetOptions = {}) {
    this.limit = options.limit ?? DEFAULT_REQUEST_BUDGET_LIMIT;
    this.windowMs = options.windowMs ?? DEFAULT_REQUEST_BUDGET_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  /** Requests sent within the current window */
  get used(): number {
    this.prune();
    return this.timestamps.length;
  }

  /** Requests left: the lower of the local budget and the last upstream X-Rate-Limit value */
  get remaining(): number {
    const local = Math.max(0, this.limit - this.used);
    return this.upstreamRemaining === undefined
      ? local
      : Math.min(local, this.upstreamRemaining);
  }

  /** Last remaining count reported by the platform, if any */
  get upstreamRemainingCount(): number | undefined {
    return this.upstreamRemaining;
  }

  /** Record the platform-reported remaining quota (e.g. Apple X-Rate-Limit) */
  recordUpstreamRemaining(remaining: number): void {
    if (Number.isFinite(remaining)) {
      this.upstreamRemaining = Math.max(0, remaining);
    }
  }

  /**
   * Reserve one request. Throws ApiError(429, BUDGET_EXCEEDED, retryable: false)
   * if the budget is spent; callers must call this before sending.
   */
  consume(platform: ApiPlatform): void {
    this.prune();
    if (this.upstreamRemaining === 0) {
      throw new ApiError(
        'API rate limit reached: the platform reports 0 requests remaining for this key',
        {
          status: 429,
          code: BUDGET_EXCEEDED_CODE,
          platform,
          retryable: false,
          details: { limit: this.limit, used: this.timestamps.length, upstreamRemaining: 0 },
        }
      );
    }
    if (this.timestamps.length >= this.limit) {
      throw new ApiError(
        `Request budget exceeded: ${this.limit} requests per ${Math.round(this.windowMs / 60000)} min`,
        {
          status: 429,
          code: BUDGET_EXCEEDED_CODE,
          platform,
          retryable: false,
          details: { limit: this.limit, used: this.timestamps.length },
        }
      );
    }
    this.timestamps.push(this.now());
  }
}

/**
 * Per-call context threaded through the store helpers (lib/apple-connect,
 * lib/google-play). Every HTTP request a helper makes, including retries and
 * pagination, consumes from `budget` when one is given.
 */
export interface RequestContext {
  budget?: RequestBudget;
}

/** True for the error RequestBudget.consume() throws once a budget is spent */
export function isBudgetExceeded(error: unknown): boolean {
  return error instanceof ApiError && error.code === BUDGET_EXCEEDED_CODE;
}
