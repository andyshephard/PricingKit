import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { BrowserKeys, MemoryKeyStore, type KeyStore } from '@/lib/browser-keys';
import { connectApple, connectGoogle, ConnectError } from '../connect';
import type { ApiFetch } from '../api-fetch';

const applePem = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function serviceAccountJson(): string {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: 'abc123',
    private_key: pem,
    client_email: 'robot@example-project.iam.gserviceaccount.com',
    client_id: '1',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://example.invalid/cert',
  });
}

const googleTokenEndpoint = vi.fn(async () => Response.json({ access_token: 'ya29.minted-in-browser', expires_in: 3600 }));

function keys(store: KeyStore = new MemoryKeyStore()) {
  return new BrowserKeys({ store, fetch: googleTokenEndpoint });
}

function fakeApi(response: Response): ApiFetch & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const fn = (async (input: string, init?: unknown) => {
    calls.push([input, init]);
    return response;
  }) as ApiFetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe('connectApple', () => {
  it('imports the key in the browser and proves it with the connect check', async () => {
    const k = keys();
    const api = fakeApi(Response.json({ success: true, keyId: 'ABC123DEF4', issuerId: 'issuer-1', apps: [{ id: '1', name: 'App', bundleId: 'com.example', sku: null }] }));
    const result = await connectApple({ keys: k, apiFetch: api }, { file: new Blob([applePem()]), keyId: 'ABC123DEF4', issuerId: 'issuer-1' });
    expect(result.apps).toHaveLength(1);
    expect(api.calls).toEqual([['/api/apple/auth', { method: 'POST', quietAuthFailure: true }]]);
    expect(await k.info('apple')).toMatchObject({ keyId: 'ABC123DEF4', issuerId: 'issuer-1' });
  });

  it('forgets the key and shows the server message when the proof fails', async () => {
    const k = keys();
    const api = fakeApi(Response.json({ error: 'App Store Connect refused the key.' }, { status: 401 }));
    await expect(connectApple({ keys: k, apiFetch: api }, { file: new Blob([applePem()]), keyId: 'ABC123DEF4', issuerId: 'issuer-1' })).rejects.toThrow(
      new ConnectError('App Store Connect refused the key.')
    );
    expect(await k.info('apple')).toBeNull();
  });

  it('refuses a file that is not a key without calling the server', async () => {
    const api = fakeApi(Response.json({}));
    await expect(connectApple({ keys: keys(), apiFetch: api }, { file: new Blob(['not a key']), keyId: 'ABC123DEF4', issuerId: 'issuer-1' })).rejects.toBeInstanceOf(ConnectError);
    expect(api.calls).toHaveLength(0);
  });

  it('explains when the browser cannot store keys', async () => {
    const broken: KeyStore = new MemoryKeyStore();
    broken.put = async () => {
      const { BrowserKeyError } = await import('@/lib/browser-keys');
      throw new BrowserKeyError('storage', 'storage failed');
    };
    await expect(
      connectApple({ keys: keys(broken), apiFetch: fakeApi(Response.json({})) }, { file: new Blob([applePem()]), keyId: 'ABC123DEF4', issuerId: 'issuer-1' })
    ).rejects.toThrow(/IndexedDB is unavailable/);
  });
});

describe('connectGoogle', () => {
  it('imports the key and proves the package can be read, sending the package as the app', async () => {
    const k = keys();
    const api = fakeApi(Response.json({ success: true, packageName: 'com.example.app' }));
    const result = await connectGoogle({ keys: k, apiFetch: api }, { file: new Blob([serviceAccountJson()]), packageName: 'com.example.app' });
    expect(result).toEqual({ clientEmail: 'robot@example-project.iam.gserviceaccount.com', projectId: 'example-project', packageName: 'com.example.app' });
    expect(api.calls).toEqual([['/api/auth', { method: 'POST', app: 'com.example.app', quietAuthFailure: true }]]);
  });

  it('forgets the key when Google refuses the package, keeping the help link', async () => {
    const k = keys();
    const api = fakeApi(Response.json({ error: 'App not found.', helpHref: '/setup-guide/google', helpText: 'Setup guide' }, { status: 404 }));
    const error = await connectGoogle({ keys: k, apiFetch: api }, { file: new Blob([serviceAccountJson()]), packageName: 'com.example.gone' }).catch((e) => e);
    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ message: 'App not found.', helpHref: '/setup-guide/google', helpText: 'Setup guide' });
    expect(await k.info('google')).toBeNull();
  });
});
