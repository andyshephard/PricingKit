// IndexedDbKeyStore against a minimal in-memory IndexedDB: just the calls the
// store makes, firing events asynchronously as a browser does. Values are kept
// by structured clone, as IndexedDB does.

import { describe, it, expect } from 'vitest';
import { IndexedDbKeyStore, KEY_DB_NAME, KEY_STORE_NAME, MemoryKeyStore } from '../store';
import { BrowserKeys } from '..';
import { BrowserKeyError, type StoredKey } from '../types';
import { importAppleKey } from '../import';
import { makeAppleKey, verifyJwt } from './keys';

type Handler = (() => void) | null;

class FakeRequest<T = unknown> {
  result!: T;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  constructor(
    private readonly data: Map<string, unknown>,
    private readonly keyPath: string,
    private readonly fail: boolean
  ) {}

  objectStore() {
    const op = <T>(fn: () => T): FakeRequest<T> => {
      const req = new FakeRequest<T>();
      setTimeout(() => {
        if (this.fail) {
          req.onerror?.();
          this.onerror?.();
          return;
        }
        req.result = fn();
        req.onsuccess?.();
        this.oncomplete?.();
      });
      return req;
    };
    return {
      get: (key: string) => op(() => (this.data.has(key) ? structuredClone(this.data.get(key)) : undefined)),
      put: (value: Record<string, unknown>) => op(() => void this.data.set(value[this.keyPath] as string, structuredClone(value))),
      delete: (key: string) => op(() => void this.data.delete(key)),
      clear: () => op(() => this.data.clear()),
    };
  }
}

class FakeDatabase {
  stores = new Map<string, { keyPath: string; data: Map<string, unknown> }>();
  failWrites = false;
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string, options: { keyPath: string }) {
    this.stores.set(name, { keyPath: options.keyPath, data: new Map() });
  }
  transaction(name: string, mode: string) {
    const store = this.stores.get(name);
    if (!store) throw new Error('NotFoundError');
    return new FakeTransaction(store.data, store.keyPath, this.failWrites && mode === 'readwrite');
  }
}

class FakeFactory {
  databases = new Map<string, FakeDatabase>();
  opens = 0;
  failOpen = false;
  open(name: string) {
    this.opens += 1;
    const req = new FakeRequest<FakeDatabase>();
    setTimeout(() => {
      if (this.failOpen) {
        req.onerror?.();
        return;
      }
      let db = this.databases.get(name);
      if (!db) {
        db = new FakeDatabase();
        this.databases.set(name, db);
        req.result = db;
        req.onupgradeneeded?.();
      }
      req.result = db;
      req.onsuccess?.();
    });
    return req;
  }
}

function asFactory(fake: FakeFactory): IDBFactory {
  return fake as unknown as IDBFactory;
}

async function appleRecord(): Promise<StoredKey> {
  const { key } = await importAppleKey({ privateKeyPem: (await makeAppleKey()).pem, keyId: 'K', issuerId: 'I' });
  return { platform: 'apple', keyId: 'K', issuerId: 'I', createdAt: 1, key };
}

describe('IndexedDbKeyStore', () => {
  it('creates one object store keyed by platform', async () => {
    const fake = new FakeFactory();
    await new IndexedDbKeyStore(asFactory(fake)).get('apple');
    expect(fake.databases.get(KEY_DB_NAME)?.stores.get(KEY_STORE_NAME)?.keyPath).toBe('platform');
  });

  it('puts, gets and deletes a record per platform', async () => {
    const store = new IndexedDbKeyStore(asFactory(new FakeFactory()));
    const record = await appleRecord();
    expect(await store.get('apple')).toBeNull();
    await store.put(record);
    const read = await store.get('apple');
    expect(read).toMatchObject({ platform: 'apple', keyId: 'K', issuerId: 'I', createdAt: 1 });
    // The key survives the structured clone and is still non-extractable
    expect(read?.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', read!.key)).rejects.toThrow();
    expect(await store.get('google')).toBeNull();
    await store.delete('apple');
    expect(await store.get('apple')).toBeNull();
  });

  it('clear() removes every record', async () => {
    const store = new IndexedDbKeyStore(asFactory(new FakeFactory()));
    await store.put(await appleRecord());
    await store.clear();
    expect(await store.get('apple')).toBeNull();
  });

  it('opens the database once', async () => {
    const fake = new FakeFactory();
    const store = new IndexedDbKeyStore(asFactory(fake));
    await Promise.all([store.get('apple'), store.get('google'), store.get('apple')]);
    expect(fake.opens).toBe(1);
  });

  it('reads a malformed record as no key', async () => {
    const fake = new FakeFactory();
    const store = new IndexedDbKeyStore(asFactory(fake));
    await store.get('apple');
    fake.databases.get(KEY_DB_NAME)!.stores.get(KEY_STORE_NAME)!.data.set('apple', { platform: 'apple', keyId: 'K' });
    expect(await store.get('apple')).toBeNull();
  });

  it('fails with a storage error when IndexedDB is missing, and retries a failed open', async () => {
    await expect(new IndexedDbKeyStore(undefined).get('apple')).rejects.toMatchObject({ code: 'storage' });
    const fake = new FakeFactory();
    fake.failOpen = true;
    const store = new IndexedDbKeyStore(asFactory(fake));
    await expect(store.get('apple')).rejects.toBeInstanceOf(BrowserKeyError);
    fake.failOpen = false;
    expect(await store.get('apple')).toBeNull();
    expect(fake.opens).toBe(2);
  });

  it('fails with a storage error when a write fails', async () => {
    const fake = new FakeFactory();
    const store = new IndexedDbKeyStore(asFactory(fake));
    await store.get('apple');
    fake.databases.get(KEY_DB_NAME)!.failWrites = true;
    await expect(store.put(await appleRecord())).rejects.toMatchObject({ code: 'storage' });
  });

  it('keeps a key for a later page: BrowserKeys signs from a key stored in an earlier session', async () => {
    const fake = new FakeFactory();
    const apple = await makeAppleKey();
    await new BrowserKeys({ store: new IndexedDbKeyStore(asFactory(fake)) }).importApple({ privateKeyPem: apple.pem, keyId: 'K', issuerId: 'I' });
    const later = new BrowserKeys({ store: new IndexedDbKeyStore(asFactory(fake)) });
    expect(await later.info('apple')).toMatchObject({ platform: 'apple', keyId: 'K', issuerId: 'I' });
    expect(await verifyJwt(await later.getAppleToken(), apple.publicKey)).toBe(true);
  });

  it('BrowserKeys does not keep a key when the store refuses it', async () => {
    const fake = new FakeFactory();
    const store = new IndexedDbKeyStore(asFactory(fake));
    await store.get('apple');
    fake.databases.get(KEY_DB_NAME)!.failWrites = true;
    const keys = new BrowserKeys({ store });
    await expect(keys.importApple({ privateKeyPem: (await makeAppleKey()).pem, keyId: 'K', issuerId: 'I' })).rejects.toMatchObject({ code: 'storage' });
    await expect(keys.getAppleToken()).rejects.toMatchObject({ code: 'not_connected' });
  });
});

describe('MemoryKeyStore', () => {
  it('implements the same contract', async () => {
    const store = new MemoryKeyStore();
    const record = await appleRecord();
    await store.put(record);
    expect(await store.get('apple')).toEqual(record);
    await store.delete('apple');
    expect(await store.get('apple')).toBeNull();
  });
});
