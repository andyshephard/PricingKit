import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createCookieStore, TEST_ENCRYPTION_KEY, type TestCookieStore } from '@/app/api/__tests__/helpers';
import { LEGACY_SESSION_CUTOFF_MS, openLegacy, sealV3 } from '../encryption';
import { openSession, sealSession, SESSION_LIFETIME_SECONDS } from '../session-envelope';
import { clearCookie, cookieName, CookieTooLargeError, readSessionCookie, writeSessionCookie } from '../session';

let cookieStore: TestCookieStore;
const setCalls: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

const KEY = TEST_ENCRYPTION_KEY;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** A moment inside the legacy window, whatever today's date is */
const BEFORE_CUTOFF = LEGACY_SESSION_CUTOFF_MS - 3 * DAY;

const googleCreds = {
  client_email: 'svc@example.iam.gserviceaccount.com',
  private_key_id: 'kid',
  private_key: 'not-a-real-key',
  project_id: 'example',
};
const appleCreds = { privateKey: 'not-a-real-key-but-long-enough-for-a-legacy-cookie-'.repeat(3), keyId: 'KEYID', issuerId: 'issuer', bundleId: '' };

/** A cookie as written before v2: base64(salt + iv + ciphertext), key from PBKDF2 (100k, SHA-256). Independent of the implementation. */
async function legacyV1(plaintext: string, secret = KEY): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  return Buffer.concat([salt, iv, encrypted]).toString('base64');
}

/** A v2 cookie: "v2." + base64(iv + ciphertext), key from HKDF over the key text. Independent of the implementation. */
async function legacyV2(plaintext: string, secret = KEY): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('pricingkit/session-cookie/salt/v2'), info: new TextEncoder().encode('pricingkit/session-cookie/aes-256-gcm/v2') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  return `v2.${Buffer.concat([iv, encrypted]).toString('base64')}`;
}

describe('v3 session envelopes', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', KEY);
    vi.stubEnv('NODE_ENV', 'production');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('round-trips, with a 24-hour absolute expiry', async () => {
    const t0 = Date.now();
    const { value, exp } = await sealSession('google', googleCreds, { nowMs: t0 });
    expect(value.startsWith('v3.')).toBe(true);
    expect(exp).toBe(Math.floor(t0 / 1000) + SESSION_LIFETIME_SECONDS);
    expect((await openSession('google', value, { nowMs: t0 + 23 * HOUR }))?.creds).toEqual(googleCreds);
    expect(await openSession('google', value, { nowMs: t0 + DAY })).toBeNull();
  });

  it('a copied cookie is refused 400 days later (the server enforces the expiry, not just the browser)', async () => {
    const t0 = Date.now();
    const { value } = await sealSession('google', googleCreds, { nowMs: t0 });
    expect(await openSession('google', value, { nowMs: t0 + 400 * DAY })).toBeNull();
    // Through the cookie helpers too
    expect(await readSessionCookie(createCookieStore({ [cookieName('gplay_session')]: value }), 'google', t0 + 400 * DAY)).toBeNull();
  });

  it('is bound to its cookie: an Apple session is not a Google one, and the other way round', async () => {
    const apple = (await sealSession('apple', appleCreds)).value;
    const google = (await sealSession('google', googleCreds)).value;
    expect(await openSession('google', apple)).toBeNull();
    expect(await openSession('apple', google)).toBeNull();
  });

  it('SESSION_VERSION signs everyone out when it changes', async () => {
    const before = (await sealSession('google', googleCreds)).value;
    vi.stubEnv('SESSION_VERSION', '2');
    expect(await openSession('google', before)).toBeNull();
    const after = (await sealSession('google', googleCreds)).value;
    expect((await openSession('google', after))?.creds).toEqual(googleCreds);
    vi.stubEnv('SESSION_VERSION', '3');
    expect(await openSession('google', after)).toBeNull();
  });

  it('refuses a tampered cookie and one sealed under another key', async () => {
    const { value } = await sealSession('google', googleCreds);
    const bytes = Buffer.from(value.slice(3), 'base64url');
    bytes[bytes.length - 1] ^= 1;
    expect(await openSession('google', `v3.${bytes.toString('base64url')}`)).toBeNull();
    vi.stubEnv('ENCRYPTION_KEY', Buffer.alloc(32, 9).toString('base64'));
    expect(await openSession('google', value)).toBeNull();
  });

  it('checks the envelope after decryption: lifetime, type, version and credential fields', async () => {
    const now = Math.floor(Date.now() / 1000);
    const aad = 'pricingkit/session/v3|gplay_session|1';
    const seal = (envelope: unknown) => sealV3(JSON.stringify(envelope), aad);
    const good = { v: '1', typ: 'google', iat: now, exp: now + 60, creds: googleCreds };
    expect((await openSession('google', await seal(good)))?.creds).toEqual(googleCreds);
    for (const bad of [
      { ...good, exp: now + SESSION_LIFETIME_SECONDS + 61, iat: now - 60 }, // longer than 24 hours
      { ...good, iat: now + 3600, exp: now + 7200 }, // issued in the future
      { ...good, typ: 'apple' },
      { ...good, v: '2' },
      { ...good, creds: { ...googleCreds, private_key: undefined } },
      { ...good, creds: 'x' },
      { ...good, exp: 'later' },
      [good],
    ]) {
      expect(await openSession('google', await seal(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it('keeps only the four Google fields it needs', async () => {
    const full = { ...googleCreds, type: 'service_account', client_id: '1', token_uri: 'https://example.invalid/token', notes: 'z'.repeat(2000) };
    const { value } = await sealSession('google', full);
    expect(Object.keys((await openSession('google', value))!.creds).sort()).toEqual(['client_email', 'private_key', 'private_key_id', 'project_id']);
  });

  it('derives the key once, not per request', async () => {
    const { value } = await sealSession('google', googleCreds);
    const spy = vi.spyOn(crypto.subtle, 'deriveKey');
    for (let i = 0; i < 5; i++) expect(await openSession('google', value)).not.toBeNull();
    await sealSession('google', googleCreds);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('legacy session cookies', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', KEY);
    vi.stubEnv('NODE_ENV', 'production');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads v1 and v2 cookies until the cutoff, then refuses them', async () => {
    const v1 = await legacyV1(JSON.stringify(googleCreds));
    const v2 = await legacyV2(JSON.stringify(appleCreds));
    expect((await openSession('google', v1, { nowMs: BEFORE_CUTOFF }))?.creds).toEqual(googleCreds);
    expect((await openSession('apple', v2, { nowMs: BEFORE_CUTOFF }))?.creds).toEqual(appleCreds);
    expect(await openSession('google', v1, { nowMs: LEGACY_SESSION_CUTOFF_MS })).toBeNull();
    expect(await openSession('apple', v2, { nowMs: LEGACY_SESSION_CUTOFF_MS })).toBeNull();
  });

  it('gives a legacy session an expiry that never passes the cutoff', async () => {
    const v2 = await legacyV2(JSON.stringify(googleCreds));
    const early = await openSession('google', v2, { nowMs: BEFORE_CUTOFF });
    expect(early).toMatchObject({ legacy: true, exp: Math.floor(BEFORE_CUTOFF / 1000) + SESSION_LIFETIME_SECONDS });
    const late = await openSession('google', v2, { nowMs: LEGACY_SESSION_CUTOFF_MS - HOUR });
    expect(late?.exp).toBe(Math.floor(LEGACY_SESSION_CUTOFF_MS / 1000));
  });

  it('refuses a legacy cookie once SESSION_VERSION is set, and one of the wrong kind', async () => {
    const v2 = await legacyV2(JSON.stringify(googleCreds));
    expect(await openSession('apple', v2, { nowMs: BEFORE_CUTOFF })).toBeNull();
    vi.stubEnv('SESSION_VERSION', '2');
    expect(await openSession('google', v2, { nowMs: BEFORE_CUTOFF })).toBeNull();
  });

  it('refuses junk before any key derivation (no PBKDF2 for an attacker-made cookie)', async () => {
    const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey');
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    const junk = Buffer.alloc(60, 7).toString('base64');
    for (const value of [junk, `v2.${junk}`, 'not base64 at all!', 'A'.repeat(5000), `v2.${'A'.repeat(5000)}`, '', 'v3.%%%']) {
      expect(await openSession('google', value, { nowMs: BEFORE_CUTOFF })).toBeNull();
    }
    await expect(openLegacy(junk, BEFORE_CUTOFF)).rejects.toThrow();
    expect(deriveKey).not.toHaveBeenCalled();
    expect(importKey).not.toHaveBeenCalled();
  });
});

describe('session cookies in the browser', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', KEY);
    vi.stubEnv('NODE_ENV', 'production');
    setCalls.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function store(initial: Record<string, string>): TestCookieStore {
    const s = createCookieStore(initial);
    const set = s.set;
    s.set = ((name: string, value: string, options?: Record<string, unknown>) => {
      setCalls.push({ name, value, options: options ?? {} });
      set(name, value, options);
    }) as typeof s.set;
    return s;
  }

  it('names cookies with the __Host- prefix in production, plain under next dev and tests', () => {
    expect(cookieName('gplay_session')).toBe('__Host-gplay_session');
    vi.stubEnv('NODE_ENV', 'development');
    expect(cookieName('gplay_session')).toBe('gplay_session');
  });

  it('a login writes a Secure, HttpOnly, SameSite=Strict __Host- cookie for 24 hours', async () => {
    cookieStore = store({});
    await writeSessionCookie(cookieStore, 'google', googleCreds);
    expect(setCalls).toEqual([
      { name: '__Host-gplay_session', value: expect.stringMatching(/^v3\./), options: { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 86400, path: '/' } },
    ]);
  });

  it('a 2048-bit service account key fits, with room to spare', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    cookieStore = store({});
    await writeSessionCookie(cookieStore, 'google', { ...googleCreds, private_key: pem, client_email: 'pricing-bot@a-long-project-name-123456.iam.gserviceaccount.com', private_key_id: 'f'.repeat(40) });
    expect(setCalls[0].value.length).toBeLessThan(3200);
  });

  it('refuses credentials too large for a cookie instead of letting the browser drop them', async () => {
    cookieStore = store({});
    await expect(writeSessionCookie(cookieStore, 'google', { ...googleCreds, private_key: 'k'.repeat(3000) })).rejects.toBeInstanceOf(CookieTooLargeError);
    expect(setCalls).toEqual([]);
  });

  it('Google: a legacy cookie under the old name authenticates and moves to a v3 __Host- cookie, keeping its window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEFORE_CUTOFF);
    const { getGoogleAuthFromCookies } = await import('@/middleware/auth');
    cookieStore = store({ gplay_session: await legacyV1(JSON.stringify(googleCreds)), gplay_package_name: 'com.example.app' });
    const auth = await getGoogleAuthFromCookies();
    expect(auth).toEqual({ credentials: googleCreds, packageName: 'com.example.app' });
    const session = setCalls.find((c) => c.name === '__Host-gplay_session')!;
    expect(session.value.startsWith('v3.')).toBe(true);
    expect(session.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'strict', maxAge: 86400, path: '/' });
    expect(cookieStore.jar.has('gplay_session')).toBe(false);
    expect(cookieStore.jar.get('__Host-gplay_package_name')).toBe('com.example.app');
    expect(cookieStore.jar.has('gplay_package_name')).toBe(false);
    // The next request reads the new cookies and writes nothing
    setCalls.length = 0;
    expect((await getGoogleAuthFromCookies())?.credentials).toEqual(googleCreds);
    expect(setCalls).toEqual([]);
  });

  it('Apple: moving a v3 cookie to its new name keeps its expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEFORE_CUTOFF);
    const issued = BEFORE_CUTOFF - 20 * HOUR;
    const { value, exp } = await sealSession('apple', appleCreds, { nowMs: issued });
    const { getAppleAuthFromCookies } = await import('@/middleware/auth');
    cookieStore = store({ apple_session: value, apple_bundle_id: 'com.example.app' });
    expect((await getAppleAuthFromCookies())?.bundleId).toBe('com.example.app');
    const moved = setCalls.find((c) => c.name === '__Host-apple_session')!;
    expect(moved.options.maxAge).toBe(4 * 3600);
    expect((await openSession('apple', moved.value))?.exp).toBe(exp);
  });

  it('after the cutoff, cookies under the old names are ignored', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LEGACY_SESSION_CUTOFF_MS + HOUR);
    const { value } = await sealSession('google', googleCreds);
    const { getGoogleAuthFromCookies } = await import('@/middleware/auth');
    cookieStore = store({ gplay_session: value, gplay_package_name: 'com.example.app' });
    expect(await getGoogleAuthFromCookies()).toBeNull();
    cookieStore = store({ '__Host-gplay_session': value, '__Host-gplay_package_name': 'com.example.app' });
    expect((await getGoogleAuthFromCookies())?.packageName).toBe('com.example.app');
  });

  it('a cookie store that refuses writes still authenticates a legacy cookie', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEFORE_CUTOFF);
    const { getGoogleAuthFromCookies } = await import('@/middleware/auth');
    cookieStore = createCookieStore({ gplay_session: await legacyV2(JSON.stringify(googleCreds)), gplay_package_name: 'com.example.app' });
    cookieStore.set = () => {
      throw new Error('Cookies can only be modified in a Server Action or Route Handler');
    };
    expect((await getGoogleAuthFromCookies())?.credentials).toEqual(googleCreds);
  });

  it('sign-out expires the cookie under both names, with the attributes a __Host- cookie needs', () => {
    cookieStore = store({ '__Host-gplay_session': 'x', gplay_session: 'y' });
    clearCookie(cookieStore, 'gplay_session');
    expect(cookieStore.jar.size).toBe(0);
    expect(setCalls.map((c) => [c.name, c.options.maxAge, c.options.secure, c.options.path])).toEqual([
      ['__Host-gplay_session', 0, true, '/'],
      ['gplay_session', 0, true, '/'],
    ]);
  });
});
