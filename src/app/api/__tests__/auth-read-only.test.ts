// The connect checks and app switches: read-only store calls with the token
// from the header, no key handling, no cookies.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { appleHeaders, googleHeaders, testAppleToken, TEST_APPLE_ISSUER_ID, TEST_APPLE_KEY_ID, TEST_GOOGLE_TOKEN } from './helpers';

import { POST as authPOST } from '../auth/route';
import { POST as activeAppPOST } from '../active-app/route';
import { POST as appleAuthPOST } from '../apple/auth/route';
import { POST as appleActiveAppPOST } from '../apple/active-app/route';
import { GET as appleAppsGET } from '../apple/apps/route';

let fetchMock: ReturnType<typeof vi.fn>;

// Fake stores: list endpoints that return one item, so a write probe would have had something to PATCH
function installFetch() {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') !== 'GET') return Response.json({}, { status: 200 });
    if (url.includes('api.appstoreconnect.apple.com')) {
      return Response.json({ data: [{ id: '1', type: 'apps', attributes: { name: 'Example', bundleId: 'com.example.test', sku: 'EX' } }], links: {} });
    }
    if (url.includes('/subscriptions')) return Response.json({ subscriptions: [{ productId: 's1' }] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function nonGetCalls() {
  return fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET');
}

function authorizationHeaders(): string[] {
  return fetchMock.mock.calls.map(([, init]) => new Headers((init as RequestInit | undefined)?.headers).get('authorization') ?? '');
}

function post(url: string, headers: Record<string, string>, body?: unknown) {
  return new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

beforeEach(() => {
  installFetch();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Google Play connect check and app switch', () => {
  it('POST /api/auth makes one read-only call with the header token and sets no cookie', async () => {
    const res = await authPOST(post('http://localhost/api/auth', googleHeaders('com.example.app')));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, packageName: 'com.example.app' });
    expect(nonGetCalls()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authorizationHeaders()).toEqual([`Bearer ${TEST_GOOGLE_TOKEN}`]);
    // The server never mints Google tokens
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('oauth2.googleapis.com'))).toBe(false);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('POST /api/auth needs the token and the app', async () => {
    const noToken = await authPOST(post('http://localhost/api/auth', { 'x-pk-app': 'com.example.app' }));
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('date')).toBeTruthy();
    const noApp = await authPOST(post('http://localhost/api/auth', googleHeaders(null)));
    expect(noApp.status).toBe(400);
    expect((await noApp.json()).code).toBe('APP_REQUIRED');
    const badApp = await authPOST(post('http://localhost/api/auth', googleHeaders('not a package')));
    expect(badApp.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/auth maps Google refusing the token to a 401 the browser can retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 401, message: 'Request had invalid authentication credentials.' } }, { status: 401 })));
    const res = await authPOST(post('http://localhost/api/auth', googleHeaders()));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('INVALID_TOKEN');
    expect(res.headers.get('date')).toBeTruthy();
  });

  it('POST /api/auth does not leak raw error messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('internal detail: /srv/secret/path');
      })
    );
    const res = await authPOST(post('http://localhost/api/auth', googleHeaders()));
    const body = await res.json();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(body)).not.toContain('internal detail');
  });

  it('POST /api/active-app only reads, and stores nothing', async () => {
    const res = await activeAppPOST(post('http://localhost/api/active-app', googleHeaders(null), { packageName: 'com.example.other' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, packageName: 'com.example.other' });
    expect(nonGetCalls()).toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/applications/com.example.other/');
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('App Store Connect connect check and app switch', () => {
  it('POST /api/apple/auth lists the apps with the header token and returns only non-secret IDs', async () => {
    const token = testAppleToken();
    const res = await appleAuthPOST(post('http://localhost/api/apple/auth', appleHeaders(null, token)));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      keyId: TEST_APPLE_KEY_ID,
      issuerId: TEST_APPLE_ISSUER_ID,
      apps: [{ id: '1', name: 'Example', bundleId: 'com.example.test', sku: 'EX' }],
    });
    expect(nonGetCalls()).toEqual([]);
    // The browser's token, forwarded as is: the server signs nothing
    expect(authorizationHeaders()).toEqual([`Bearer ${token}`]);
    expect(res.headers.get('date')).toBeTruthy();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('POST /api/apple/auth refuses a malformed, too long-lived or expired token before calling Apple', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [token, code] of [
      ['not-a-jwt', 'INVALID_TOKEN'],
      [testAppleToken({ ttl: 21 * 60 }), 'INVALID_TOKEN'],
      [testAppleToken({ header: { alg: 'HS256' } }), 'INVALID_TOKEN'],
      [testAppleToken({ claims: { aud: 'something-else' } }), 'INVALID_TOKEN'],
      [testAppleToken({ iat: now - 30 * 60 }), 'TOKEN_EXPIRED'],
    ] as const) {
      const res = await appleAuthPOST(post('http://localhost/api/apple/auth', appleHeaders(null, token)));
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe(code);
      expect(res.headers.get('date')).toBeTruthy();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/apple/auth maps Apple refusing the token to a 401 with the server time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ errors: [{ status: '401', code: 'NOT_AUTHORIZED', detail: 'no' }] }, { status: 401 })));
    const res = await appleAuthPOST(post('http://localhost/api/apple/auth', appleHeaders(null)));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('INVALID_TOKEN');
    expect(res.headers.get('date')).toBeTruthy();
  });

  it('GET /api/apple/apps needs only the token', async () => {
    const res = await appleAppsGET(new NextRequest('http://localhost/api/apple/apps', { headers: appleHeaders(null) }));
    expect(res.status).toBe(200);
    expect((await res.json()).apps).toHaveLength(1);
    const anonymous = await appleAppsGET(new NextRequest('http://localhost/api/apple/apps'));
    expect(anonymous.status).toBe(401);
  });

  it('POST /api/apple/active-app checks the app is visible, and stores nothing', async () => {
    const res = await appleActiveAppPOST(post('http://localhost/api/apple/active-app', appleHeaders(null), { bundleId: 'com.example.test' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bundleId: 'com.example.test' });
    expect(nonGetCalls()).toEqual([]);
    expect(res.headers.get('set-cookie')).toBeNull();

    const missing = await appleActiveAppPOST(post('http://localhost/api/apple/active-app', appleHeaders(null), { bundleId: 'com.example.gone' }));
    expect(missing.status).toBe(404);
  });
});
