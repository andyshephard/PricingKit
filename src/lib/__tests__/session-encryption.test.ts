import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSession, getSessionCredentials } from '../google-play/client';
import { createAppleSession, getAppleSessionCredentials } from '../apple-connect/client';
import { MissingEncryptionKeyError } from '../encryption';
import type { ServiceAccountCredentials } from '../google-play/types';
import type { AppleConnectCredentials } from '../apple-connect/types';

const googleCreds = {
  type: 'service_account',
  client_email: 'svc@example.iam.gserviceaccount.com',
  private_key_id: 'kid',
  private_key: 'not-a-real-key',
} as ServiceAccountCredentials;

const appleCreds: AppleConnectCredentials = {
  privateKey: 'not-a-real-key',
  keyId: 'KEYID',
  issuerId: 'issuer',
  bundleId: '',
};

const plaintextCookie = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64');

describe('session cookie encoding', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe.each(['production', 'test', ''])('without ENCRYPTION_KEY, NODE_ENV=%j', (nodeEnv) => {
    it('refuses to create a plaintext session', async () => {
      vi.stubEnv('ENCRYPTION_KEY', '');
      vi.stubEnv('NODE_ENV', nodeEnv);
      await expect(createSession(googleCreds)).rejects.toBeInstanceOf(MissingEncryptionKeyError);
      await expect(createAppleSession(appleCreds)).rejects.toBeInstanceOf(MissingEncryptionKeyError);
    });

    it('refuses to read a plaintext session cookie', async () => {
      vi.stubEnv('ENCRYPTION_KEY', '');
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await getSessionCredentials(plaintextCookie(googleCreds))).toBeNull();
      expect(await getAppleSessionCredentials(plaintextCookie(appleCreds))).toBeNull();
    });
  });

  it('error message tells self-hosters to set ENCRYPTION_KEY', async () => {
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(createSession(googleCreds)).rejects.toThrow(/ENCRYPTION_KEY/);
  });

  it('allows the plaintext fallback only under next dev', async () => {
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('NODE_ENV', 'development');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cookie = await createSession(googleCreds);
    expect(await getSessionCredentials(cookie)).toEqual(googleCreds);
  });

  it('encrypts when ENCRYPTION_KEY is set', async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'test-encryption-key-at-least-32-characters');
    vi.stubEnv('NODE_ENV', 'production');
    const cookie = await createAppleSession(appleCreds);
    expect(cookie).not.toContain(appleCreds.keyId);
    expect(Buffer.from(cookie, 'base64').toString('utf-8')).not.toContain('not-a-real-key');
    expect(await getAppleSessionCredentials(cookie)).toEqual(appleCreds);
  });
});
