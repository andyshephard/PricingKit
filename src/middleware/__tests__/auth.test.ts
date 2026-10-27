import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  APPLE_LONG_MIN_REMAINING_SECONDS,
  checkAppleToken,
  hasStoreTokenHeader,
  readUserOerKey,
  requireAppleAuth,
  requireGoogleAuth,
} from '../auth';
import { appleHeaders, googleHeaders, testAppleToken, TEST_APPLE_ISSUER_ID, TEST_APPLE_KEY_ID, TEST_GOOGLE_TOKEN } from '@/app/api/__tests__/helpers';

const now = () => Math.floor(Date.now() / 1000);

function request(method: string, headers: Record<string, string>) {
  return new Request('http://localhost/api/x', { method, headers });
}

async function failure(result: { ok: boolean; response?: Response }) {
  expect(result.ok).toBe(false);
  const response = result.response!;
  return { status: response.status, body: (await response.json()) as { error: string; code: string }, date: response.headers.get('date') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkAppleToken (shape checks only, nothing verified)', () => {
  it('accepts a 20-minute ES256 token for App Store Connect and returns its claims', () => {
    const iat = now();
    const result = checkAppleToken(testAppleToken({ iat }), iat);
    expect(result).toEqual({ ok: true, claims: { kid: TEST_APPLE_KEY_ID, iss: TEST_APPLE_ISSUER_ID, iat, exp: iat + 1200 } });
  });

  it.each([
    ['two parts', 'a.b'],
    ['four parts', 'a.b.c.d'],
    ['non-base64url characters', 'a+b.c.d'],
    ['a part that is not JSON', 'bm90IGpzb24.e30.sig'],
    ['an array header', `${Buffer.from('[]').toString('base64url')}.e30.sig`],
  ])('refuses %s', (_name, token) => {
    expect(checkAppleToken(token, now())).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
  });

  it.each([
    ['alg other than ES256', { header: { alg: 'none' } }],
    ['no key ID', { header: { kid: undefined } }],
    ['a key ID with odd characters', { header: { kid: 'KEY ID' } }],
    ['the wrong audience', { claims: { aud: 'appstoreconnect-v2' } }],
    ['no issuer', { claims: { iss: undefined } }],
    ['a lifetime over 20 minutes', { ttl: 20 * 60 + 1 }],
    ['exp before iat', { ttl: -5 }],
    ['non-numeric times', { claims: { iat: 'now' } }],
  ])('refuses %s', (_name, options) => {
    expect(checkAppleToken(testAppleToken(options), now())).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
  });

  it('refuses an expired token, and one with too little time left for a long request', () => {
    const iat = now() - 20 * 60;
    expect(checkAppleToken(testAppleToken({ iat }), now())).toMatchObject({ ok: false, code: 'TOKEN_EXPIRED' });
    const t = now();
    const halfway = testAppleToken({ iat: t - 15 * 60 });
    expect(checkAppleToken(halfway, t)).toMatchObject({ ok: true });
    expect(checkAppleToken(halfway, t, APPLE_LONG_MIN_REMAINING_SECONDS)).toMatchObject({ ok: false, code: 'TOKEN_TOO_SHORT' });
    expect(checkAppleToken(testAppleToken({ iat: t }), t, APPLE_LONG_MIN_REMAINING_SECONDS)).toMatchObject({ ok: true });
  });

  it('refuses a token over the header size cap', () => {
    expect(checkAppleToken(testAppleToken({ claims: { pad: 'x'.repeat(5000) } }), now())).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
  });
});

describe('requireAppleAuth', () => {
  it('builds a connection from the headers, labelled by non-secret IDs only', async () => {
    const token = testAppleToken();
    const result = requireAppleAuth(request('GET', appleHeaders('com.example.test', token)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.bundleId).toBe('com.example.test');
    expect(result.connection.tokens.platform).toBe('apple');
    expect(result.connection.tokens.label).toBe(`${TEST_APPLE_ISSUER_ID}:${TEST_APPLE_KEY_ID}`);
    expect(await result.connection.tokens.getToken()).toBe(token);
    // Logging or serialising the connection never shows the token
    expect(JSON.stringify(result.connection)).not.toContain(token.split('.')[2]);
  });

  it('answers 401 with the server time when the token is missing or unusable', async () => {
    const missing = await failure(requireAppleAuth(request('GET', { 'x-pk-app': 'com.example.test' })));
    expect(missing).toMatchObject({ status: 401, body: { code: 'NOT_AUTHENTICATED' } });
    expect(Date.parse(missing.date!)).toBeGreaterThan(0);

    const malformed = await failure(requireAppleAuth(request('GET', appleHeaders('com.example.test', 'junk'))));
    expect(malformed).toMatchObject({ status: 401, body: { code: 'INVALID_TOKEN' } });
    expect(malformed.date).toBeTruthy();
  });

  it('refuses a token with under 10 minutes left on writes (TOKEN_TOO_SHORT), but not on reads', async () => {
    const aging = testAppleToken({ iat: now() - 12 * 60 });
    expect(requireAppleAuth(request('GET', appleHeaders('com.example.test', aging))).ok).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const result = await failure(requireAppleAuth(request(method, appleHeaders('com.example.test', aging))));
      expect(result).toMatchObject({ status: 401, body: { code: 'TOKEN_TOO_SHORT' } });
      expect(result.date).toBeTruthy();
    }
    // A long read (export) can ask for the same check; a short write can opt out
    expect(requireAppleAuth(request('GET', appleHeaders('com.example.test', aging)), { long: true }).ok).toBe(false);
    expect(requireAppleAuth(request('POST', appleHeaders(null, aging)), { app: 'none', long: false }).ok).toBe(true);
  });

  it('needs a valid X-PK-App unless told otherwise', async () => {
    expect(await failure(requireAppleAuth(request('GET', appleHeaders(null))))).toMatchObject({ status: 400, body: { code: 'APP_REQUIRED' } });
    expect(await failure(requireAppleAuth(request('GET', appleHeaders('not a bundle id'))))).toMatchObject({ status: 400, body: { code: 'INVALID_APP' } });
    expect(await failure(requireAppleAuth(request('GET', appleHeaders('x'.repeat(200)))))).toMatchObject({ status: 400 });
    const none = requireAppleAuth(request('GET', appleHeaders(null)), { app: 'none' });
    expect(none.ok && none.connection.bundleId).toBe('');
  });

  it('never logs', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    requireAppleAuth(request('GET', appleHeaders()));
    requireAppleAuth(request('POST', appleHeaders('com.example.test', 'junk')));
    requireGoogleAuth(request('GET', googleHeaders()));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('requireGoogleAuth', () => {
  it('wraps the access token with a fixed label', async () => {
    const result = requireGoogleAuth(request('POST', googleHeaders('com.example.app')));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.packageName).toBe('com.example.app');
    expect(result.tokens.platform).toBe('google');
    expect(result.tokens.label).not.toContain(TEST_GOOGLE_TOKEN);
    expect(await result.tokens.getToken()).toBe(TEST_GOOGLE_TOKEN);
  });

  it('refuses a missing, short, oversized or non-printable token with 401', async () => {
    for (const headers of [
      { 'x-pk-app': 'com.example.app' },
      googleHeaders('com.example.app', 'short'),
      googleHeaders('com.example.app', 'y'.repeat(5000)),
      googleHeaders('com.example.app', 'ya29.has\u0001control-chars-in-it'),
    ]) {
      const result = await failure(requireGoogleAuth(request('GET', headers)));
      expect(result.status).toBe(401);
      expect(result.date).toBeTruthy();
    }
  });

  it('needs a valid package name unless told otherwise', async () => {
    expect(await failure(requireGoogleAuth(request('GET', googleHeaders(null))))).toMatchObject({ status: 400, body: { code: 'APP_REQUIRED' } });
    expect(await failure(requireGoogleAuth(request('GET', googleHeaders('../../evil'))))).toMatchObject({ status: 400, body: { code: 'INVALID_APP' } });
    expect(requireGoogleAuth(request('GET', googleHeaders(null)), { app: 'none' }).ok).toBe(true);
  });
});

describe('optional headers on public endpoints', () => {
  it('hasStoreTokenHeader accepts a well-formed live token of either store only', () => {
    expect(hasStoreTokenHeader(request('GET', {}))).toBe(false);
    expect(hasStoreTokenHeader(request('GET', appleHeaders(null)))).toBe(true);
    expect(hasStoreTokenHeader(request('GET', googleHeaders(null)))).toBe(true);
    expect(hasStoreTokenHeader(request('GET', appleHeaders(null, testAppleToken({ iat: now() - 3600 }))))).toBe(false);
    expect(hasStoreTokenHeader(request('GET', { 'x-pk-google-token': 'tiny' }))).toBe(false);
  });

  it('readUserOerKey returns a well-formed app ID only', () => {
    expect(readUserOerKey(request('GET', { 'x-pk-oer-key': '0123456789abcdef0123456789abcdef' }))).toBe('0123456789abcdef0123456789abcdef');
    expect(readUserOerKey(request('GET', { 'x-pk-oer-key': 'app_id=1&x=2' }))).toBeUndefined();
    expect(readUserOerKey(request('GET', {}))).toBeUndefined();
  });
});
