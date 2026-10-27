// Where the browser keeps imported keys: one record per platform in
// IndexedDB. IndexedDB stores a CryptoKey by structured clone, and a
// non-extractable key stays non-extractable when it is read back.
//
// Records stay until forgotten (sign out or "Forget this key").

import { BrowserKeyError, type KeyPlatform, type StoredKey } from './types';

export interface KeyStore {
  get(platform: KeyPlatform): Promise<StoredKey | null>;
  put(record: StoredKey): Promise<void>;
  delete(platform: KeyPlatform): Promise<void>;
  clear(): Promise<void>;
}

/** For tests and for browsers without IndexedDB: kept only while the page is open */
export class MemoryKeyStore implements KeyStore {
  private records = new Map<KeyPlatform, StoredKey>();

  async get(platform: KeyPlatform): Promise<StoredKey | null> {
    return this.records.get(platform) ?? null;
  }

  async put(record: StoredKey): Promise<void> {
    this.records.set(record.platform, { ...record });
  }

  async delete(platform: KeyPlatform): Promise<void> {
    this.records.delete(platform);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

export const KEY_DB_NAME = 'pricingkit-keys';
export const KEY_DB_VERSION = 1;
export const KEY_STORE_NAME = 'keys';

function storageError(): BrowserKeyError {
  // The DOMException is never passed on: its message can name browser internals
  return new BrowserKeyError('storage', "This browser couldn't store the key. Check that site data isn't blocked (private windows may block it).");
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(storageError());
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(storageError());
    tx.onabort = () => reject(storageError());
  });
}

const ALGORITHM: Record<KeyPlatform, string> = { apple: 'ECDSA', google: 'RSASSA-PKCS1-v1_5' };

/** A private, non-extractable signing key for this platform's algorithm */
function isSigningKey(key: unknown, platform: KeyPlatform): key is CryptoKey {
  return (
    typeof CryptoKey !== 'undefined' &&
    key instanceof CryptoKey &&
    key.type === 'private' &&
    key.extractable === false &&
    key.usages.includes('sign') &&
    key.algorithm.name === ALGORITHM[platform]
  );
}

function isStoredKey(value: unknown, platform: KeyPlatform): value is StoredKey {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.platform !== platform || typeof v.createdAt !== 'number' || !isSigningKey(v.key, platform)) return false;
  if (platform === 'apple') return typeof v.keyId === 'string' && typeof v.issuerId === 'string';
  return typeof v.clientEmail === 'string' && typeof v.privateKeyId === 'string' && typeof v.projectId === 'string';
}

/** The IndexedDB store. Pass a factory to use something other than the global indexedDB. */
export class IndexedDbKeyStore implements KeyStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      const factory = this.factory;
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        if (!factory) {
          reject(storageError());
          return;
        }
        let req: IDBOpenDBRequest;
        try {
          req = factory.open(KEY_DB_NAME, KEY_DB_VERSION);
        } catch {
          reject(storageError());
          return;
        }
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(KEY_STORE_NAME)) {
            req.result.createObjectStore(KEY_STORE_NAME, { keyPath: 'platform' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          // Drop the cached connection when the browser closes it, or when another
          // tab upgrades the database (closing it so that upgrade isn't blocked)
          db.onclose = () => this.drop(opening);
          db.onversionchange = () => {
            db.close();
            this.drop(opening);
          };
          resolve(db);
        };
        req.onerror = () => reject(storageError());
        // onblocked is not a failure: another tab holds an older version open,
        // and success (or error) follows once it closes
      });
      const opening = this.db;
      // A failed open is retried on the next call rather than cached
      opening.catch(() => this.drop(opening));
    }
    return this.db;
  }

  private drop(connection: Promise<IDBDatabase>): void {
    if (this.db === connection) this.db = null;
  }

  /** One request in its own transaction. A connection that has gone away (a sync throw) is reopened once. */
  private async run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>, retried = false): Promise<T> {
    const connection = this.open();
    const db = await connection;
    let tx: IDBTransaction;
    let req: IDBRequest<T>;
    try {
      tx = db.transaction(KEY_STORE_NAME, mode);
      req = fn(tx.objectStore(KEY_STORE_NAME));
    } catch {
      this.drop(connection);
      if (!retried) return this.run(mode, fn, true);
      throw storageError();
    }
    const [result] = await Promise.all([request(req), done(tx)]);
    return result;
  }

  async get(platform: KeyPlatform): Promise<StoredKey | null> {
    const value: unknown = await this.run('readonly', (s) => s.get(platform));
    // Anything that isn't a well-formed record (an older shape, a hand edit) reads as no key
    return isStoredKey(value, platform) ? value : null;
  }

  async put(record: StoredKey): Promise<void> {
    await this.run('readwrite', (s) => s.put(record));
  }

  async delete(platform: KeyPlatform): Promise<void> {
    await this.run('readwrite', (s) => s.delete(platform));
  }

  async clear(): Promise<void> {
    await this.run('readwrite', (s) => s.clear());
  }
}
