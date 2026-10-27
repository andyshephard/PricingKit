import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BUDGET_EXCEEDED_CODE,
  DEFAULT_REQUEST_BUDGET_LIMIT,
  RequestBudget,
} from '../request-budget';
import { ApiError } from '../api-error';
import { computeBackoffDelay, parseRetryAfter, resolveRetryOptions } from '../retry';

describe('RequestBudget', () => {
  it('defaults to Apple\'s 3600 requests per hour', () => {
    const budget = new RequestBudget();
    expect(DEFAULT_REQUEST_BUDGET_LIMIT).toBe(3600);
    expect(budget.limit).toBe(3600);
    expect(budget.windowMs).toBe(60 * 60 * 1000);
    expect(budget.remaining).toBe(3600);
  });

  it('throws a non-retryable 429 ApiError once the limit is reached', () => {
    const budget = new RequestBudget({ limit: 2 });
    budget.consume('apple');
    budget.consume('apple');
    expect(budget.remaining).toBe(0);

    let thrown: unknown;
    try {
      budget.consume('apple');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const apiError = thrown as ApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.code).toBe(BUDGET_EXCEEDED_CODE);
    expect(apiError.retryable).toBe(false);
    expect(apiError.platform).toBe('apple');
    expect(budget.used).toBe(2);
  });

  it('frees capacity as the sliding window moves', () => {
    let now = 0;
    const budget = new RequestBudget({ limit: 1, windowMs: 1000, now: () => now });
    budget.consume('google');
    expect(() => budget.consume('google')).toThrow(ApiError);
    now = 1000;
    expect(() => budget.consume('google')).not.toThrow();
  });

  it('stops when the upstream remaining count reaches 0', () => {
    const budget = new RequestBudget({ limit: 100 });
    budget.recordUpstreamRemaining(5);
    expect(budget.remaining).toBe(5);
    budget.recordUpstreamRemaining(0);
    expect(budget.remaining).toBe(0);
    expect(() => budget.consume('apple')).toThrow(/0 requests remaining/);
  });
});

describe('retry helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses Retry-After as seconds or HTTP-date', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
  });

  it('computes jittered exponential backoff capped at maxDelay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(computeBackoffDelay(0, 1000, 30_000)).toBe(1000);
    expect(computeBackoffDelay(2, 1000, 30_000)).toBe(4000);
    expect(computeBackoffDelay(10, 1000, 30_000)).toBe(30_000);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(computeBackoffDelay(1, 1000, 30_000)).toBe(1000);
  });

  it('defaults to 4 attempts and clamps to at least 1', () => {
    expect(resolveRetryOptions().maxAttempts).toBe(4);
    expect(resolveRetryOptions({ maxAttempts: 0 }).maxAttempts).toBe(1);
  });
});
