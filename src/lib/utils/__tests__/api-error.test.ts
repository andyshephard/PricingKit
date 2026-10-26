import { describe, it, expect } from 'vitest';
import { ApiError, getErrorStatus, isRetryableStatus, toApiError } from '../api-error';
import { AppleApiError } from '@/lib/apple-connect/client';
import { GooglePlayApiError } from '@/lib/google-play/client';

describe('isRetryableStatus', () => {
  it('treats 408, 429 and 5xx (except 501) as retryable', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status), String(status)).toBe(true);
    }
    for (const status of [200, 400, 401, 403, 404, 409, 501]) {
      expect(isRetryableStatus(status), String(status)).toBe(false);
    }
  });
});

describe('getErrorStatus', () => {
  it('reads statusCode, numeric status, numeric code and Google envelopes', () => {
    expect(getErrorStatus({ statusCode: 503 })).toBe(503);
    expect(getErrorStatus({ status: 502 })).toBe(502);
    expect(getErrorStatus({ code: 429, status: 'RESOURCE_EXHAUSTED' })).toBe(429);
    expect(getErrorStatus({ error: { code: 500, message: 'x' } })).toBe(500);
  });

  it('ignores non-HTTP codes', () => {
    expect(getErrorStatus({ code: 'ECONNRESET' })).toBeUndefined();
    expect(getErrorStatus({ code: 7 })).toBeUndefined();
    expect(getErrorStatus('boom')).toBeUndefined();
    expect(getErrorStatus(null)).toBeUndefined();
  });
});

describe('toApiError', () => {
  it('returns ApiError instances unchanged', () => {
    const err = new ApiError('x', { status: 400, platform: 'google' });
    expect(toApiError(err)).toBe(err);
  });

  it('keeps AppleApiError as an ApiError with apple platform', () => {
    const err = new AppleApiError(409, 'ENTITY_ERROR', 'Conflict', 'Already exists');
    expect(err).toBeInstanceOf(ApiError);
    const normalised = toApiError(err);
    expect(normalised).toBe(err);
    expect(normalised.status).toBe(409);
    expect(normalised.code).toBe('ENTITY_ERROR');
    expect(normalised.platform).toBe('apple');
    expect(normalised.retryable).toBe(false);
    // Back-compat fields
    expect(err.statusCode).toBe(409);
    expect(err.detail).toBe('Already exists');
    expect(err.message).toBe('Conflict: Already exists');
  });

  it('marks AppleApiError 429/5xx retryable', () => {
    expect(new AppleApiError(429, 'RATE', 't', 'd').retryable).toBe(true);
    expect(new AppleApiError(503, 'X', 't', 'd').retryable).toBe(true);
  });

  it('keeps GooglePlayApiError numeric code and errors', () => {
    const err = new GooglePlayApiError({
      code: 403,
      message: 'Forbidden',
      googleStatus: 'PERMISSION_DENIED',
      errors: [{ reason: 'permissionDenied' }],
    });
    expect(toApiError(err)).toBe(err);
    expect(err.code).toBe(403);
    expect(err.status).toBe(403);
    expect(err.platform).toBe('google');
    expect(err.errors[0].reason).toBe('permissionDenied');
  });

  it('converts Google plain objects without "[object Object]"', () => {
    const plain = {
      code: 503,
      message: 'Backend unavailable',
      status: 'UNAVAILABLE',
      errors: [{ reason: 'backendError' }],
    };
    const err = toApiError(plain);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err.code).toBe(503);
    expect(err.platform).toBe('google');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('Backend unavailable');
    expect(err.details).toBe(plain);
  });

  it('converts Google error envelopes', () => {
    const err = toApiError({ error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } });
    expect(err.status).toBe(404);
    expect(err.message).toBe('Not found');
    expect(err.retryable).toBe(false);
  });

  it('converts plain Errors to 500, not retryable', () => {
    const err = toApiError(new Error('boom'), 'apple');
    expect(err.status).toBe(500);
    expect(err.code).toBe('UNKNOWN_ERROR');
    expect(err.platform).toBe('apple');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('boom');
  });

  it('converts timeout errors to retryable 504', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const err = toApiError(timeout);
    expect(err.status).toBe(504);
    expect(err.code).toBe('TIMEOUT');
    expect(err.retryable).toBe(true);
  });

  it('handles strings, unknown objects and nullish values', () => {
    expect(toApiError('plain string').message).toBe('plain string');
    expect(toApiError({ foo: 'bar' }).message).toBe('{"foo":"bar"}');
    expect(toApiError({}).message).toBe('Unknown error');
    expect(toApiError(undefined).message).toBe('Unknown error');
    expect(toApiError(null).message).toBe('Unknown error');
    expect(toApiError(42).message).toBe('42');
  });

  it('never produces "[object Object]"', () => {
    const shapes: unknown[] = [
      { code: 429 },
      { foo: { bar: 1 } },
      { error: 'nope' },
      { detail: 'apple-ish detail' },
      Object.create(null),
    ];
    for (const shape of shapes) {
      expect(toApiError(shape).message).not.toContain('[object Object]');
    }
  });

  it('survives circular objects', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toApiError(circular).message).toBe('Unknown error');
  });
});
