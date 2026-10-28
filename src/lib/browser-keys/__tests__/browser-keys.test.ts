import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { APPLE_APPLY_MIN_VALID_SECONDS, BrowserKeys, BrowserKeyError, GOOGLE_APPLY_MIN_VALID_SECONDS, MAX_CLOCK_OFFSET_MS, MemoryKeyStore, type KeyStore } from '..';
import type { KeyPlatform, StoredKey } from '../types';
import { GOOGLE_TOKEN_ENDPOINT, type FetchLike } from '../sign';
import { decodeJwt, jsonResponse, makeAppleKey, makeRsaKey, serviceAccountJson, verifyJwt } from './keys';

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
const T0_SECONDS = T0 / 1000;

let apple: { pem: string; publicKey: CryptoKey };
let google: { pem: string; publicKey: CryptoKey };

beforeAll(async () => {
  apple = await makeAppleKey();
  google = await makeRsaKey(2048);
});

function setup(options: { store?: KeyStore; fetch?: Mock<FetchLike> } = {}) {
  let now = T0;
  const clock = { advance: (seconds: number) => (now += seconds * 1000) };
  let n = 0;
  const fetchMock =
    options.fetch ??
    vi.fn<FetchLike>(async () => {
      n += 1;
      return jsonResponse({ access_token: `ya29.token-${n}`, expires_in: 3599, token_type: 'Bearer' });
    });
  const store = options.store ?? new MemoryKeyStore();
  const keys = new BrowserKeys({ store, fetch: fetchMock, clock: () => now });
  return { keys, store, clock, fetchMock };
}

/** A MemoryKeyStore whose reads and writes can be held, to order races exactly */
function gatedStore() {
  const store = new MemoryKeyStore();
  let readsHeld = false;
  let writesHeld = false;
  const waiting: Array<() => void> = [];
  let writes = 0;
  const hold = <T>(held: boolean, run: () => Promise<T>, isWrite = false): Promise<T> => {
    if (!held) return run();
    if (isWrite) writes += 1;
    return new Promise<void>((resolve) => waiting.push(resolve)).then(run);
  };
  const get = store.get.bind(store);
  const put = store.put.bind(store);
  // A held read takes its value now and delivers it on open(), like a read that was slow to return
  store.get = (platform: KeyPlatform) => {
    const value = get(platform);
    return readsHeld ? hold(true, () => value) : value;
  };
  store.put = (record: StoredKey) => hold(writesHeld, () => put(record), true);
  const del = store.delete.bind(store);
  store.delete = (platform: KeyPlatform) => hold(writesHeld, () => del(platform));
  const gate = {
    close: () => (readsHeld = true),
    closeWrites: () => (writesHeld = true),
    pendingWrites: () => writes,
    open: () => {
      readsHeld = writesHeld = false;
      // Release in arrival order, as IndexedDB applies transactions
      waiting.splice(0).forEach((release) => release());
    },
  };
  return { store, gate };
}

const appleInput = () => ({ privateKeyPem: apple.pem, keyId: 'ABC123DEFG', issuerId: '57246542-96fe-1a63-e053-0824d011072a' });

// Nothing in this module may log: a log line is how key material or tokens leak
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleSpies.push(vi.spyOn(console, method));
});
afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  consoleSpies.splice(0).forEach((spy) => spy.mockRestore());
});

describe('BrowserKeys: Apple', () => {
  it('imports, stores and returns only ids', async () => {
    const { keys, store } = setup();
    const info = await keys.importApple(appleInput());
    expect(info).toEqual({ platform: 'apple', keyId: 'ABC123DEFG', issuerId: '57246542-96fe-1a63-e053-0824d011072a', createdAt: T0 });
    expect(await keys.info('apple')).toEqual(info);
    const record = await store.get('apple');
    expect(record?.key.extractable).toBe(false);
    expect(JSON.stringify(record)).not.toContain('PRIVATE KEY');
  });

  it('signs an ES256 JWT that verifies with the public key', async () => {
    const { keys } = setup();
    await keys.importApple(appleInput());
    const token = await keys.getAppleToken();
    expect(await verifyJwt(token, apple.publicKey)).toBe(true);
    const { header, claims } = decodeJwt(token);
    expect(header).toEqual({ alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
    expect(claims).toEqual({ iss: '57246542-96fe-1a63-e053-0824d011072a', iat: T0_SECONDS, exp: T0_SECONDS + 1200, aud: 'appstoreconnect-v1' });
    // The signature is raw r||s (64 bytes for P-256), the JOSE form
    expect(Buffer.from(token.split('.')[2], 'base64url')).toHaveLength(64);
  });

  it('does not verify with a different key', async () => {
    const { keys } = setup();
    await keys.importApple(appleInput());
    expect(await verifyJwt(await keys.getAppleToken(), (await makeAppleKey()).publicKey)).toBe(false);
  });

  it('reuses the token until under 2 minutes remain, then re-signs', async () => {
    const { keys, clock } = setup();
    await keys.importApple(appleInput());
    const first = await keys.getAppleToken();
    clock.advance(17 * 60);
    expect(await keys.getAppleToken()).toBe(first); // 3 minutes left
    clock.advance(61);
    const second = await keys.getAppleToken(); // under 2 minutes left
    expect(second).not.toBe(first);
    expect(decodeJwt(second).claims.iat).toBe(T0_SECONDS + 17 * 60 + 61);
    expect(await keys.getAppleToken()).toBe(second);
  });

  it('re-signs once for parallel rejections of the same token, and ignores a stale rejection', async () => {
    const { keys, clock } = setup();
    await keys.importApple(appleInput());
    const first = await keys.getAppleToken();
    clock.advance(1);
    const sign = vi.spyOn(crypto.subtle, 'sign');
    const retried = await Promise.all([1, 2, 3].map(() => keys.getAppleToken({ rejected: first })));
    expect(new Set(retried).size).toBe(1);
    expect(retried[0]).not.toBe(first);
    expect(await verifyJwt(retried[0], apple.publicKey)).toBe(true);
    // A 401 for the old token arriving late reuses the new one
    expect(await keys.getAppleToken({ rejected: first })).toBe(retried[0]);
    expect(sign).toHaveBeenCalledTimes(1);
    sign.mockRestore();
  });

  it('re-signs when the token would not outlive minValidSeconds', async () => {
    const { keys, clock } = setup();
    await keys.importApple(appleInput());
    const first = await keys.getAppleToken();
    clock.advance(59); // 1141 s left
    expect(await keys.getAppleToken({ minValidSeconds: APPLE_APPLY_MIN_VALID_SECONDS })).toBe(first);
    clock.advance(2); // 1139 s left
    const second = await keys.getAppleToken({ minValidSeconds: APPLE_APPLY_MIN_VALID_SECONDS });
    expect(second).not.toBe(first);
    // A request for more than a token can give is capped, so a fresh token is reused
    clock.advance(1);
    expect(await keys.getAppleToken({ minValidSeconds: 99_999 })).toBe(second);
  });

  it('signs with the clock offset, and a new offset drops the cached token', async () => {
    const { keys } = setup();
    await keys.importApple(appleInput());
    const first = await keys.getAppleToken();
    keys.setClockOffsetMs(-300_000);
    expect(keys.getClockOffsetMs()).toBe(-300_000);
    const second = await keys.getAppleToken();
    expect(second).not.toBe(first);
    expect(decodeJwt(second).claims.iat).toBe(T0_SECONDS - 300);
    keys.setClockOffsetMs(Number.NaN);
    expect(keys.getClockOffsetMs()).toBe(0);
    keys.setClockOffsetMs(10 * 24 * 3_600_000);
    expect(keys.getClockOffsetMs()).toBe(24 * 3_600_000);
  });

  it('refuses to sign when the correction would be over 10 minutes, until it is back in range', async () => {
    const { keys } = setup();
    await keys.importApple(appleInput());
    keys.setClockOffsetMs(MAX_CLOCK_OFFSET_MS);
    await expect(keys.getAppleToken()).resolves.toBeTruthy();
    keys.setClockOffsetMs(MAX_CLOCK_OFFSET_MS + 1000);
    await expect(keys.getAppleToken()).rejects.toMatchObject({ code: 'clock', message: expect.stringMatching(/clock/) });
    keys.setClockOffsetMs(-3_600_000);
    await expect(keys.getAppleToken()).rejects.toMatchObject({ code: 'clock' });
    await expect(keys.getGoogleAccessToken()).rejects.toMatchObject({ code: 'clock' });
    keys.setClockOffsetMs(0);
    await expect(keys.getAppleToken()).resolves.toBeTruthy();
  });

  it('takes a clock offset in the options', async () => {
    const keys = new BrowserKeys({ store: new MemoryKeyStore(), clock: () => T0, clockOffsetMs: 120_000 });
    await keys.importApple(appleInput());
    expect(decodeJwt(await keys.getAppleToken()).claims.iat).toBe(T0_SECONDS + 120);
  });

  it('shares one signing between concurrent callers', async () => {
    const { keys } = setup();
    await keys.importApple(appleInput());
    const sign = vi.spyOn(crypto.subtle, 'sign');
    const tokens = await Promise.all([keys.getAppleToken(), keys.getAppleToken(), keys.getAppleToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(sign).toHaveBeenCalledTimes(1);
    sign.mockRestore();
  });

  it('a new import replaces the key and its cached token', async () => {
    const { keys } = setup();
    await keys.importApple(appleInput());
    const first = await keys.getAppleToken();
    const other = await makeAppleKey();
    await keys.importApple({ ...appleInput(), privateKeyPem: other.pem, keyId: 'NEWKEY1234' });
    const second = await keys.getAppleToken();
    expect(second).not.toBe(first);
    expect(await verifyJwt(second, other.publicKey)).toBe(true);
    expect(decodeJwt(second).header.kid).toBe('NEWKEY1234');
  });

  it('loads a key stored by an earlier page (same store, new instance)', async () => {
    const { keys, store } = setup();
    await keys.importApple(appleInput());
    const later = new BrowserKeys({ store, clock: () => T0 });
    expect(await verifyJwt(await later.getAppleToken(), apple.publicKey)).toBe(true);
  });
});

describe('BrowserKeys: Google', () => {
  it('imports and returns only ids', async () => {
    const { keys } = setup();
    const info = await keys.importGoogle(JSON.stringify(serviceAccountJson(google.pem)));
    expect(info).toEqual({
      platform: 'google',
      clientEmail: 'pricing@test-project.iam.gserviceaccount.com',
      privateKeyId: 'test-key-id',
      projectId: 'test-project',
      createdAt: T0,
    });
  });

  it('exchanges an RS256 assertion at Google and returns the access token', async () => {
    const { keys, fetchMock } = setup();
    await keys.importGoogle(serviceAccountJson(google.pem));
    expect(await keys.getGoogleAccessToken()).toBe('ya29.token-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    const form = new URLSearchParams(init.body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion')!;
    expect(await verifyJwt(assertion, google.publicKey)).toBe(true);
    const { header, claims } = decodeJwt(assertion);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'test-key-id' });
    expect(claims).toEqual({
      iss: 'pricing@test-project.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: T0_SECONDS,
      exp: T0_SECONDS + 3600,
    });
  });

  it('keeps the access token until 5 minutes before it expires', async () => {
    const { keys, clock, fetchMock } = setup();
    await keys.importGoogle(serviceAccountJson(google.pem));
    await keys.getGoogleAccessToken();
    clock.advance(3599 - 301);
    expect(await keys.getGoogleAccessToken()).toBe('ya29.token-1');
    clock.advance(2);
    expect(await keys.getGoogleAccessToken()).toBe('ya29.token-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('mints one new token for parallel rejections of the same token', async () => {
    const { keys, fetchMock } = setup();
    await keys.importGoogle(serviceAccountJson(google.pem));
    const first = await keys.getGoogleAccessToken();
    const retried = await Promise.all([1, 2, 3].map(() => keys.getGoogleAccessToken({ rejected: first })));
    expect(retried).toEqual(['ya29.token-2', 'ya29.token-2', 'ya29.token-2']);
    expect(await keys.getGoogleAccessToken({ rejected: first })).toBe('ya29.token-2');
    expect(await keys.getGoogleAccessToken({ rejected: 'some-other-token' })).toBe('ya29.token-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('mints a new token when it would not outlive minValidSeconds', async () => {
    const { keys, clock } = setup();
    await keys.importGoogle(serviceAccountJson(google.pem));
    await keys.getGoogleAccessToken();
    clock.advance(3599 - GOOGLE_APPLY_MIN_VALID_SECONDS - 1);
    expect(await keys.getGoogleAccessToken({ minValidSeconds: GOOGLE_APPLY_MIN_VALID_SECONDS })).toBe('ya29.token-1');
    clock.advance(2);
    expect(await keys.getGoogleAccessToken({ minValidSeconds: GOOGLE_APPLY_MIN_VALID_SECONDS })).toBe('ya29.token-2');
  });

  it('refuses redirects and sends no credentials', async () => {
    const { keys, fetchMock } = setup();
    await keys.importGoogle(serviceAccountJson(google.pem));
    await keys.getGoogleAccessToken();
    const init = fetchMock.mock.calls[0][1];
    expect(init.redirect).toBe('error');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('times out with an AbortController when AbortSignal.timeout is missing', async () => {
    const original = AbortSignal.timeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      (AbortSignal as { timeout?: unknown }).timeout = undefined;
      const fetchMock = vi.fn<FetchLike>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
      );
      const { keys } = setup({ fetch: fetchMock });
      await keys.importGoogle(serviceAccountJson(google.pem));
      const pending = keys.getGoogleAccessToken().catch((e: unknown) => e);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toMatchObject({ code: 'network' });
    } finally {
      AbortSignal.timeout = original;
      vi.useRealTimers();
    }
  });

  it('does not cache a failed exchange', async () => {
    let calls = 0;
    const fetchMock = vi.fn<FetchLike>(async () => (++calls === 1 ? jsonResponse({ error: 'internal' }, 503) : jsonResponse({ access_token: 'ya29.ok', expires_in: 3600 })));
    const { keys } = setup({ fetch: fetchMock });
    await keys.importGoogle(serviceAccountJson(google.pem));
    await expect(keys.getGoogleAccessToken()).rejects.toMatchObject({ code: 'network', status: 503 });
    expect(await keys.getGoogleAccessToken()).toBe('ya29.ok');
  });

  const SECRET_ECHO = 'assertion=eyJhbGciOiJSUzI1NiJ9.SECRETECHO';

  it.each([
    [400, { error: 'invalid_grant', error_description: `Invalid JWT Signature. ${SECRET_ECHO}` }, 'token_rejected', /deleted or disabled/],
    [400, { error: 'invalid_grant', error_description: 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values' }, 'token_rejected', /clock/],
    [401, { error: 'invalid_client', error_description: SECRET_ECHO }, 'token_rejected', /deleted or disabled/],
    [400, { error: 'invalid_scope' }, 'token_rejected', /scope/],
    [403, { error: 'access_denied', error_description: SECRET_ECHO }, 'token_rejected', /HTTP 403/],
    [500, { error: SECRET_ECHO }, 'network', /unavailable/],
    [429, null, 'network', /unavailable/],
  ])('maps HTTP %i %j to a fixed message', async (status, body, code, message) => {
    const fetchMock = vi.fn<FetchLike>(async () => (body === null ? new Response('not json', { status }) : jsonResponse(body, status)));
    const { keys } = setup({ fetch: fetchMock });
    await keys.importGoogle(serviceAccountJson(google.pem));
    const error = (await keys.getGoogleAccessToken().catch((e: unknown) => e)) as BrowserKeyError;
    expect(error).toBeInstanceOf(BrowserKeyError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain('SECRETECHO');
    expect(JSON.stringify(error)).not.toContain('SECRETECHO');
  });

  it('maps a network failure without passing the error on', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch assertion=SECRETECHO');
    });
    const { keys } = setup({ fetch: fetchMock });
    await keys.importGoogle(serviceAccountJson(google.pem));
    const error = (await keys.getGoogleAccessToken().catch((e: unknown) => e)) as BrowserKeyError;
    expect(error.code).toBe('network');
    expect(error.message).not.toContain('SECRETECHO');
    expect(error.cause).toBeUndefined();
  });

  it.each([
    ['no access_token', { expires_in: 3600 }],
    ['an empty access_token', { access_token: '' }],
    ['an access_token with whitespace', { access_token: 'a b' }],
    ['a non-bearer token type', { access_token: 'x', token_type: 'mac' }],
  ])('refuses a 200 with %s', async (_name, body) => {
    const { keys } = setup({ fetch: vi.fn<FetchLike>(async () => jsonResponse(body)) });
    await keys.importGoogle(serviceAccountJson(google.pem));
    await expect(keys.getGoogleAccessToken()).rejects.toMatchObject({ code: 'network' });
  });

  it('caps a token lifetime Google reports above one hour', async () => {
    const { keys, clock, fetchMock } = setup({ fetch: vi.fn<FetchLike>(async () => jsonResponse({ access_token: 'ya29.long', expires_in: 99999 })) });
    await keys.importGoogle(serviceAccountJson(google.pem));
    await keys.getGoogleAccessToken();
    clock.advance(3600 - 299);
    await keys.getGoogleAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('BrowserKeys: forget', () => {
  it('forget(platform) deletes that key and its token only', async () => {
    const { keys, store, fetchMock } = setup();
    await keys.importApple(appleInput());
    await keys.importGoogle(serviceAccountJson(google.pem));
    await keys.getAppleToken();
    await keys.getGoogleAccessToken();

    await keys.forget('apple');
    expect(await store.get('apple')).toBeNull();
    expect(await keys.info('apple')).toBeNull();
    await expect(keys.getAppleToken()).rejects.toMatchObject({ code: 'not_connected' });

    expect(await keys.getGoogleAccessToken()).toBe('ya29.token-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forgetAll() deletes every key and token', async () => {
    const { keys, store } = setup();
    await keys.importApple(appleInput());
    await keys.importGoogle(serviceAccountJson(google.pem));
    await keys.getAppleToken();
    await keys.forgetAll();
    expect(await store.get('apple')).toBeNull();
    expect(await store.get('google')).toBeNull();
    await expect(keys.getAppleToken()).rejects.toBeInstanceOf(BrowserKeyError);
    await expect(keys.getGoogleAccessToken()).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('a token being signed when the key is forgotten is not returned', async () => {
    const { store, gate } = gatedStore();
    await new BrowserKeys({ store, clock: () => T0 }).importApple(appleInput());
    const keys = new BrowserKeys({ store, clock: () => T0 });
    gate.close();
    const pending = keys.getAppleToken().catch((e: unknown) => e);
    await keys.forget('apple');
    gate.open(); // the read started before the forget now returns the old key
    expect(await pending).toMatchObject({ code: 'not_connected' });
    await expect(keys.getAppleToken()).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('a token being signed when the key is replaced comes from the new key', async () => {
    const { store, gate } = gatedStore();
    await new BrowserKeys({ store, clock: () => T0 }).importApple(appleInput());
    const keys = new BrowserKeys({ store, clock: () => T0 });
    gate.close();
    const pending = keys.getAppleToken();
    const other = await makeAppleKey();
    await keys.importApple({ ...appleInput(), privateKeyPem: other.pem, keyId: 'NEWKEY1234' });
    gate.open();
    const token = await pending;
    expect(await verifyJwt(token, other.publicKey)).toBe(true);
    expect(decodeJwt(token).header.kid).toBe('NEWKEY1234');
  });

  it('an import overtaken by a forget does not come back', async () => {
    const { store, gate } = gatedStore();
    const keys = new BrowserKeys({ store, clock: () => T0 });
    gate.closeWrites();
    const importing = keys.importApple(appleInput());
    await vi.waitFor(() => expect(gate.pendingWrites()).toBe(1));
    const forgetting = keys.forget('apple');
    gate.open();
    await importing;
    await forgetting;
    expect(await store.get('apple')).toBeNull();
    expect(await keys.info('apple')).toBeNull();
    await expect(keys.getAppleToken()).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('the later of two overlapping imports wins', async () => {
    const { store, gate } = gatedStore();
    const keys = new BrowserKeys({ store, clock: () => T0 });
    const other = await makeAppleKey();
    gate.closeWrites();
    const firstImport = keys.importApple(appleInput());
    await vi.waitFor(() => expect(gate.pendingWrites()).toBe(1));
    const secondImport = keys.importApple({ ...appleInput(), privateKeyPem: other.pem, keyId: 'NEWKEY1234' });
    await vi.waitFor(() => expect(gate.pendingWrites()).toBe(2));
    gate.open();
    await Promise.all([firstImport, secondImport]);
    expect(await keys.info('apple')).toMatchObject({ keyId: 'NEWKEY1234' });
    expect(await verifyJwt(await keys.getAppleToken(), other.publicKey)).toBe(true);
  });

  it('forgetAll() keeps everything when the store fails, and throws', async () => {
    const store = new MemoryKeyStore();
    const keys = new BrowserKeys({ store, clock: () => T0 });
    await keys.importApple(appleInput());
    const token = await keys.getAppleToken();
    vi.spyOn(store, 'clear').mockRejectedValueOnce(new BrowserKeyError('storage', 'no'));
    await expect(keys.forgetAll()).rejects.toMatchObject({ code: 'storage' });
    // Memory still matches the store: the key is still there and still usable
    expect(await store.get('apple')).not.toBeNull();
    expect(await keys.getAppleToken()).toBe(token);
  });

  it('reports not_connected when nothing was ever stored', async () => {
    const { keys } = setup();
    expect(await keys.info('google')).toBeNull();
    await expect(keys.getGoogleAccessToken()).rejects.toMatchObject({ code: 'not_connected' });
  });
});
