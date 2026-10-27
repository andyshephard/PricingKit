import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import {
  AppleKeyTokenSource,
  GoogleKeyTokenSource,
  HeaderTokenSource,
  MAX_HEADER_TOKEN_CHARS,
  appleKeyConnection,
} from '../token-source';
import { appleApiRequest, AppleApiError, clearTokenCache, getAppIdForBundleId } from '../apple-connect/client';
import { clearGoogleAccessTokenCache, googlePlayFetch, GooglePlayApiError } from '../google-play/client';
import { AppleAdapter } from '../adapters/apple';
import { PlayAdapter } from '../adapters/play';

// Throwaway keys generated per run; no real credentials involved
let applePem: string;
let applePublicKey: CryptoKey;
let googlePem: string;

function pem(der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

const appleKey = () => ({
  privateKey: applePem,
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.app',
});

const googleKey = () => ({
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'test-key-id',
  private_key: googlePem,
  client_email: 'robot@test-project.iam.gserviceaccount.com',
});

const decodePart = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Everything a source would print if logged or serialised */
const printed = (source: object) => `${JSON.stringify(source)}\n${inspect(source, { showHidden: true, depth: 5 })}`;

beforeAll(async () => {
  const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  applePem = pem(await crypto.subtle.exportKey('pkcs8', ec.privateKey));
  applePublicKey = ec.publicKey;
  const rsa = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  googlePem = pem(await crypto.subtle.exportKey('pkcs8', rsa.privateKey));
});

beforeEach(() => {
  clearTokenCache();
  clearGoogleAccessTokenCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AppleKeyTokenSource', () => {
  it('signs a 20-minute ES256 JWT for App Store Connect', async () => {
    const source = new AppleKeyTokenSource(appleKey());
    const token = await source.getToken();
    const [header, payload, signature] = token.split('.');

    expect(decodePart(header)).toEqual({ alg: 'ES256', kid: 'TESTKEY123', typ: 'JWT' });
    const claims = decodePart(payload);
    expect(claims).toMatchObject({ iss: '00000000-0000-0000-0000-000000000000', aud: 'appstoreconnect-v1' });
    expect(claims.exp - claims.iat).toBe(20 * 60);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      applePublicKey,
      Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(`${header}.${payload}`)
    );
    expect(valid).toBe(true);
  });

  it('reuses the in-process cache', async () => {
    const token = await new AppleKeyTokenSource(appleKey()).getToken();
    expect(await new AppleKeyTokenSource(appleKey()).getToken()).toBe(token);
  });

  it('labels itself with non-secret IDs and never prints the key', () => {
    const source = new AppleKeyTokenSource(appleKey());
    expect(source.platform).toBe('apple');
    expect(source.label).toBe('00000000-0000-0000-0000-000000000000:TESTKEY123');
    const body = applePem.split('\n')[1];
    expect(printed(source)).not.toContain(body);
    expect(printed(source)).not.toContain('PRIVATE KEY');
  });

  it('appleKeyConnection keeps the bundle ID beside the token source', () => {
    const connection = appleKeyConnection(appleKey());
    expect(connection.bundleId).toBe('com.example.app');
    expect(connection.tokens).toBeInstanceOf(AppleKeyTokenSource);
    expect(printed(connection)).not.toContain('PRIVATE KEY');
  });
});

describe('GoogleKeyTokenSource', () => {
  it('mints an access token once and reuses it', async () => {
    const fetchMock = vi.fn(async () => json(200, { access_token: 'ya29.test-token', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);
    const source = new GoogleKeyTokenSource(googleKey());

    expect(await source.getToken()).toBe('ya29.test-token');
    expect(await source.getToken()).toBe('ya29.test-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://oauth2.googleapis.com/token');
  });

  it('a rejected key surfaces as GooglePlayApiError 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: 'invalid_grant' })));
    await expect(new GoogleKeyTokenSource(googleKey()).getToken()).rejects.toMatchObject({ name: 'GooglePlayApiError', code: 401 });
  });

  it('labels itself with the client email and never prints the key', () => {
    const source = new GoogleKeyTokenSource(googleKey());
    expect(source.platform).toBe('google');
    expect(source.label).toBe('robot@test-project.iam.gserviceaccount.com');
    expect(printed(source)).not.toContain(googlePem.split('\n')[1]);
    expect(printed(source)).not.toContain('PRIVATE KEY');
  });
});

describe('HeaderTokenSource', () => {
  it('returns the token it was given', async () => {
    const source = new HeaderTokenSource('apple', 'eyJ.header.token', 'browser key');
    expect(source.platform).toBe('apple');
    expect(source.label).toBe('browser key');
    expect(await source.getToken()).toBe('eyJ.header.token');
  });

  it('never prints the token', () => {
    const source = new HeaderTokenSource('google', 'ya29.secret-access-token', 'robot@example.com');
    expect(printed(source)).not.toContain('secret-access-token');
  });

  it('refuses tokens that are empty, too long or not one header value', () => {
    expect(() => new HeaderTokenSource('apple', '', 'l')).toThrow('Token is empty');
    expect(() => new HeaderTokenSource('apple', 'a'.repeat(MAX_HEADER_TOKEN_CHARS + 1), 'l')).toThrow('Token is too long');
    expect(() => new HeaderTokenSource('apple', 'a b', 'l')).toThrow('invalid characters');
    expect(() => new HeaderTokenSource('apple', 'a\r\nX-Injected: 1', 'l')).toThrow('invalid characters');
    expect(() => new HeaderTokenSource('other' as 'apple', 'abc', 'l')).toThrow('Unknown token platform');
    expect(() => new HeaderTokenSource('google', 'a'.repeat(MAX_HEADER_TOKEN_CHARS), 'l')).not.toThrow();
  });
});

describe('store clients take any TokenSource', () => {
  it('appleApiRequest sends the source token as the bearer', async () => {
    const fetchMock = vi.fn(async () => json(200, { data: [{ id: '1', attributes: { bundleId: 'com.example.app', name: 'App' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const connection = { tokens: new HeaderTokenSource('apple', 'header-jwt', 'browser'), bundleId: 'com.example.app' };

    await expect(getAppIdForBundleId(connection)).resolves.toBe('1');
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer header-jwt');
  });

  it('an Apple 401 for a caller token is the usual AppleApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'Authentication credentials are missing or invalid.', detail: 'Provide a properly configured and signed bearer token' }] })));
    const connection = { tokens: new HeaderTokenSource('apple', 'expired-jwt', 'browser'), bundleId: 'com.example.app' };

    const error = await appleApiRequest(connection, '/apps').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppleApiError);
    expect(error).toMatchObject({ statusCode: 401, status: 401, code: 'NOT_AUTHORIZED', platform: 'apple', retryable: false });
  });

  it('googlePlayFetch sends the source token and never calls the token endpoint', async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(googlePlayFetch(new HeaderTokenSource('google', 'ya29.header', 'robot'), '/x')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://androidpublisher.googleapis.com/x');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.header');
  });

  it('a Google 401 for a caller token is the usual GooglePlayApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } })));

    const error = await googlePlayFetch(new HeaderTokenSource('google', 'ya29.expired', 'robot'), '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GooglePlayApiError);
    expect(error).toMatchObject({ code: 401, status: 401, googleStatus: 'UNAUTHENTICATED', platform: 'google' });
  });

  it('a token source that fails is not retried as a network error', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const failing = {
      platform: 'google' as const,
      label: 'robot',
      getToken: vi.fn(async () => {
        throw new GooglePlayApiError({ code: 401, message: 'Failed to obtain Google access token', retryable: false });
      }),
    };

    await expect(googlePlayFetch(failing, '/x')).rejects.toMatchObject({ code: 401 });
    expect(failing.getToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('adapters take a token source and the app separately', () => {
  it('AppleAdapter checks plans against its bundle ID', () => {
    const adapter = new AppleAdapter({ tokens: new HeaderTokenSource('apple', 'jwt', 'browser'), bundleId: 'com.example.app' });
    expect(() => adapter.verifyApp({ bundleId: 'com.example.app' })).not.toThrow();
    expect(() => adapter.verifyApp({ bundleId: 'com.example.other' })).toThrow(/com\.example\.other/);
  });

  it('PlayAdapter checks plans against its package name', () => {
    const adapter = new PlayAdapter({ tokens: new HeaderTokenSource('google', 'ya29.x', 'robot'), packageName: 'com.example.app' });
    expect(() => adapter.verifyApp({ packageName: 'com.example.app' })).not.toThrow();
    expect(() => adapter.verifyApp({ packageName: 'com.example.other' })).toThrow(/com\.example\.other/);
  });
});
