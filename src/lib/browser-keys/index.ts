// Browser-held store keys.
//
// The App Store Connect .p8 key and the Google service account key are
// imported in the browser as non-extractable CryptoKeys, kept in IndexedDB
// until forgotten, and used to sign short-lived tokens. The PricingKit server
// only ever receives those tokens, never a key.
//
// Callers get key ids (KeyInfo) and tokens back, never key material. Nothing
// here logs.

import { importAppleKey, importGoogleKey, type AppleKeyInput } from './import';
import { IndexedDbKeyStore, type KeyStore } from './store';
import {
  APPLE_RESIGN_MARGIN_SECONDS,
  APPLE_TOKEN_TTL_SECONDS,
  GOOGLE_REFRESH_MARGIN_SECONDS,
  TokenSlot,
  exchangeGoogleAssertion,
  nowSeconds,
  signAppleJwt,
  signGoogleAssertion,
  type Clock,
  type FetchLike,
} from './sign';
import { BrowserKeyError, type AppleKeyInfo, type GoogleKeyInfo, type KeyInfo, type KeyPlatform, type StoredKey } from './types';

export { BrowserKeyError } from './types';
export type { AppleKeyInfo, BrowserKeyErrorCode, GoogleKeyInfo, KeyInfo, KeyPlatform } from './types';
export type { AppleKeyInput } from './import';
export { IndexedDbKeyStore, MemoryKeyStore, type KeyStore } from './store';
export { APPLE_AUDIENCE, APPLE_TOKEN_TTL_SECONDS, GOOGLE_SCOPE, GOOGLE_TOKEN_ENDPOINT } from './sign';

export interface BrowserKeysOptions {
  /** Defaults to IndexedDB */
  store?: KeyStore;
  /** Defaults to the global fetch; used only for Google's token endpoint */
  fetch?: FetchLike;
  /** Milliseconds since the epoch; defaults to Date.now */
  clock?: Clock;
}

export interface TokenOptions {
  /** Ignore the cached token and sign or mint a new one (e.g. after a 401) */
  forceRefresh?: boolean;
}

function toInfo(record: StoredKey): KeyInfo {
  if (record.platform === 'apple') {
    const { platform, keyId, issuerId, createdAt } = record;
    return { platform, keyId, issuerId, createdAt };
  }
  const { platform, clientEmail, privateKeyId, projectId, createdAt } = record;
  return { platform, clientEmail, privateKeyId, projectId, createdAt };
}

function notConnected(platform: KeyPlatform): BrowserKeyError {
  return new BrowserKeyError(
    'not_connected',
    platform === 'apple' ? 'No App Store Connect key is stored in this browser. Connect again.' : 'No Google Play key is stored in this browser. Connect again.'
  );
}

export class BrowserKeys {
  private readonly store: KeyStore;
  private readonly fetchFn: FetchLike;
  private readonly clock: Clock;
  private readonly loaded = new Map<KeyPlatform, StoredKey>();
  /** Bumped on every save or forget, so a slow read can't bring back a replaced or forgotten key */
  private readonly versions: Record<KeyPlatform, number> = { apple: 0, google: 0 };
  private readonly slots: Record<KeyPlatform, TokenSlot>;

  constructor(options: BrowserKeysOptions = {}) {
    this.store = options.store ?? new IndexedDbKeyStore();
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? Date.now;
    this.slots = {
      apple: new TokenSlot(APPLE_RESIGN_MARGIN_SECONDS, this.clock),
      google: new TokenSlot(GOOGLE_REFRESH_MARGIN_SECONDS, this.clock),
    };
  }

  /** Import an App Store Connect .p8 key and keep it in this browser, replacing any earlier one */
  async importApple(input: AppleKeyInput): Promise<AppleKeyInfo> {
    const imported = await importAppleKey(input);
    const record: StoredKey = { platform: 'apple', keyId: imported.keyId, issuerId: imported.issuerId, createdAt: this.clock(), key: imported.key };
    await this.save(record);
    return toInfo(record) as AppleKeyInfo;
  }

  /** Import a Google service account key (the JSON file's text) and keep it, replacing any earlier one */
  async importGoogle(json: string | object): Promise<GoogleKeyInfo> {
    const imported = await importGoogleKey(json);
    const record: StoredKey = {
      platform: 'google',
      clientEmail: imported.clientEmail,
      privateKeyId: imported.privateKeyId,
      projectId: imported.projectId,
      createdAt: this.clock(),
      key: imported.key,
    };
    await this.save(record);
    return toInfo(record) as GoogleKeyInfo;
  }

  /** The stored key's ids, or null when none is stored */
  async info(platform: KeyPlatform): Promise<KeyInfo | null> {
    const record = await this.load(platform);
    return record ? toInfo(record) : null;
  }

  /** An App Store Connect JWT (20 minutes), re-signed once under 2 minutes remain */
  async getAppleToken(options: TokenOptions = {}): Promise<string> {
    return this.slots.apple.get(async () => {
      const record = await this.require('apple');
      if (record.platform !== 'apple') throw notConnected('apple');
      const iat = nowSeconds(this.clock);
      const token = await signAppleJwt(record.key, record, iat);
      return { token, expiresAt: iat + APPLE_TOKEN_TTL_SECONDS };
    }, options);
  }

  /** A Google access token minted by the browser at Google's token endpoint, reused until near expiry */
  async getGoogleAccessToken(options: TokenOptions = {}): Promise<string> {
    return this.slots.google.get(async () => {
      const record = await this.require('google');
      if (record.platform !== 'google') throw notConnected('google');
      const iat = nowSeconds(this.clock);
      const assertion = await signGoogleAssertion(record.key, record, iat);
      const { accessToken, expiresIn } = await exchangeGoogleAssertion(assertion, this.fetchFn);
      return { token: accessToken, expiresAt: iat + expiresIn };
    }, options);
  }

  /** Delete this platform's key from the browser and drop its tokens */
  async forget(platform: KeyPlatform): Promise<void> {
    this.versions[platform] += 1;
    this.slots[platform].reset();
    this.loaded.delete(platform);
    await this.store.delete(platform);
  }

  /** Delete every stored key and token (sign out) */
  async forgetAll(): Promise<void> {
    for (const platform of ['apple', 'google'] as const) {
      this.versions[platform] += 1;
      this.slots[platform].reset();
    }
    this.loaded.clear();
    await this.store.clear();
  }

  private async save(record: StoredKey): Promise<void> {
    await this.store.put(record);
    this.versions[record.platform] += 1;
    this.slots[record.platform].reset();
    this.loaded.set(record.platform, record);
  }

  private async load(platform: KeyPlatform): Promise<StoredKey | null> {
    const cached = this.loaded.get(platform);
    if (cached) return cached;
    const version = this.versions[platform];
    const record = await this.store.get(platform);
    if (record && version === this.versions[platform]) this.loaded.set(platform, record);
    return record;
  }

  private async require(platform: KeyPlatform): Promise<StoredKey> {
    const record = await this.load(platform);
    if (!record) throw notConnected(platform);
    return record;
  }
}
