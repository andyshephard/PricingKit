import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeWithRateLimit, isRetryableError, RateLimitError } from '../rate-limit';
import { ApiError } from '../api-error';

const RETRYABLE = [500, 502, 503, 504, 429];

describe('isRetryableError', () => {
  it('reads status from statusCode, status or code', () => {
    expect(isRetryableError({ statusCode: 503 }, RETRYABLE)).toBe(true);
    expect(isRetryableError({ status: 502 }, RETRYABLE)).toBe(true);
    expect(isRetryableError({ code: 429, message: 'quota' }, RETRYABLE)).toBe(true);
    expect(isRetryableError({ code: 400 }, RETRYABLE)).toBe(false);
    expect(isRetryableError({ code: 'ECONNRESET' }, RETRYABLE)).toBe(false);
    expect(isRetryableError(undefined, RETRYABLE)).toBe(false);
  });

  it('honours an explicit retryable: false', () => {
    const err = new ApiError('budget', {
      status: 429,
      code: 'BUDGET_EXCEEDED',
      platform: 'apple',
      retryable: false,
    });
    expect(isRetryableError(err, RETRYABLE)).toBe(false);
  });
});

describe('executeWithRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries Google-shaped errors (numeric code) and succeeds', async () => {
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: 429, message: 'Quota exceeded', errors: [] })
      .mockRejectedValueOnce({ code: 503, message: 'Backend error', errors: [] })
      .mockResolvedValueOnce('ok');

    const promise = executeWithRateLimit([task], { retryDelay: 10 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual(['ok']);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('does not retry a Google 400 and keeps its message', async () => {
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue({ code: 400, message: 'Invalid price', errors: [] });

    const promise = executeWithRateLimit([task], { retryDelay: 10 });
    const assertion = expect(promise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RateLimitError);
      const rle = err as RateLimitError;
      expect(rle.message).toContain('Invalid price');
      expect(rle.message).not.toContain('[object Object]');
      expect(rle.originalError).toBeInstanceOf(ApiError);
      expect((rle.originalError as ApiError).code).toBe(400);
      return true;
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('does not retry budget-exceeded ApiErrors', async () => {
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(
      new ApiError('Request budget exceeded', {
        status: 429,
        code: 'BUDGET_EXCEEDED',
        platform: 'apple',
        retryable: false,
      })
    );

    const promise = executeWithRateLimit([task], { retryDelay: 10 });
    const assertion = expect(promise).rejects.toBeInstanceOf(RateLimitError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('still retries Apple-shaped errors (statusCode)', async () => {
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { statusCode: 500 }))
      .mockResolvedValueOnce('ok');

    const promise = executeWithRateLimit([task], { retryDelay: 10 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual(['ok']);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
