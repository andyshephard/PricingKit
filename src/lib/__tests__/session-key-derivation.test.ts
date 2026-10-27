import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createCookieStore, type TestCookieStore } from '@/app/api/__tests__/helpers';
import { decrypt, encrypt, isLegacyCiphertext, reencryptLegacyCiphertext, SESSION_CIPHERTEXT_V2_PREFIX } from '../encryption';
import { APPLE_BUNDLE_ID_COOKIE, APPLE_SESSION_COOKIE, GOOGLE_PACKAGE_NAME_COOKIE, GOOGLE_SESSION_COOKIE } from '../session';

let cookieStore: TestCookieStore;
const setCalls: Array<{ name: string; value: string; options: unknown }> = [];
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

const KEY = 'test-encryption-key-at-least-32-characters-long';

/** A cookie as written before v2: base64(salt + iv + ciphertext), key from PBKDF2 (100k, SHA-256). Independent of the implementation. */
async function legacyEncrypt(plaintext: string, secret = KEY): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  return Buffer.concat([salt, iv, encrypted]).toString('base64');
}

const googleCreds = { type: 'service_account', client_email: 'svc@example.iam.gserviceaccount.com', private_key_id: 'kid', private_key: 'not-a-real-key' };
const appleCreds = { privateKey: 'not-a-real-key', keyId: 'KEYID', issuerId: 'issuer', bundleId: '' };

describe('session key derivation (HKDF, v2)', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', KEY);
    vi.stubEnv('NODE_ENV', 'production');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes v2 ciphertexts and reads them back', async () => {
    const value = await encrypt('hello');
    expect(value.startsWith(SESSION_CIPHERTEXT_V2_PREFIX)).toBe(true);
    expect(isLegacyCiphertext(value)).toBe(false);
    expect(await decrypt(value)).toBe('hello');
  });

  it('still reads legacy PBKDF2 ciphertexts', async () => {
    const legacy = await legacyEncrypt('old session');
    expect(isLegacyCiphertext(legacy)).toBe(true);
    expect(await decrypt(legacy)).toBe('old session');
  });

  it('derives the v2 key once, not per request (no PBKDF2 on v2 reads)', async () => {
    const value = await encrypt('warm the cache');
    const spy = vi.spyOn(crypto.subtle, 'deriveKey');
    for (let i = 0; i < 5; i++) expect(await decrypt(value)).toBe('warm the cache');
    await encrypt('again');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a v2 ciphertext under another ENCRYPTION_KEY, or tampered', async () => {
    const value = await encrypt('secret');
    const bytes = Buffer.from(value.slice(3), 'base64');
    bytes[bytes.length - 1] ^= 1;
    await expect(decrypt(`v2.${bytes.toString('base64')}`)).rejects.toThrow();
    vi.stubEnv('ENCRYPTION_KEY', 'another-encryption-key-at-least-32-characters');
    await expect(decrypt(value)).rejects.toThrow();
  });

  it('re-encrypts a legacy ciphertext as v2; leaves v2 and garbage alone', async () => {
    const legacy = await legacyEncrypt('{"a":1}');
    const upgraded = await reencryptLegacyCiphertext(legacy);
    expect(upgraded?.startsWith('v2.')).toBe(true);
    expect(await decrypt(upgraded!)).toBe('{"a":1}');
    expect(await reencryptLegacyCiphertext(upgraded!)).toBeNull();
    expect(await reencryptLegacyCiphertext('bm90IGEgY2lwaGVydGV4dA==')).toBeNull();
    expect(await reencryptLegacyCiphertext(await legacyEncrypt('x', 'some-other-key-of-at-least-32-characters'))).toBeNull();
  });

  it('warns once about a short ENCRYPTION_KEY', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('ENCRYPTION_KEY', 'short-key');
    expect(await decrypt(await encrypt('x'))).toBe('x');
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('ENCRYPTION_KEY')).length).toBe(1);
  });
});

describe('legacy session cookies are migrated on the next request', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', KEY);
    vi.stubEnv('NODE_ENV', 'production');
    setCalls.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function store(initial: Record<string, string>): TestCookieStore {
    const s = createCookieStore(initial);
    const set = s.set;
    s.set = ((name: string, value: string, options?: unknown) => {
      setCalls.push({ name, value, options });
      set(name, value);
    }) as typeof s.set;
    return s;
  }

  it('Google: a legacy cookie authenticates and is replaced by a v2 one with the login attributes', async () => {
    const { getGoogleAuthFromCookies } = await import('@/middleware/auth');
    cookieStore = store({ [GOOGLE_SESSION_COOKIE]: await legacyEncrypt(JSON.stringify(googleCreds)), [GOOGLE_PACKAGE_NAME_COOKIE]: 'com.example.app' });
    const auth = await getGoogleAuthFromCookies();
    expect(auth?.credentials).toEqual(googleCreds);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].name).toBe(GOOGLE_SESSION_COOKIE);
    expect(setCalls[0].value.startsWith('v2.')).toBe(true);
    expect(setCalls[0].options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'strict', maxAge: 86400, path: '/' });
    // The next request reads the v2 cookie and writes nothing
    const again = await getGoogleAuthFromCookies();
    expect(again?.credentials).toEqual(googleCreds);
    expect(setCalls).toHaveLength(1);
  });

  it('Apple: both helpers migrate; a v2 cookie is never rewritten', async () => {
    const { getAppleAuthFromCookies, getAppleSessionFromCookies } = await import('@/middleware/auth');
    cookieStore = store({ [APPLE_SESSION_COOKIE]: await legacyEncrypt(JSON.stringify(appleCreds)), [APPLE_BUNDLE_ID_COOKIE]: 'com.example.app' });
    expect((await getAppleSessionFromCookies())?.keyId).toBe('KEYID');
    expect(setCalls.map((c) => c.name)).toEqual([APPLE_SESSION_COOKIE]);
    expect((await getAppleAuthFromCookies())?.bundleId).toBe('com.example.app');
    expect(setCalls).toHaveLength(1);
  });

  it('a cookie store that refuses writes still authenticates', async () => {
    const { getGoogleAuthFromCookies } = await import('@/middleware/auth');
    cookieStore = createCookieStore({ [GOOGLE_SESSION_COOKIE]: await legacyEncrypt(JSON.stringify(googleCreds)), [GOOGLE_PACKAGE_NAME_COOKIE]: 'com.example.app' });
    cookieStore.set = () => {
      throw new Error('Cookies can only be modified in a Server Action or Route Handler');
    };
    expect((await getGoogleAuthFromCookies())?.credentials).toEqual(googleCreds);
  });
});
