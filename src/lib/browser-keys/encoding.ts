// Browser-safe encoding helpers (no Buffer) and PKCS#8 PEM parsing.

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function stringToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/** The largest PEM we parse: a 4096-bit RSA PKCS#8 key is about 3.3 KB */
export const MAX_PEM_CHARS = 8192;

const PKCS8_PEM = /^\s*-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----\s*$/;

/**
 * The DER bytes of a single PKCS#8 PEM block ("BEGIN PRIVATE KEY"), or null
 * when the text is anything else. Nothing may surround the block but whitespace.
 */
export function pkcs8PemToDer(pem: string): Uint8Array<ArrayBuffer> | null {
  if (typeof pem !== 'string' || pem.length > MAX_PEM_CHARS) return null;
  const match = PKCS8_PEM.exec(pem);
  if (!match) return null;
  const body = match[1].replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) return null;
  try {
    return base64ToBytes(body);
  } catch {
    return null;
  }
}

const RSA_ENCRYPTION_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

/** One DER TLV: the content's start and end */
function derItem(der: Uint8Array, pos: number, tag: number): { start: number; end: number } {
  if (der[pos] !== tag) throw new Error('unexpected DER tag');
  let len = der[pos + 1];
  let start = pos + 2;
  if (len === undefined) throw new Error('truncated DER');
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3) throw new Error('unsupported DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | der[start + i];
    start += n;
  }
  const end = start + len;
  if (end > der.length) throw new Error('truncated DER');
  return { start, end };
}

/**
 * The modulus size in bits of a PKCS#8 RSA private key, read from its DER
 * without importing it (importing a huge key costs real CPU), or null when it
 * isn't one. Mirrors rsaPrivateKeyBits in src/lib/google-play/client.ts, which
 * can't be imported here because it uses Buffer; a test keeps the two in step.
 */
export function rsaPkcs8KeyBits(der: Uint8Array): number | null {
  try {
    const outer = derItem(der, 0, 0x30);
    const version = derItem(der, outer.start, 0x02);
    const algorithm = derItem(der, version.end, 0x30);
    const oid = derItem(der, algorithm.start, 0x06);
    const oidBytes = der.subarray(oid.start, oid.end);
    if (oidBytes.length !== RSA_ENCRYPTION_OID.length || RSA_ENCRYPTION_OID.some((b, i) => oidBytes[i] !== b)) return null;
    const octets = derItem(der, algorithm.end, 0x04);
    const rsaKey = derItem(der, octets.start, 0x30);
    const rsaVersion = derItem(der, rsaKey.start, 0x02);
    const modulus = derItem(der, rsaVersion.end, 0x02);
    let first = modulus.start;
    while (first < modulus.end && der[first] === 0) first++;
    if (first === modulus.end) return null;
    return (modulus.end - first - 1) * 8 + (32 - Math.clz32(der[first]));
  } catch {
    return null;
  }
}
