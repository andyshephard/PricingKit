// Cross-site requests, request body limits, sign-in limits and the service
// account key size check. No store is contacted: fetch is stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createCookieStore, TEST_ENCRYPTION_KEY, type TestCookieStore } from './helpers';

let cookieStore: TestCookieStore;
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

import { readJsonBody, rejectCrossSite } from '@/lib/request-guard';
import { isAcceptedServiceAccountKey, rsaPrivateKeyBits } from '@/lib/google-play/client';
import { POST as authPOST } from '../auth/route';
import { POST as appleAuthPOST } from '../apple/auth/route';
import { POST as settingsPOST } from '../settings/exchange-rates/route';

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

describe('every route that changes something is guarded', () => {
  const API = join(__dirname, '..');
  const routes = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : routes(full);
      return name === 'route.ts' ? [full] : [];
    });
  const writers = routes(API)
    .map((f) => ({ path: relative(API, f), text: readFileSync(f, 'utf8') }))
    .filter((f) => /export (async function|const) (POST|PATCH|PUT|DELETE)\b/.test(f.text));

  it.each(writers.map((f) => [f.path, f.text]))('%s checks the origin and never parses a body itself', (_path, text) => {
    const handlers = text.match(/export async function (POST|PATCH|PUT|DELETE)\([\s\S]*?\) \{\n {2}const crossSite = rejectCrossSite\(request\);/g) ?? [];
    expect(handlers.length).toBe((text.match(/export async function (POST|PATCH|PUT|DELETE)\(/g) ?? []).length);
    expect(text).not.toMatch(/request\.(json|text|formData|arrayBuffer)\(\)/);
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

describe('login routes', () => {
  const fetchMock = vi.fn();
  const serviceAccount = (privateKey: string) => ({
    type: 'service_account',
    project_id: 'p',
    private_key_id: 'kid',
    private_key: privateKey,
    client_email: 'svc@p.iam.gserviceaccount.com',
    client_id: '1',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://example.invalid/cert',
  });
  const login = (body: unknown, headers: Record<string, string> = {}) =>
    authPOST(new Request('http://localhost/api/auth', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }) as never);

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', TEST_ENCRYPTION_KEY);
    cookieStore = createCookieStore();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('{"error":{"code":401}}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('refuse a 16384-bit RSA key before importing it or calling Google', async () => {
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    const res = await login({ credentials: serviceAccount(fakeRsaPem(2048)), packageName: 'com.example.app' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/2048 to 4096 bits/);
    expect(importKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuse a cross-site form post (login CSRF) and an oversized body before doing anything', async () => {
    const form = await authPOST(
      new Request('http://localhost/api/auth', { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.example.com' }, body: '{}' }) as never
    );
    expect(form.status).toBe(403);
    const plain = await authPOST(new Request('http://localhost/api/auth', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }) as never);
    expect(plain.status).toBe(415);
    const huge = await login({ credentials: serviceAccount('x'.repeat(20_000)), packageName: 'com.example.app' });
    expect(huge.status).toBe(413);
    const apple = await appleAuthPOST(new Request('http://localhost/api/apple/auth', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }) as never);
    expect(apple.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuse a package name that is not one', async () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const res = await login({ credentials: serviceAccount(pem), packageName: '../../evil' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limit sign-in attempts per client when the client IP header is trusted', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', 'cf-connecting-ip');
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await login({ credentials: serviceAccount(pem), packageName: 'com.example.app' }, { 'cf-connecting-ip': '203.0.113.77' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    const calls = fetchMock.mock.calls.length;
    // Another client is not affected
    expect((await login({ credentials: serviceAccount(pem), packageName: 'com.example.app' }, { 'cf-connecting-ip': '203.0.113.78' })).status).toBe(401);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });
});

describe('POST /api/settings/exchange-rates', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', TEST_ENCRYPTION_KEY);
    cookieStore = createCookieStore();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a cross-site form that would plant an exchange-rates key', async () => {
    const res = await settingsPOST(
      new Request('http://localhost/api/settings/exchange-rates', { method: 'POST', headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' }, body: '{"apiKey":"0123456789abcdef"}' })
    );
    expect(res.status).toBe(403);
    expect(cookieStore.jar.size).toBe(0);
  });
});
