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
    await settle(promise);
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
    await advance(4_900);
    expect(apiCalls).toHaveLength(1);
    await advance(200);
    expect(apiCalls).toHaveLength(2);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('retries network errors', async () => {
    const { apiCalls } = mockFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      jsonResponse(200, { ok: true }),
    ]);

    const promise = googlePlayFetch(credentials, '/test');
    await settle(promise);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(apiCalls).toHaveLength(2);
  });

  it('gives up after maxAttempts and marks the error non-retryable', async () => {
    const { apiCalls } = mockFetch([
      jsonResponse(503, googleError(503, 'down')),
      jsonResponse(503, googleError(503, 'down')),
    ]);

    const promise = googlePlayFetch(credentials, '/test', { retry: { maxAttempts: 2 } });
    const assertion = expect(promise).rejects.toMatchObject({ code: 503, retryable: false });
    await settle(promise);
    await assertion;
    expect(apiCalls).toHaveLength(2);
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
