// Test helpers: throwaway keys generated per run (no real credentials), JWT
// decoding and signature checks.

import { base64UrlToBytes } from '../encoding';

function toPem(der: ArrayBuffer, label = 'PRIVATE KEY'): string {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}

export async function makeAppleKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pem: toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey)), publicKey: pair.publicKey };
}

export async function makeRsaKey(modulusLength = 2048): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  return { pem: toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey)), publicKey: pair.publicKey };
}

export function serviceAccountJson(privateKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'test-key-id',
    private_key: privateKey,
    client_email: 'pricing@test-project.iam.gserviceaccount.com',
    client_id: '1',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://example.invalid/cert',
    ...overrides,
  };
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export function decodeJwt(token: string): DecodedJwt {
  const [h, p] = token.split('.');
  const json = (part: string) => JSON.parse(new TextDecoder().decode(base64UrlToBytes(part))) as Record<string, unknown>;
  return { header: json(h), claims: json(p) };
}

export async function verifyJwt(token: string, publicKey: CryptoKey): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  const algorithm = publicKey.algorithm.name === 'ECDSA' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  return crypto.subtle.verify(algorithm, publicKey, base64UrlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
}

/** A token endpoint answer */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
