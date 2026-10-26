import { describe, it, expect, beforeEach } from 'vitest';
import { generateJWT, clearTokenCache } from '../client';
import type { AppleConnectCredentials } from '../types';

// Generate a throwaway P-256 key in PKCS8 PEM form (no real credentials involved).
async function makeKeyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const b64 = Buffer.from(pkcs8).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey };
}

function creds(privateKey: string): AppleConnectCredentials {
  return { privateKey, keyId: 'SAMEKEYID1', issuerId: 'same-issuer-id', bundleId: '' };
}

async function verifiesWith(token: string, publicKey: CryptoKey): Promise<boolean> {
  const [h, p, s] = token.split('.');
  const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    sig,
    new TextEncoder().encode(`${h}.${p}`)
  );
}

describe('Apple generateJWT token cache', () => {
  beforeEach(() => {
    clearTokenCache();
  });

  it('reuses the cached token for identical credentials', async () => {
    const { pem } = await makeKeyPair();
    const first = await generateJWT(creds(pem));
    const second = await generateJWT(creds(pem));
    expect(second).toBe(first);
  });

  it('never shares a token between keys with the same keyId and issuerId', async () => {
    const tenantA = await makeKeyPair();
    const tenantB = await makeKeyPair();

    const tokenA = await generateJWT(creds(tenantA.pem));
    const tokenB = await generateJWT(creds(tenantB.pem));

    expect(tokenB).not.toBe(tokenA);
    // Each token is signed by its own key, not the other tenant's
    expect(await verifiesWith(tokenA, tenantA.publicKey)).toBe(true);
    expect(await verifiesWith(tokenB, tenantB.publicKey)).toBe(true);
    expect(await verifiesWith(tokenB, tenantA.publicKey)).toBe(false);

    // Both remain cached independently (no single-slot thrashing)
    expect(await generateJWT(creds(tenantA.pem))).toBe(tokenA);
    expect(await generateJWT(creds(tenantB.pem))).toBe(tokenB);
  });
});
