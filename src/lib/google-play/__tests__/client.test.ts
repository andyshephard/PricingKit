import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  clearGoogleAccessTokenCache,
  getGoogleAccessToken,
  googlePlayFetch,
  GooglePlayApiError,
} from '../client';
import type { ServiceAccountCredentials } from '../types';
import { ApiError } from '@/lib/utils/api-error';
import { RequestBudget } from '@/lib/utils/request-budget';
import { executeWithRateLimit } from '@/lib/utils/rate-limit';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

let credentials: ServiceAccountCredentials;

// Throwaway RSA key generated per run; no real credentials involved
async function generateTestCredentials(): Promise<ServiceAccountCredentials> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`;
  return {
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'test-key-id',
    private_key: pem,
    client_email: 'test@test-project.iam.gserviceaccount.com',
    client_id: '1',
    auth_uri: 'https://example.invalid/auth',
    token_uri: TOKEN_ENDPOINT,
    auth_provider_x509_cert_url: 'https://example.invalid/certs',
    client_x509_cert_url: 'https://example.invalid/cert',
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function googleError(code: number, message: string, status = 'ERROR') {
  return { error: { code, message, status, errors: [{ reason: 'test', message }] } };
}

/**
 * Mock fetch: token endpoint always succeeds; API calls are served from `apiResponses`
 * in order (a function entry may throw to simulate a network error).
 */
function mockFetch(apiResponses: Array<Response | (() => Response)>) {
  const apiCalls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === TOKEN_ENDPOINT) {
      return jsonResponse(200, { access_token: 'test-token', expires_in: 3600 });
    }
    apiCalls.push(url);
    const next = apiResponses.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    return typeof next === 'function' ? next() : next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, apiCalls };
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

/**
 * Let real async work run (without moving fake time) until `calls` reaches
 * `count`. Credential hashing/signing may run on Node's thread pool, so a
 * fixed number of flushes is not enough under load.
 */
async function untilCalls(calls: unknown[], count: number): Promise<void> {
  for (let i = 0; i < 10_000 && calls.length < count; i++) await flush();
}

/** Advance fake timers by ms, letting real async work run first */
async function advance(ms: number): Promise<void> {
  for (let i = 0; i < 20; i++) await flush();
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) await flush();
}

/**
 * Let real async work run (without moving fake time) until the client is
 * sleeping before its next attempt. Asserts that exactly one timer is pending
 * and that no further request goes out until `ms` has passed, then fires it.
 * This proves the backoff really waited instead of retrying straight away.
 */
async function expectBackoff(calls: unknown[], ms: number): Promise<void> {
  for (let i = 0; i < 10_000 && vi.getTimerCount() === 0; i++) await flush();
  expect(vi.getTimerCount()).toBe(1);
  const before = calls.length;
  await advance(ms - 1);
  expect(calls).toHaveLength(before);
  expect(vi.getTimerCount()).toBe(1);
  await advance(1);
}

/** Let the promise settle, asserting no timer is left pending (no hidden sleep) */
async function finish(promise: Promise<unknown>): Promise<void> {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 10_000 && !done; i++) await flush();
  expect(done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
}

beforeAll(async () => {
  credentials = await generateTestCredentials();
});

beforeEach(() => {
  clearGoogleAccessTokenCache();
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

describe('googlePlayFetch retries', () => {
  it('retries 429 then 503 using the error code and succeeds', async () => {
    const { apiCalls } = mockFetch([
      jsonResponse(429, googleError(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED')),
      jsonResponse(503, googleError(503, 'Backend error', 'UNAVAILABLE')),
      jsonResponse(200, { ok: true }),
    ]);

    const promise = googlePlayFetch<{ ok: boolean }>(credentials, '/test');
    // Math.random = 0.5 -> backoff of exactly 1000ms then 2000ms
    await expectBackoff(apiCalls, 1_000);
    await expectBackoff(apiCalls, 2_000);
    await finish(promise);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(apiCalls).toHaveLength(3);
  });

  it('does not retry a 400 and throws GooglePlayApiError with numeric code', async () => {
    const { apiCalls } = mockFetch([
      jsonResponse(400, googleError(400, 'Invalid price', 'INVALID_ARGUMENT')),
    ]);

    const promise = googlePlayFetch(credentials, '/test');
    const assertion = expect(promise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GooglePlayApiError);
      expect(err).toBeInstanceOf(ApiError);
      const e = err as GooglePlayApiError;
      expect(e.code).toBe(400);
      expect(e.status).toBe(400);
      expect(e.platform).toBe('google');
      expect(e.retryable).toBe(false);
      expect(e.message).toBe('Invalid price');
      expect(e.googleStatus).toBe('INVALID_ARGUMENT');
      expect(e.errors[0].reason).toBe('test');
      return true;
    });
    await settle(promise);
    await assertion;
    expect(apiCalls).toHaveLength(1);
  });

  it('honours Retry-After before retrying', async () => {
    const { apiCalls } = mockFetch([
      jsonResponse(429, googleError(429, 'Slow down'), { 'Retry-After': '5' }),
      jsonResponse(200, { ok: true }),
    ]);
    // Mint the token up front so timing only covers the API calls
    await getGoogleAccessToken(credentials);

    const promise = googlePlayFetch(credentials, '/test');
    await untilCalls(apiCalls, 1);
    await advance(4_900);
    expect(apiCalls).toHaveLength(1);
    await advance(200);
    await untilCalls(apiCalls, 2);
    expect(apiCalls).toHaveLength(2);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('with retryOnlyRateLimited, retries 429 but never resends after a 5xx or a network error', async () => {
    const rate = mockFetch([jsonResponse(429, googleError(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED')), jsonResponse(200, { ok: true })]);
    const ok = googlePlayFetch(credentials, '/offers', { method: 'POST', body: {}, retryOnlyRateLimited: true });
    await expectBackoff(rate.apiCalls, 1_000);
    await finish(ok);
    await expect(ok).resolves.toEqual({ ok: true });
    expect(rate.apiCalls).toHaveLength(2);

    const server = mockFetch([jsonResponse(503, googleError(503, 'Backend error', 'UNAVAILABLE'))]);
    const failed = googlePlayFetch(credentials, '/offers', { method: 'POST', body: {}, retryOnlyRateLimited: true });
    const assertion = expect(failed).rejects.toMatchObject({ code: 503, retryable: false, attempts: 1 });
    await settle(failed);
    await assertion;
    expect(server.apiCalls).toHaveLength(1);

    const network = mockFetch([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const lost = googlePlayFetch(credentials, '/offers', { method: 'POST', body: {}, retryOnlyRateLimited: true });
    const lostAssertion = expect(lost).rejects.toMatchObject({ retryable: false, attempts: 1 });
    await settle(lost);
    await lostAssertion;
    expect(network.apiCalls).toHaveLength(1);
  });

  it('records how many requests a call sent before it failed', async () => {
    const { apiCalls } = mockFetch([jsonResponse(429, googleError(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED')), jsonResponse(400, googleError(400, 'Invalid', 'INVALID_ARGUMENT'))]);
    const promise = googlePlayFetch(credentials, '/offers', { method: 'POST', body: {}, retryOnlyRateLimited: true });
    const assertion = expect(promise).rejects.toMatchObject({ code: 400, attempts: 2 });
    await settle(promise);
    await assertion;
    expect(apiCalls).toHaveLength(2);
  });

  it('retries network errors', async () => {
    const { apiCalls } = mockFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      jsonResponse(200, { ok: true }),
    ]);

    const promise = googlePlayFetch(credentials, '/test');
    await expectBackoff(apiCalls, 1_000);
    await finish(promise);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(apiCalls).toHaveLength(2);
  });

  it('retries a network error from the token endpoint', async () => {
    const { fetchMock, apiCalls } = mockFetch([jsonResponse(200, { ok: true })]);
    const passThrough = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL) => {
      if (String(input) === TOKEN_ENDPOINT) throw new TypeError('fetch failed');
      return passThrough(input);
    });

    const promise = googlePlayFetch(credentials, '/test');
    await expectBackoff(fetchMock.mock.calls, 1_000);
    await finish(promise);
    await expect(promise).resolves.toEqual({ ok: true });
    const tokenCalls = fetchMock.mock.calls.filter(([input]) => String(input) === TOKEN_ENDPOINT);
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls).toHaveLength(1);
  });

  it('does not retry a token endpoint 401 and keeps its shape', async () => {
    const fetchMock = vi.fn(async () => new Response('invalid_grant', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = googlePlayFetch(credentials, '/test');
    const assertion = expect(promise).rejects.toMatchObject({
      code: 401,
      errors: [{ reason: 'invalidCredentials' }],
    });
    await settle(promise);
    await assertion;
    // A real Error (not a plain object), so callers never print "[object Object]"
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GooglePlayApiError);
    expect(String(error)).toMatch(/Failed to obtain Google access token \(400\)/);
    expect((error as GooglePlayApiError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts leaving retryable to follow the status', async () => {
    const { apiCalls } = mockFetch([
      jsonResponse(503, googleError(503, 'down')),
      jsonResponse(503, googleError(503, 'down')),
    ]);

    const promise = googlePlayFetch(credentials, '/test', { retry: { maxAttempts: 2 } });
    const assertion = expect(promise).rejects.toMatchObject({ code: 503, retryable: true });
    await expectBackoff(apiCalls, 1_000);
    // No sleep after the last attempt
    await finish(promise);
    await assertion;
    expect(apiCalls).toHaveLength(2);
  });

  it('leaves a persistent network error retryable so an outer policy can retry it', async () => {
    const networkFailure = () => {
      throw new TypeError('fetch failed');
    };
    const { apiCalls } = mockFetch([networkFailure, networkFailure]);

    const promise = googlePlayFetch(credentials, '/test', { retry: { maxAttempts: 2 } });
    const assertion = expect(promise).rejects.toMatchObject({
      code: 503,
      retryable: true,
      errors: [{ reason: 'networkError' }],
    });
    await expectBackoff(apiCalls, 1_000);
    await finish(promise);
    await assertion;
    expect(apiCalls).toHaveLength(2);
  });

  it('retries a persistent network error from executeWithRateLimit', async () => {
    const networkFailure = () => {
      throw new TypeError('fetch failed');
    };
    // First run: 2 failed inner attempts. Outer retry: 1 failure, then success (4 requests)
    const { apiCalls } = mockFetch([
      networkFailure,
      networkFailure,
      networkFailure,
      jsonResponse(200, { ok: true }),
    ]);

    const promise = executeWithRateLimit(
      [() => googlePlayFetch(credentials, '/test', { retry: { maxAttempts: 2 } })],
      { concurrency: 1, maxRetries: 1, retryDelay: 100 }
    );
    await settle(promise);
    await expect(promise).resolves.toEqual([{ ok: true }]);
    expect(apiCalls).toHaveLength(4);
  });

  it('throws BUDGET_EXCEEDED before sending when the budget is spent', async () => {
    const { apiCalls } = mockFetch([jsonResponse(200, { ok: true })]);
    const budget = new RequestBudget({ limit: 1 });

    await expect(googlePlayFetch(credentials, '/a', { budget })).resolves.toEqual({ ok: true });
    await expect(googlePlayFetch(credentials, '/b', { budget })).rejects.toMatchObject({
      status: 429,
      code: 'BUDGET_EXCEEDED',
      retryable: false,
    });
    expect(apiCalls).toEqual(['https://androidpublisher.googleapis.com/a']);
  });
});
