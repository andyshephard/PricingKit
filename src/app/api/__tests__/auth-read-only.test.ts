import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createCookieStore, type TestCookieStore } from './helpers';

let cookieStore: TestCookieStore;
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

import { POST as authPOST } from '../auth/route';
import { POST as activeAppPOST } from '../active-app/route';
import { createSession, clearGoogleAccessTokenCache } from '@/lib/google-play/client';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';

async function makePem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const b64 = Buffer.from(pkcs8).toString('base64');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

let credentials: ServiceAccountCredentials;
let fetchMock: ReturnType<typeof vi.fn>;

// Fake Google: token endpoint + list endpoints that return one product/subscription,
// so the old write probe would have had something to PATCH.
function installFetch() {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'test-token', expires_in: 3600 });
    }
    if ((init?.method ?? 'GET') !== 'GET') {
      return Response.json({}, { status: 200 });
    }
    if (url.includes('/oneTimeProducts')) {
      return Response.json({ oneTimeProducts: [{ productId: 'p1' }] });
    }
    if (url.includes('/subscriptions')) {
      return Response.json({ subscriptions: [{ productId: 's1' }] });
    }
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function nonGetCalls() {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return false;
    return ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET';
  });
}

describe('login and app switch never write to the store', () => {
  beforeAll(async () => {
    credentials = {
      type: 'service_account',
      project_id: 'test-project',
      private_key_id: 'kid',
      private_key: await makePem(),
      client_email: 'svc@test-project.iam.gserviceaccount.com',
      client_id: '1',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: 'https://example.invalid/cert',
    } as ServiceAccountCredentials;
  });

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', 'test-encryption-key-at-least-32-characters');
    clearGoogleAccessTokenCache();
    cookieStore = createCookieStore();
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('POST /api/auth only issues GET requests to Google Play', async () => {
    const req = new NextRequest('http://localhost/api/auth', {
      method: 'POST',
      body: JSON.stringify({ credentials, packageName: 'com.example.app' }),
    });
    const res = await authPOST(req);

    expect(res.status).toBe(200);
    expect(nonGetCalls()).toEqual([]);
    expect(cookieStore.jar.has('gplay_session')).toBe(true);
  });

  it('POST /api/active-app only issues GET requests to Google Play', async () => {
    cookieStore = createCookieStore({ gplay_session: await createSession(credentials) });
    const req = new NextRequest('http://localhost/api/active-app', {
      method: 'POST',
      body: JSON.stringify({ packageName: 'com.example.other' }),
    });
    const res = await activeAppPOST(req);

    expect(res.status).toBe(200);
    expect(nonGetCalls()).toEqual([]);
    expect(cookieStore.jar.get('gplay_package_name')).toBe('com.example.other');
  });

  it('POST /api/auth does not leak raw error messages on 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('internal detail: /srv/secret/path');
      })
    );
    const req = new NextRequest('http://localhost/api/auth', {
      method: 'POST',
      body: JSON.stringify({ credentials, packageName: 'com.example.app' }),
    });
    const res = await authPOST(req);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('internal detail');
    expect(body.error).toBe('Failed to authenticate. Please try again.');
  });

  it('POST /api/auth explains a missing ENCRYPTION_KEY outside next dev', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    const req = new NextRequest('http://localhost/api/auth', {
      method: 'POST',
      body: JSON.stringify({ credentials, packageName: 'com.example.app' }),
    });
    const res = await authPOST(req);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toMatch(/ENCRYPTION_KEY/);
    expect(cookieStore.jar.has('gplay_session')).toBe(false);
  });
});
