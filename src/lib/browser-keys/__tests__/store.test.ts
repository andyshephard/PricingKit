// IndexedDbKeyStore against fake-indexeddb, a full in-memory IndexedDB
// (real transaction ordering, structured clone, versionchange and close).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { IDBDatabase as FakeIDBDatabase, IDBFactory as FakeIDBFactory, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { IndexedDbKeyStore, KEY_DB_NAME, KEY_DB_VERSION, KEY_STORE_NAME, MemoryKeyStore } from '../store';
import { BrowserKeys } from '..';
import { BrowserKeyError, type StoredKey } from '../types';
import { importAppleKey } from '../import';
import { makeAppleKey, verifyJwt } from './keys';

afterEach(() => {
  vi.restoreAllMocks();
});

function factory(): IDBFactory {
  return new FakeIDBFactory() as unknown as IDBFactory;
}

async function appleRecord(keyId = 'K'): Promise<StoredKey> {
  const { key } = await importAppleKey({ privateKeyPem: (await makeAppleKey()).pem, keyId, issuerId: 'I' });
  return { platform: 'apple', keyId, issuerId: 'I', createdAt: 1, key };
}

function openRaw(f: IDBFactory, version = KEY_DB_VERSION): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = f.open(KEY_DB_NAME, version);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writeRaw(f: IDBFactory, value: unknown): Promise<void> {
  const db = await openRaw(f);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(KEY_STORE_NAME, 'readwrite');
    tx.objectStore(KEY_STORE_NAME).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** The store's cached connection, for tests that close it under the store */
function connectionOf(store: IndexedDbKeyStore): Promise<IDBDatabase> {
  return (store as unknown as { db: Promise<IDBDatabase> }).db;
}

describe('IndexedDbKeyStore', () => {
  it('creates one object store keyed by platform', async () => {
    const f = factory();
    await new IndexedDbKeyStore(f).get('apple');
    const db = await openRaw(f);
    expect(db.transaction(KEY_STORE_NAME).objectStore(KEY_STORE_NAME).keyPath).toBe('platform');
    db.close();
  });

  it('puts, gets and deletes a record per platform; the key stays non-extractable', async () => {
    const store = new IndexedDbKeyStore(factory());
    expect(await store.get('apple')).toBeNull();
    await store.put(await appleRecord());
    const read = await store.get('apple');
    expect(read).toMatchObject({ platform: 'apple', keyId: 'K', issuerId: 'I', createdAt: 1 });
    expect(read?.key).toBeInstanceOf(CryptoKey);
    expect(read?.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', read!.key)).rejects.toThrow();
    expect(await store.get('google')).toBeNull();
    await store.delete('apple');
    expect(await store.get('apple')).toBeNull();
  });

  it('clear() removes every record', async () => {
    const store = new IndexedDbKeyStore(factory());
    await store.put(await appleRecord());
    await store.clear();
    expect(await store.get('apple')).toBeNull();
  });

  it('applies writes in the order they were made', async () => {
    const store = new IndexedDbKeyStore(factory());
    const [a, b] = [await appleRecord('A'), await appleRecord('B')];
    await Promise.all([store.put(a), store.delete('apple')]);
    expect(await store.get('apple')).toBeNull();
    await Promise.all([store.delete('apple'), store.put(a)]);
    expect(await store.get('apple')).toMatchObject({ keyId: 'A' });
    await Promise.all([store.put(a), store.put(b)]);
    expect(await store.get('apple')).toMatchObject({ keyId: 'B' });
    await Promise.all([store.put(a), store.clear()]);
    expect(await store.get('apple')).toBeNull();
  });

  it('opens the database once', async () => {
    const f = factory();
    const open = vi.spyOn(f, 'open');
    const store = new IndexedDbKeyStore(f);
    await Promise.all([store.get('apple'), store.get('google'), store.get('apple')]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('reads anything but a private, non-extractable signing key of the right algorithm as no key', async () => {
    const f = factory();
    const store = new IndexedDbKeyStore(f);
    await store.get('apple');
    const ids = { platform: 'apple', keyId: 'K', issuerId: 'I', createdAt: 1 };
    const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const ecFixed = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const rsa = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
    const hmac = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    for (const key of [{ type: 'private' }, ec.privateKey, ecFixed.publicKey, rsa.privateKey, hmac]) {
      await writeRaw(f, { ...ids, key });
      expect(await store.get('apple')).toBeNull();
    }
    await writeRaw(f, { platform: 'apple', keyId: 'K', createdAt: 1, key: ecFixed.privateKey });
    expect(await store.get('apple')).toBeNull();
    await writeRaw(f, { ...ids, key: ecFixed.privateKey });
    expect(await store.get('apple')).not.toBeNull();
  });

  it('fails with a storage error when IndexedDB is missing', async () => {
    await expect(new IndexedDbKeyStore(undefined).get('apple')).rejects.toMatchObject({ code: 'storage' });
  });

  it('retries a failed open on the next call', async () => {
    const f = factory();
    const open = vi.spyOn(f, 'open').mockImplementationOnce(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const store = new IndexedDbKeyStore(f);
    const error = await store.get('apple').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserKeyError);
    expect((error as Error).message).not.toContain('denied');
    expect(await store.get('apple')).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('reopens once when the cached connection was closed (a sync throw in run)', async () => {
    const f = factory();
    const open = vi.spyOn(f, 'open');
    const store = new IndexedDbKeyStore(f);
    await store.put(await appleRecord());
    (await connectionOf(store)).close();
    expect(await store.get('apple')).toMatchObject({ keyId: 'K' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('reopens once when objectStore or the request throws, and gives up after the retry', async () => {
    const store = new IndexedDbKeyStore(factory());
    const record = await appleRecord();
    const put = vi.spyOn(FakeIDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('gone', 'InvalidStateError');
    });
    await store.put(record);
    expect(put).toHaveBeenCalledTimes(2);
    expect(await store.get('apple')).toMatchObject({ keyId: 'K' });

    const transaction = vi.spyOn(FakeIDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new DOMException('gone', 'InvalidStateError');
    });
    await expect(store.get('apple')).rejects.toMatchObject({ code: 'storage' });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('drops the cached connection when the browser closes it', async () => {
    const f = factory();
    const open = vi.spyOn(f, 'open');
    const store = new IndexedDbKeyStore(f);
    await store.get('apple');
    const db = await connectionOf(store);
    db.onclose?.call(db, new Event('close'));
    await store.get('apple');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("closes its connection when another tab upgrades the database, so the upgrade isn't blocked", async () => {
    const f = factory();
    const store = new IndexedDbKeyStore(f);
    await store.get('apple');
    const upgraded = await Promise.race([
      openRaw(f, KEY_DB_VERSION + 1).then((db) => {
        db.close();
        return 'opened';
      }),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 1000)),
    ]);
    expect(upgraded).toBe('opened');
    expect(connectionOf(store)).toBeNull();
    // This build can't open the newer database: a storage error, not a hang
    await expect(store.get('apple')).rejects.toMatchObject({ code: 'storage' });
  });

  it('keeps a key for a later page: BrowserKeys signs from a key stored in an earlier session', async () => {
    const f = factory();
    const apple = await makeAppleKey();
    await new BrowserKeys({ store: new IndexedDbKeyStore(f) }).importApple({ privateKeyPem: apple.pem, keyId: 'K', issuerId: 'I' });
    const later = new BrowserKeys({ store: new IndexedDbKeyStore(f) });
    expect(await later.info('apple')).toMatchObject({ platform: 'apple', keyId: 'K', issuerId: 'I' });
    expect(await verifyJwt(await later.getAppleToken(), apple.publicKey)).toBe(true);
    await later.forgetAll();
    expect(await new IndexedDbKeyStore(f).get('apple')).toBeNull();
  });

  it('BrowserKeys does not keep a key when the store refuses it', async () => {
    const store = new IndexedDbKeyStore(factory());
    vi.spyOn(FakeIDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
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
