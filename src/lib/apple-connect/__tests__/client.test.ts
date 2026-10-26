import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  appleApiRequest,
  AppleApiError,
  clearTokenCache,
  generateJWT,
  getAppleRateLimitInfo,
  parseAppleRateLimitHeader,
} from '../client';
import type { AppleConnectCredentials } from '../types';
import { ApiError } from '@/lib/utils/api-error';
import { RequestBudget } from '@/lib/utils/request-budget';
import { executeWithRateLimit } from '@/lib/utils/rate-limit';

let credentials: AppleConnectCredentials;

// Throwaway P-256 key generated per run; no real credentials involved
async function generateTestCredentials(): Promise<AppleConnectCredentials> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`;
  return {
    privateKey: pem,
    keyId: 'TESTKEY123',
    issuerId: '00000000-0000-0000-0000-000000000000',
    bundleId: 'com.example.test',
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function appleError(status: number, code: string, detail: string) {
  return { errors: [{ status: String(status), code, title: 'Error', detail }] };
}

function mockFetch(responses: Array<Response | (() => Response)>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    return typeof next === 'function' ? next() : next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

/** Let real async work (crypto, body reads) run between fake-timer steps */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/** Advance fake timers until the promise settles */
async function settle(promise: Promise<unknown>): Promise<void> {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 1000 && !done; i++) {
    await flush();
    await vi.advanceTimersByTimeAsync(100);
  }
}

/** Advance fake timers by ms, letting real async work run first */
async function advance(ms: number): Promise<void> {
  for (let i = 0; i < 20; i++) await flush();
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) await flush();
}

beforeAll(async () => {
  credentials = await generateTestCredentials();
});

beforeEach(() => {
  clearTokenCache();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseAppleRateLimitHeader', () => {
  it('parses limit and remaining', () => {
    expect(parseAppleRateLimitHeader('user-hour-lim:3600;user-hour-rem:123;')).toEqual({
      limit: 3600,
      remaining: 123,
    });
  });

  it('tolerates whitespace, case and missing fields', () => {
    expect(parseAppleRateLimitHeader(' User-Hour-Rem : 7 ')).toEqual({ remaining: 7 });
    expect(parseAppleRateLimitHeader('')).toBeUndefined();
    expect(parseAppleRateLimitHeader(null)).toBeUndefined();
    expect(parseAppleRateLimitHeader('foo:bar;')).toBeUndefined();
    expect(parseAppleRateLimitHeader('user-hour-lim:3600;user-hour-rem:;')).toEqual({ limit: 3600 });
  });
});

describe('appleApiRequest retries', () => {
  it('waits for Retry-After on 429 and then succeeds', async () => {
    const { calls } = mockFetch([
      jsonResponse(429, appleError(429, 'RATE_LIMIT_EXCEEDED', 'Too many'), { 'Retry-After': '5' }),
      jsonResponse(200, { data: [] }),
    ]);

    // Sign the JWT up front so timing only covers the API calls
    await generateJWT(credentials);
    const promise = appleApiRequest(credentials, '/apps');
    await advance(4_900);
    expect(calls).toHaveLength(1);
    await advance(200);
    expect(calls).toHaveLength(2);
    await expect(promise).resolves.toEqual({ data: [] });
  });

  it('backs off exponentially on 429 without Retry-After', async () => {
    const { calls } = mockFetch([
      jsonResponse(429, appleError(429, 'RATE_LIMIT_EXCEEDED', 'Too many')),
      jsonResponse(429, appleError(429, 'RATE_LIMIT_EXCEEDED', 'Too many')),
      jsonResponse(200, { data: [] }),
    ]);

    await generateJWT(credentials);
    const promise = appleApiRequest(credentials, '/apps');
    // Math.random = 0.5 -> delays of exactly 1000ms then 2000ms
    await advance(999);
    expect(calls).toHaveLength(1);
    await advance(1);
    expect(calls).toHaveLength(2);
    await advance(1_999);
    expect(calls).toHaveLength(2);
    await advance(1);
    expect(calls).toHaveLength(3);
    await expect(promise).resolves.toEqual({ data: [] });
  });

  it('retries 5xx (including non-JSON bodies)', async () => {
    const { calls } = mockFetch([
      new Response('<html>Bad gateway</html>', { status: 502 }),
      jsonResponse(503, appleError(503, 'UNAVAILABLE', 'down')),
      jsonResponse(200, { data: { id: '1' } }),
    ]);

    const promise = appleApiRequest(credentials, '/apps/1');
    await settle(promise);
    await expect(promise).resolves.toEqual({ data: { id: '1' } });
    expect(calls).toHaveLength(3);
  });

  it('does not retry 4xx and throws AppleApiError', async () => {
    const { calls } = mockFetch([
      jsonResponse(409, appleError(409, 'ENTITY_ERROR', 'Already exists')),
    ]);

    const promise = appleApiRequest(credentials, '/x', { method: 'POST', body: {} });
    const assertion = expect(promise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AppleApiError);
      expect(err).toBeInstanceOf(ApiError);
      const e = err as AppleApiError;
      expect(e.statusCode).toBe(409);
      expect(e.status).toBe(409);
      expect(e.code).toBe('ENTITY_ERROR');
      expect(e.detail).toBe('Already exists');
      expect(e.platform).toBe('apple');
      return true;
    });
    await settle(promise);
    await assertion;
    expect(calls).toHaveLength(1);
  });

  it('gives up after maxAttempts leaving retryable to follow the status', async () => {
    const { calls } = mockFetch([
      jsonResponse(500, appleError(500, 'INTERNAL', 'oops')),
      jsonResponse(500, appleError(500, 'INTERNAL', 'oops')),
      jsonResponse(500, appleError(500, 'INTERNAL', 'oops')),
    ]);

    const promise = appleApiRequest(credentials, '/apps', { retry: { maxAttempts: 3 } });
    // Still retryable so an outer policy (executeWithRateLimit) keeps working
    const assertion = expect(promise).rejects.toMatchObject({ statusCode: 500, retryable: true });
    await settle(promise);
    await assertion;
    expect(calls).toHaveLength(3);
  });

  it('fails fast when Retry-After exceeds maxRetryAfterMs', async () => {
    const { calls } = mockFetch([
      jsonResponse(429, appleError(429, 'RATE_LIMIT_EXCEEDED', 'Too many'), { 'Retry-After': '3600' }),
    ]);

    const promise = appleApiRequest(credentials, '/apps');
    const assertion = expect(promise).rejects.toMatchObject({ statusCode: 429, retryable: false });
    await settle(promise);
    await assertion;
    expect(calls).toHaveLength(1);
  });

  it('does not retry a 429 when X-Rate-Limit reports 0 remaining', async () => {
    const { calls } = mockFetch([
      jsonResponse(429, appleError(429, 'RATE_LIMIT_EXCEEDED', 'Too many'), {
        'X-Rate-Limit': 'user-hour-lim:3600;user-hour-rem:0;',
      }),
    ]);

    const promise = appleApiRequest(credentials, '/apps');
    const assertion = expect(promise).rejects.toMatchObject({ statusCode: 429, retryable: false });
    await settle(promise);
    await assertion;
    expect(calls).toHaveLength(1);
  });
});

describe('appleApiRequest inside executeWithRateLimit', () => {
  it.each([
    [429, 'RATE_LIMIT_EXCEEDED'],
    [503, 'SERVICE_UNAVAILABLE'],
  ])('honours the caller maxRetries for a persistent %i', async (status, code) => {
    // 2 inner attempts x (1 + 2 outer retries) = 6 requests
    const { calls } = mockFetch(
      Array.from({ length: 6 }, () => () => jsonResponse(status, appleError(status, code, 'busy')))
    );

    const promise = executeWithRateLimit(
      [() => appleApiRequest(credentials, '/apps', { retry: { maxAttempts: 2 } })],
      { concurrency: 1, maxRetries: 2, retryDelay: 100 }
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'RateLimitError',
      originalError: { statusCode: status, attempts: 3 },
    });
    await settle(promise);
    await assertion;
    expect(calls).toHaveLength(6);
  });

  it('retries a persistent network error after the client gives up', async () => {
    const networkFailure = () => {
      throw new TypeError('fetch failed');
    };
    // Direct call: 2 failed attempts. Then executeWithRateLimit: 2 failed inner
    // attempts, one outer retry, and success on its first inner attempt
    const { calls } = mockFetch([
      networkFailure,
      networkFailure,
      networkFailure,
      networkFailure,
      networkFailure,
      jsonResponse(200, { data: [] }),
    ]);

    const inner = appleApiRequest(credentials, '/apps', { retry: { maxAttempts: 2 } });
    const innerAssertion = expect(inner).rejects.toMatchObject({
      status: 503,
      code: 'NETWORK_ERROR',
      retryable: true,
    });
    await settle(inner);
    await innerAssertion;
    expect(calls).toHaveLength(2);

    const promise = executeWithRateLimit(
      [() => appleApiRequest(credentials, '/apps', { retry: { maxAttempts: 2 } })],
      { concurrency: 1, maxRetries: 1, retryDelay: 100 }
    );
    await settle(promise);
    await expect(promise).resolves.toEqual([{ data: [] }]);
    expect(calls).toHaveLength(6);
  });

  it('does not retry a non-transient fetch failure', async () => {
    const { calls } = mockFetch([
      () => {
        throw new Error('unexpected');
      },
    ]);

    const promise = executeWithRateLimit(
      [() => appleApiRequest(credentials, '/apps')],
      { concurrency: 1, maxRetries: 5, retryDelay: 100 }
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'RateLimitError',
      originalError: { status: 503, retryable: false },
    });
    await settle(promise);
    await assertion;
    expect(calls).toHaveLength(1);
  });

  it('does not retry outside the client once Apple reports 0 remaining', async () => {
    const { calls } = mockFetch([
      jsonResponse(429, appleError(429, 'RATE_LIMIT_EXCEEDED', 'Too many'), {
        'X-Rate-Limit': 'user-hour-lim:3600;user-hour-rem:0;',
      }),
    ]);

    const promise = executeWithRateLimit(
      [() => appleApiRequest(credentials, '/apps')],
      { concurrency: 1, maxRetries: 5, retryDelay: 100 }
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'RateLimitError',
      originalError: { statusCode: 429, attempts: 1 },
    });
    await settle(promise);
    await assertion;
    expect(calls).toHaveLength(1);
  });
});

describe('appleApiRequest rate-limit tracking and budget', () => {
  it('exposes X-Rate-Limit remaining via callback, budget and getter', async () => {
    mockFetch([
      jsonResponse(200, { data: [] }, { 'X-Rate-Limit': 'user-hour-lim:3600;user-hour-rem:123;' }),
    ]);
    const budget = new RequestBudget();
    const onRateLimit = vi.fn();

    await appleApiRequest(credentials, '/apps', { budget, onRateLimit });

    expect(onRateLimit).toHaveBeenCalledWith({ limit: 3600, remaining: 123 });
    expect(budget.upstreamRemainingCount).toBe(123);
    expect(budget.used).toBe(1);
    expect(getAppleRateLimitInfo(credentials)).toMatchObject({ limit: 3600, remaining: 123 });
  });

  it('throws BUDGET_EXCEEDED before fetch once the budget is spent', async () => {
    const { fetchMock } = mockFetch([jsonResponse(200, { data: [] })]);
    const budget = new RequestBudget({ limit: 1 });

    await appleApiRequest(credentials, '/apps', { budget });
    await expect(appleApiRequest(credentials, '/apps', { budget })).rejects.toMatchObject({
      status: 429,
      code: 'BUDGET_EXCEEDED',
      platform: 'apple',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops the run once Apple reports 0 remaining', async () => {
    const { fetchMock } = mockFetch([
      jsonResponse(200, { data: [] }, { 'X-Rate-Limit': 'user-hour-lim:3600;user-hour-rem:0;' }),
    ]);
    const budget = new RequestBudget();

    await appleApiRequest(credentials, '/apps', { budget });
    await expect(appleApiRequest(credentials, '/apps', { budget })).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts retries against the budget', async () => {
    const { fetchMock } = mockFetch([
      jsonResponse(503, appleError(503, 'UNAVAILABLE', 'down')),
      jsonResponse(200, { data: [] }),
    ]);
    const budget = new RequestBudget({ limit: 1 });

    const promise = appleApiRequest(credentials, '/apps', { budget });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await settle(promise);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
