// Cross-site requests, request body limits, the connect-check limit and the
// service account key size check (CLI). No store is contacted: fetch is stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { appleHeaders, googleHeaders } from './helpers';

import { readJsonBody, rejectCrossSite } from '@/lib/request-guard';
import { isAcceptedServiceAccountKey, rsaPrivateKeyBits } from '@/lib/google-play/client';
import { POST as authPOST } from '../auth/route';
import { POST as appleAuthPOST } from '../apple/auth/route';

const URL_ = 'https://pricing.example.com/api/auth';

function req(init: { method?: string; headers?: Record<string, string>; body?: string | ReadableStream<Uint8Array> } = {}) {
  return new Request(URL_, { method: init.method ?? 'POST', headers: init.headers, body: init.body, ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
}

describe('rejectCrossSite', () => {
  it.each([
    [{ 'sec-fetch-site': 'same-origin' }, null],
    [{ 'sec-fetch-site': 'same-site' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'sec-fetch-site': 'none' }, 403],
    [{ origin: 'https://pricing.example.com' }, null],
    [{ origin: 'https://evil.example.com' }, 403],
    [{ origin: 'https://sub.pricing.example.com' }, 403],
    [{ origin: 'null' }, 403],
    [{ origin: 'https://pricing.example.com', 'sec-fetch-site': 'cross-site' }, 403],
    [{ origin: 'https://proxy-facing.example.com', 'x-forwarded-host': 'proxy-facing.example.com' }, null],
    [{}, null], // not a browser: curl, a script
  ])('%j -> %s', (headers, status) => {
    const res = rejectCrossSite(req({ headers: headers as Record<string, string> }));
    expect(res?.status ?? null).toBe(status);
  });

  it('lets GET, HEAD and OPTIONS through whatever their headers', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(rejectCrossSite(req({ method, headers: { 'sec-fetch-site': 'cross-site' } }))).toBeNull();
  });
});

describe('readJsonBody', () => {
  const json = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

  it('reads a JSON body', async () => {
    const r = await readJsonBody(req({ headers: { ...json, 'content-type': 'application/json; charset=utf-8' }, body: '{"a":1}' }), 100);
    expect(r).toEqual({ ok: true, body: { a: 1 } });
  });

  it('refuses a form-style body (text/plain parses as JSON, but a cross-site form can send it)', async () => {
    const r = await readJsonBody(req({ headers: { 'content-type': 'text/plain' }, body: '{"a":1}' }), 100);
    expect(r.ok ? 200 : r.response.status).toBe(415);
  });

  it('refuses a body over the limit by Content-Length, before reading it', async () => {
    const r = await readJsonBody(req({ headers: { ...json, 'content-length': '101' }, body: 'x'.repeat(101) }), 100);
    expect(r.ok ? 200 : r.response.status).toBe(413);
  });

  it('refuses a streamed body that grows past the limit without a Content-Length', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(64).fill(32));
        if (pulls > 1000) controller.close();
      },
    });
    const r = await readJsonBody(req({ headers: json, body: stream }), 256);
    expect(r.ok ? 200 : r.response.status).toBe(413);
    expect(pulls).toBeLessThan(10);
  });

  it('answers 400 for invalid JSON and 403 for a cross-site request', async () => {
    const bad = await readJsonBody(req({ headers: json, body: '{' }), 100);
    expect(bad.ok ? 200 : bad.response.status).toBe(400);
    const cross = await readJsonBody(req({ headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' }), 100);
    expect(cross.ok ? 200 : cross.response.status).toBe(403);
  });
});

/** PKCS#8 DER for an RSA key with a modulus of `bytes` 0xff bytes: only its structure matters here */
function fakeRsaPem(modulusBytes: number): string {
  const len = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  const tlv = (tag: number, body: number[]) => [tag, ...len(body.length), ...body];
  const modulus = tlv(0x02, [0x00, ...new Array(modulusBytes).fill(0xff)]);
  const rsaKey = tlv(0x30, [...tlv(0x02, [0]), ...modulus, ...tlv(0x02, [1, 0, 1])]);
  const algorithm = tlv(0x30, [...tlv(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]), 0x05, 0x00]);
  const der = tlv(0x30, [...tlv(0x02, [0]), ...algorithm, ...tlv(0x04, rsaKey)]);
  return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----\n`;
}

describe('service account key size', () => {
  it('reads the modulus size without importing the key', () => {
    const pem = (bits: number) => generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(rsaPrivateKeyBits(pem(2048))).toBe(2048);
    expect(rsaPrivateKeyBits(pem(1024))).toBe(1024);
    expect(rsaPrivateKeyBits(fakeRsaPem(512))).toBe(4096);
    expect(rsaPrivateKeyBits(fakeRsaPem(2048))).toBe(16384);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(rsaPrivateKeyBits(ec)).toBeNull();
    expect(rsaPrivateKeyBits('-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----')).toBeNull();
  });

  it('accepts 2048 to 4096 bits only', () => {
    expect(isAcceptedServiceAccountKey(fakeRsaPem(256))).toBe(true);
    expect(isAcceptedServiceAccountKey(fakeRsaPem(512))).toBe(true);
    expect(isAcceptedServiceAccountKey(fakeRsaPem(128))).toBe(false);
    expect(isAcceptedServiceAccountKey(fakeRsaPem(640))).toBe(false);
  });
});

describe('connect routes', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('{"error":{"code":401}}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuse a cross-site request before doing anything, even with token headers', async () => {
    const google = await authPOST(
      new Request('http://localhost/api/auth', { method: 'POST', headers: { ...googleHeaders(), origin: 'https://evil.example.com' } }) as never
    );
    expect(google.status).toBe(403);
    const apple = await appleAuthPOST(
      new Request('http://localhost/api/apple/auth', { method: 'POST', headers: { ...appleHeaders(null), 'sec-fetch-site': 'cross-site' } }) as never
    );
    expect(apple.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limit App Store Connect connect checks per instance', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 301; i++) {
      statuses.push((await appleAuthPOST(new Request('http://localhost/api/apple/auth', { method: 'POST', headers: appleHeaders(null) }) as never)).status);
    }
    expect(statuses.slice(0, 300).every((s) => s === 401)).toBe(true);
    expect(statuses[300]).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(300);
  });
});
