// Tokens the browser signs must be interchangeable with the ones the server
// signs today from the same key: same header and claims, and a signature the
// key's public half verifies. Apple and Google do the real verification; this
// checks what the server can (signature with the public key, alg, aud and a
// lifetime no longer than Apple's 20 minutes).

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { BrowserKeys, MemoryKeyStore } from '..';
import { generateJWT, clearTokenCache } from '@/lib/apple-connect/client';
import { getGoogleAccessToken, clearGoogleAccessTokenCache } from '@/lib/google-play/client';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';
import { decodeJwt, jsonResponse, makeAppleKey, makeRsaKey, serviceAccountJson, verifyJwt, type DecodedJwt } from './keys';

/** The checks a server can make on a forwarded Apple JWT before spending a request on it */
async function serverAcceptsAppleJwt(token: string, publicKey: CryptoKey): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 2048) return false;
  const { header, claims } = decodeJwt(token);
  const iat = claims.iat as number;
  const exp = claims.exp as number;
  return (
    header.alg === 'ES256' &&
    header.typ === 'JWT' &&
    claims.aud === 'appstoreconnect-v1' &&
    Number.isInteger(iat) &&
    Number.isInteger(exp) &&
    exp > iat &&
    exp - iat <= 20 * 60 &&
    (await verifyJwt(token, publicKey))
  );
}

function withoutTimes({ header, claims }: DecodedJwt) {
  const { iat, exp, ...rest } = claims;
  return { header, claims: rest, lifetime: (exp as number) - (iat as number) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTokenCache();
  clearGoogleAccessTokenCache();
});

describe('cross-check with the server signers', () => {
  let apple: { pem: string; publicKey: CryptoKey };
  let google: { pem: string; publicKey: CryptoKey };

  beforeAll(async () => {
    apple = await makeAppleKey();
    google = await makeRsaKey(2048);
  });

  it('Apple: the browser JWT matches the server JWT and passes the same checks', async () => {
    const ids = { keyId: 'ABC123DEFG', issuerId: '57246542-96fe-1a63-e053-0824d011072a' };
    const serverToken = await generateJWT({ ...ids, privateKey: apple.pem });

    const keys = new BrowserKeys({ store: new MemoryKeyStore() });
    await keys.importApple({ privateKeyPem: apple.pem, ...ids });
    const browserToken = await keys.getAppleToken();

    expect(await serverAcceptsAppleJwt(serverToken, apple.publicKey)).toBe(true);
    expect(await serverAcceptsAppleJwt(browserToken, apple.publicKey)).toBe(true);
    expect(withoutTimes(decodeJwt(browserToken))).toEqual(withoutTimes(decodeJwt(serverToken)));
    // Key order in the encoded JSON matches too
    expect(browserToken.split('.')[0]).toBe(serverToken.split('.')[0]);
  });

  it('Apple: the checks refuse a token signed by another key or with a longer life', async () => {
    const keys = new BrowserKeys({ store: new MemoryKeyStore() });
    await keys.importApple({ privateKeyPem: apple.pem, keyId: 'K', issuerId: 'I' });
    const token = await keys.getAppleToken();
    expect(await serverAcceptsAppleJwt(token, (await makeAppleKey()).publicKey)).toBe(false);

    const [h, , s] = token.split('.');
    const longer = Buffer.from(JSON.stringify({ iss: 'I', iat: 0, exp: 21 * 60, aud: 'appstoreconnect-v1' })).toString('base64url');
    expect(await serverAcceptsAppleJwt(`${h}.${longer}.${s}`, apple.publicKey)).toBe(false);
  });

  it('Google: the browser assertion matches the server assertion and verifies', async () => {
    const assertions: string[] = [];
    const capture = vi.fn(async (_url: string, init: RequestInit) => {
      assertions.push(new URLSearchParams(init.body as string).get('assertion')!);
      return jsonResponse({ access_token: 'ya29.x', expires_in: 3600 });
    });
    vi.stubGlobal('fetch', capture);
    await getGoogleAccessToken(serviceAccountJson(google.pem) as unknown as ServiceAccountCredentials);

    const keys = new BrowserKeys({ store: new MemoryKeyStore(), fetch: capture });
    await keys.importGoogle(serviceAccountJson(google.pem));
    await keys.getGoogleAccessToken();

    expect(assertions).toHaveLength(2);
    const [serverAssertion, browserAssertion] = assertions;
    expect(await verifyJwt(serverAssertion, google.publicKey)).toBe(true);
    expect(await verifyJwt(browserAssertion, google.publicKey)).toBe(true);
    expect(withoutTimes(decodeJwt(browserAssertion))).toEqual(withoutTimes(decodeJwt(serverAssertion)));
    expect(browserAssertion.split('.')[0]).toBe(serverAssertion.split('.')[0]);
  });
});
