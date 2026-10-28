import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { BrowserKeyError, BrowserKeys, MemoryKeyStore, type KeyStore } from '@/lib/browser-keys';
import { connectApple, connectGoogle, ConnectError, STORAGE_MESSAGE } from '../connect';
import { createApiFetch, type TokenProvider } from '../api-fetch';

const applePem = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

function serviceAccountJson(clientEmail = 'robot@example-project.iam.gserviceaccount.com'): string {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: 'abc123',
    private_key: pem,
    client_email: clientEmail,
    client_id: '1',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://example.invalid/cert',
  });
}

let minted = 0;
const googleTokenEndpoint = vi.fn(async () => Response.json({ access_token: `ya29.minted-in-browser-${++minted}`, expires_in: 3600 }));

/** The real key store, and a fake server answering the connect checks */
function setup(server: (url: string, headers: Headers) => Response, store: KeyStore = new MemoryKeyStore()) {
  const keys = new BrowserKeys({ store, fetch: googleTokenEndpoint });
  const requests: Array<{ url: string; headers: Headers }> = [];
  const onAuthFailure = vi.fn();
  const apiFetchWith = (provider: TokenProvider) =>
    createApiFetch({
      keys: () => provider,
      fetch: async (url, init) => {
        const headers = new Headers(init.headers);
        requests.push({ url, headers });
        return server(url, headers);
      },
      activeApp: () => null,
      activePlatform: () => null,
      oerKey: () => null,
      onAuthFailure,
    });
  return { deps: { keys, apiFetchWith }, keys, requests, onAuthFailure };
}

const appleOk = () => Response.json({ success: true, keyId: 'ABC123DEF4', issuerId: 'issuer-1', apps: [{ id: '1', name: 'App', bundleId: 'com.example', sku: null }] });

describe('connectApple', () => {
  it('stages the key, proves it with a token it signed, and only then stores it', async () => {
    const { deps, keys, requests } = setup((url, headers) => {
      // The key isn't stored while it is being proved
      expect(url).toBe('/api/apple/auth');
      expect(headers.get('x-pk-apple-token')?.split('.')).toHaveLength(3);
      return appleOk();
    });
    const result = await connectApple(deps, { file: new Blob([applePem()]), keyId: 'ABC123DEF4', issuerId: 'issuer-1' });
    expect(result.apps).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(await keys.info('apple')).toMatchObject({ keyId: 'ABC123DEF4', issuerId: 'issuer-1' });
  });

  it('keeps the previous key when the proof fails', async () => {
    let accept = true;
    const { deps, keys } = setup(() => (accept ? appleOk() : Response.json({ error: 'App Store Connect refused the key.' }, { status: 401 })));
    await connectApple(deps, { file: new Blob([applePem()]), keyId: 'OLDKEY1234', issuerId: 'issuer-1' });
    const before = await keys.getAppleToken();

    accept = false;
    await expect(connectApple(deps, { file: new Blob([applePem()]), keyId: 'NEWKEY5678', issuerId: 'issuer-2' })).rejects.toThrow(
      new ConnectError('App Store Connect refused the key.')
    );
    expect(await keys.info('apple')).toMatchObject({ keyId: 'OLDKEY1234', issuerId: 'issuer-1' });
    expect(await keys.getAppleToken()).toBe(before);
  });

  it('stores nothing when the first proof fails', async () => {
    const { deps, keys } = setup(() => Response.json({ error: 'no' }, { status: 403 }));
    await expect(connectApple(deps, { file: new Blob([applePem()]), keyId: 'ABC123DEF4', issuerId: 'issuer-1' })).rejects.toBeInstanceOf(ConnectError);
    expect(await keys.info('apple')).toBeNull();
  });

  it('refuses a file that is not a key without calling the server', async () => {
    const { deps, requests } = setup(appleOk);
    await expect(connectApple(deps, { file: new Blob(['not a key']), keyId: 'ABC123DEF4', issuerId: 'issuer-1' })).rejects.toBeInstanceOf(ConnectError);
    expect(requests).toHaveLength(0);
  });

  it('says early when the browser cannot store keys, before reading the file', async () => {
    const broken = new MemoryKeyStore();
    broken.get = async () => {
      throw new BrowserKeyError('storage', 'storage failed');
    };
    const { deps, requests } = setup(appleOk, broken);
    const file = new Blob([applePem()]);
    const text = vi.spyOn(file, 'text');
    await expect(connectApple(deps, { file, keyId: 'ABC123DEF4', issuerId: 'issuer-1' })).rejects.toThrow(STORAGE_MESSAGE);
    expect(text).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
});

describe('connectGoogle', () => {
  it('mints a token with the staged key, proves the package can be read, then stores the key', async () => {
    const { deps, keys, requests } = setup(() => Response.json({ success: true, packageName: 'com.example.app' }));
    const result = await connectGoogle(deps, { file: new Blob([serviceAccountJson()]), packageName: 'com.example.app' });
    expect(result).toEqual({ clientEmail: 'robot@example-project.iam.gserviceaccount.com', projectId: 'example-project', packageName: 'com.example.app' });
    expect(requests[0].url).toBe('/api/auth');
    expect(requests[0].headers.get('x-pk-app')).toBe('com.example.app');
    expect(requests[0].headers.get('x-pk-google-token')).toMatch(/^ya29\.minted-in-browser-/);
    expect(await keys.info('google')).toMatchObject({ clientEmail: 'robot@example-project.iam.gserviceaccount.com' });
  });

  it('keeps the previous key when Google refuses the new one, and passes on the help link', async () => {
    let accept = true;
    const { deps, keys } = setup(() =>
      accept ? Response.json({ success: true }) : Response.json({ error: 'App not found.', helpHref: '/setup-guide/google', helpText: 'Setup guide' }, { status: 404 })
    );
    await connectGoogle(deps, { file: new Blob([serviceAccountJson('old@example-project.iam.gserviceaccount.com')]), packageName: 'com.example.app' });
    accept = false;
    const error = await connectGoogle(deps, { file: new Blob([serviceAccountJson('new@example-project.iam.gserviceaccount.com')]), packageName: 'com.example.gone' }).catch((e) => e);
    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ message: 'App not found.', helpHref: '/setup-guide/google', helpText: 'Setup guide' });
    expect(await keys.info('google')).toMatchObject({ clientEmail: 'old@example-project.iam.gserviceaccount.com' });
  });
});
