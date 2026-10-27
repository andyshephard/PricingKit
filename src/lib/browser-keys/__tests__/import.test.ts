import { describe, it, expect, beforeAll } from 'vitest';
import { importAppleKey, importGoogleKey, isServiceAccountShape } from '../import';
import { pkcs8PemToDer, rsaPkcs8KeyBits } from '../encoding';
import { BrowserKeyError } from '../types';
import { rsaPrivateKeyBits, validateServiceAccountJson } from '@/lib/google-play/client';
import { makeAppleKey, makeRsaKey, serviceAccountJson } from './keys';

async function rejection(promise: Promise<unknown>): Promise<BrowserKeyError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(BrowserKeyError);
  return error as BrowserKeyError;
}

let applePem: string;
let rsa2048: string;

beforeAll(async () => {
  applePem = (await makeAppleKey()).pem;
  rsa2048 = (await makeRsaKey(2048)).pem;
});

describe('importAppleKey', () => {
  it('imports a .p8 key as a non-extractable ECDSA P-256 signing key', async () => {
    const { key, keyId, issuerId } = await importAppleKey({ privateKeyPem: applePem, keyId: ' ABC123DEFG ', issuerId: '57246542-96fe-1a63-e053-0824d011072a' });
    expect(keyId).toBe('ABC123DEFG');
    expect(issuerId).toBe('57246542-96fe-1a63-e053-0824d011072a');
    expect(key.extractable).toBe(false);
    expect(key.type).toBe('private');
    expect(key.usages).toEqual(['sign']);
    expect(key.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    await expect(crypto.subtle.exportKey('pkcs8', key)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('jwk', key)).rejects.toThrow();
  });

  it('returns no key material', async () => {
    const result = await importAppleKey({ privateKeyPem: applePem, keyId: 'ABC123DEFG', issuerId: 'issuer' });
    expect(Object.keys(result).sort()).toEqual(['issuerId', 'key', 'keyId']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });

  it('accepts Windows line endings', async () => {
    const { key } = await importAppleKey({ privateKeyPem: applePem.replace(/\n/g, '\r\n'), keyId: 'K', issuerId: 'I' });
    expect(key.extractable).toBe(false);
  });

  it.each([
    ['an empty Key ID', { keyId: '' }, /Key ID/],
    ['a Key ID with odd characters', { keyId: 'ABC"}' }, /Key ID/],
    ['an over-long Issuer ID', { issuerId: 'a'.repeat(65) }, /Issuer ID/],
    ['a missing key', { privateKeyPem: '' }, /\.p8/],
    ['a non-PEM key', { privateKeyPem: 'hello' }, /\.p8/],
    ['text around the PEM block', { privateKeyPem: 'junk\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }, /\.p8/],
    ['an SEC1 EC key', { privateKeyPem: '-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----' }, /SEC1/],
    ['an over-long PEM', { privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(4000)}\n-----END PRIVATE KEY-----` }, /\.p8/],
  ])('rejects %s', async (_name, override, message) => {
    const error = await rejection(importAppleKey({ privateKeyPem: applePem, keyId: 'ABC123DEFG', issuerId: 'issuer', ...override }));
    expect(error.code).toBe('invalid_key');
    expect(error.message).toMatch(message);
  });

  it('rejects an RSA key without echoing it', async () => {
    const rsaFull = await rejection(importAppleKey({ privateKeyPem: rsa2048, keyId: 'K', issuerId: 'I' }));
    expect(rsaFull.code).toBe('invalid_key');
    expect(rsaFull.message).not.toMatch(/[A-Za-z0-9+/]{40}/);
  });

  it('rejects a P-384 key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign']);
    const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----`;
    const error = await rejection(importAppleKey({ privateKeyPem: pem, keyId: 'K', issuerId: 'I' }));
    expect(error.message).toMatch(/P-256/);
  });
});

describe('importGoogleKey', () => {
  it('imports the JSON file text as a non-extractable RS256 signing key', async () => {
    const result = await importGoogleKey(JSON.stringify(serviceAccountJson(rsa2048)));
    expect(result.clientEmail).toBe('pricing@test-project.iam.gserviceaccount.com');
    expect(result.privateKeyId).toBe('test-key-id');
    expect(result.projectId).toBe('test-project');
    expect(result.key.extractable).toBe(false);
    expect(result.key.usages).toEqual(['sign']);
    expect(result.key.algorithm).toMatchObject({ name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } });
    await expect(crypto.subtle.exportKey('pkcs8', result.key)).rejects.toThrow();
    expect(Object.keys(result).sort()).toEqual(['clientEmail', 'key', 'privateKeyId', 'projectId']);
  });

  it('accepts an already-parsed object', async () => {
    const result = await importGoogleKey(serviceAccountJson(rsa2048));
    expect(result.key.extractable).toBe(false);
  });

  it('accepts a 4096-bit key and refuses a 1024-bit one', async () => {
    const big = await makeRsaKey(4096);
    expect((await importGoogleKey(serviceAccountJson(big.pem))).key.extractable).toBe(false);
    const small = await makeRsaKey(1024);
    expect((await rejection(importGoogleKey(serviceAccountJson(small.pem)))).message).toMatch(/2048 to 4096 bits/);
  });

  it('refuses invalid JSON without quoting it', async () => {
    const error = await rejection(importGoogleKey('{"private_key": "-----BEGIN PRIVATE KEY-----SECRETSTUFF'));
    expect(error.code).toBe('invalid_key');
    expect(error.message).not.toContain('SECRETSTUFF');
  });

  it('refuses an over-long file before parsing it', async () => {
    const error = await rejection(importGoogleKey(' '.repeat(16 * 1024 + 1)));
    expect(error.message).toMatch(/too large/);
  });

  it.each([
    ['a missing field', { client_x509_cert_url: undefined }],
    ['the wrong type', { type: 'authorized_user' }],
    ['a non-string field', { client_id: 1 }],
  ])('refuses %s', async (_name, override) => {
    const error = await rejection(importGoogleKey(serviceAccountJson(rsa2048, override)));
    expect(error.message).toMatch(/service account key file/);
  });

  it.each([
    ['an empty client_email', { client_email: '' }, /client_email/],
    ['a client_email without @', { client_email: 'nobody' }, /client_email/],
    ['a private_key_id with a newline', { private_key_id: 'a\nb' }, /private_key_id/],
    ['an over-long project_id', { project_id: 'p'.repeat(300) }, /project_id/],
    ['an EC private_key', {}, /RSA/],
  ])('refuses %s', async (name, override, message) => {
    const key = name.includes('EC') ? (await makeAppleKey()).pem : rsa2048;
    const error = await rejection(importGoogleKey(serviceAccountJson(key, override)));
    expect(error.code).toBe('invalid_key');
    expect(error.message).toMatch(message);
  });

  it("never echoes the key in an error", async () => {
    const corrupt = rsa2048.replace(/\n([A-Za-z0-9+/]{64})\n/, '\n$1$1\n');
    const error = await rejection(importGoogleKey(serviceAccountJson(corrupt)));
    expect(error.message).not.toMatch(/[A-Za-z0-9+/]{40}/);
  });
});

describe('parity with the server-side rules', () => {
  it('reads the same RSA key size as rsaPrivateKeyBits', async () => {
    const inputs = [rsa2048, (await makeRsaKey(3072)).pem, (await makeRsaKey(1024)).pem, (await makeAppleKey()).pem, 'nope', ''];
    for (const pem of inputs) {
      const der = pkcs8PemToDer(pem);
      expect(der ? rsaPkcs8KeyBits(der) : null).toBe(rsaPrivateKeyBits(pem));
    }
  });

  it('accepts the same service account shapes as validateServiceAccountJson', () => {
    const inputs: unknown[] = [
      serviceAccountJson('k'),
      serviceAccountJson('k', { type: 'user' }),
      serviceAccountJson('k', { auth_uri: undefined }),
      serviceAccountJson('k', { client_id: 7 }),
      null,
      'string',
      {},
    ];
    for (const input of inputs) expect(isServiceAccountShape(input)).toBe(validateServiceAccountJson(input));
  });
});
