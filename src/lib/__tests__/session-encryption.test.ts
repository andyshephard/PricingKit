import { describe, it, expect, afterEach, vi } from 'vitest';
import { openSession, sealSession } from '../session-envelope';
import { canStoreSessions, encryptionKeyProblem, MissingEncryptionKeyError, WEAK_ENCRYPTION_KEY_MESSAGE } from '../encryption';
import { TEST_ENCRYPTION_KEY } from '@/app/api/__tests__/helpers';

const googleCreds = {
  client_email: 'svc@example.iam.gserviceaccount.com',
  private_key_id: 'kid',
  private_key: 'not-a-real-key',
  project_id: 'example',
};

const appleCreds = {
  privateKey: 'not-a-real-key',
  keyId: 'KEYID',
  issuerId: 'issuer',
  bundleId: '',
};

const plaintextCookie = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

describe('session cookie encoding', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe.each(['production', 'test', ''])('without ENCRYPTION_KEY, NODE_ENV=%j', (nodeEnv) => {
    it('refuses to create a plaintext session', async () => {
      vi.stubEnv('ENCRYPTION_KEY', '');
      vi.stubEnv('NODE_ENV', nodeEnv);
      await expect(sealSession('google', googleCreds)).rejects.toBeInstanceOf(MissingEncryptionKeyError);
      await expect(sealSession('apple', appleCreds)).rejects.toBeInstanceOf(MissingEncryptionKeyError);
    });

    it('refuses to read a plaintext session cookie, old or new style', async () => {
      vi.stubEnv('ENCRYPTION_KEY', '');
      vi.stubEnv('NODE_ENV', nodeEnv);
      expect(await openSession('google', plaintextCookie(googleCreds))).toBeNull();
      const now = Math.floor(Date.now() / 1000);
      const envelope = { v: '1', typ: 'apple', iat: now, exp: now + 60, creds: appleCreds };
      expect(await openSession('apple', `p3.${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`)).toBeNull();
    });
  });

  it('error message tells self-hosters to set ENCRYPTION_KEY', async () => {
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(sealSession('google', googleCreds)).rejects.toThrow(/ENCRYPTION_KEY/);
  });

  it('allows the plaintext fallback only under next dev, with the expiry still enforced', async () => {
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('NODE_ENV', 'development');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { value } = await sealSession('google', googleCreds);
    expect(value.startsWith('p3.')).toBe(true);
    expect((await openSession('google', value))?.creds).toEqual(googleCreds);
    expect(await openSession('google', value, { nowMs: Date.now() + 25 * 3600_000 })).toBeNull();
  });

  it('encrypts when ENCRYPTION_KEY is set', async () => {
    vi.stubEnv('ENCRYPTION_KEY', TEST_ENCRYPTION_KEY);
    vi.stubEnv('NODE_ENV', 'production');
    const { value } = await sealSession('apple', appleCreds);
    expect(value).not.toContain(appleCreds.keyId);
    expect(Buffer.from(value.slice(3), 'base64url').toString('utf-8')).not.toContain('not-a-real-key');
    expect((await openSession('apple', value))?.creds).toEqual(appleCreds);
  });
});

describe('ENCRYPTION_KEY strength', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['a passphrase', 'test-encryption-key-at-least-32-characters!'],
    ['base64 of 16 bytes', Buffer.alloc(16, 1).toString('base64')],
    ['text with spaces', 'correct horse battery staple correct horse'],
  ])('outside next dev, refuses %s: no session is created or read', async (_label, key) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENCRYPTION_KEY', TEST_ENCRYPTION_KEY);
    const { value } = await sealSession('google', googleCreds);
    vi.stubEnv('ENCRYPTION_KEY', key);
    expect(encryptionKeyProblem()).toBe('weak');
    expect(canStoreSessions()).toBe(false);
    await expect(sealSession('google', googleCreds)).rejects.toThrow(WEAK_ENCRYPTION_KEY_MESSAGE);
    expect(await openSession('google', value)).toBeNull();
  });

  it.each([
    ['openssl rand -base64 32', TEST_ENCRYPTION_KEY],
    ['base64url', Buffer.alloc(32, 250).toString('base64url')],
    ['openssl rand -hex 32 (64 characters, valid base64)', 'ab'.repeat(32)],
  ])('accepts %s', async (_label, key) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENCRYPTION_KEY', key);
    expect(encryptionKeyProblem()).toBeNull();
    const { value } = await sealSession('google', googleCreds);
    expect((await openSession('google', value))?.creds).toEqual(googleCreds);
  });

  it('uses the decoded bytes: two spellings of the same bytes open each other', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const bytes = Buffer.alloc(32, 250);
    vi.stubEnv('ENCRYPTION_KEY', bytes.toString('base64'));
    const { value } = await sealSession('google', googleCreds);
    vi.stubEnv('ENCRYPTION_KEY', bytes.toString('base64url'));
    expect((await openSession('google', value))?.creds).toEqual(googleCreds);
  });

  it('under next dev a weak key still works, with a warning', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ENCRYPTION_KEY', 'dev-passphrase');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(canStoreSessions()).toBe(true);
    const { value } = await sealSession('google', googleCreds);
    expect(value.startsWith('v3.')).toBe(true);
    expect((await openSession('google', value))?.creds).toEqual(googleCreds);
  });
});
