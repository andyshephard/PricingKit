import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { getGoogleAccessToken, clearGoogleAccessTokenCache } from '../client';
import type { ServiceAccountCredentials } from '../types';

// Throwaway RSA keys in PKCS8 PEM form (no real credentials involved).
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
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

function creds(privateKey: string): ServiceAccountCredentials {
  return {
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'same-key-id',
    private_key: privateKey,
    client_email: 'same@test-project.iam.gserviceaccount.com',
    client_id: '1',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://example.invalid/cert',
  } as ServiceAccountCredentials;
}

describe('Google getGoogleAccessToken cache', () => {
  let pemA: string;
  let pemB: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    pemA = await makePem();
    pemB = await makePem();
  });

  beforeEach(() => {
    clearGoogleAccessTokenCache();
    let n = 0;
    fetchMock = vi.fn(async () => {
      n += 1;
      return new Response(JSON.stringify({ access_token: `token-${n}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses the cached token for identical credentials', async () => {
    const first = await getGoogleAccessToken(creds(pemA));
    const second = await getGoogleAccessToken(creds(pemA));
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never shares a token between keys with the same client_email and private_key_id', async () => {
    const tokenA = await getGoogleAccessToken(creds(pemA));
    const tokenB = await getGoogleAccessToken(creds(pemB));

    expect(tokenB).not.toBe(tokenA);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Both remain cached independently
    expect(await getGoogleAccessToken(creds(pemA))).toBe(tokenA);
    expect(await getGoogleAccessToken(creds(pemB))).toBe(tokenB);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
