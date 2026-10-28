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
import { IndexedDbKeyStore, MemoryKeyStore, type KeyStore } from './store';
import {
  APPLE_MAX_MIN_VALID_SECONDS,
  APPLE_RESIGN_MARGIN_SECONDS,
  GOOGLE_MAX_MIN_VALID_SECONDS,
  APPLE_TOKEN_TTL_SECONDS,
  GOOGLE_REFRESH_MARGIN_SECONDS,
  TokenSlot,
  exchangeGoogleAssertion,
  nowSeconds,
  signAppleJwt,
  signGoogleAssertion,
  type CachedToken,
  type Clock,
  type FetchLike,
  type TokenSlotOptions,
} from './sign';
import { BrowserKeyError, type AppleKeyInfo, type GoogleKeyInfo, type KeyInfo, type KeyPlatform, type StoredKey } from './types';

export { BrowserKeyError } from './types';
export type { AppleKeyInfo, BrowserKeyErrorCode, GoogleKeyInfo, KeyInfo, KeyPlatform } from './types';
export type { AppleKeyInput } from './import';
export { IndexedDbKeyStore, MemoryKeyStore, type KeyStore } from './store';
export {
  APPLE_APPLY_MIN_VALID_SECONDS,
  APPLE_AUDIENCE,
  APPLE_TOKEN_TTL_SECONDS,
  GOOGLE_APPLY_MIN_VALID_SECONDS,
  GOOGLE_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
} from './sign';

/**
 * A key imported into memory only, not stored yet: sign tokens with `keys`
 * to prove it, then commit() it into the real store, or drop it (just let it
 * go). Any earlier key stays stored until commit().
 */
export interface StagedKey<I extends KeyInfo = KeyInfo> {
  info: I;
  /** Signs with the staged key only (memory-backed) */
  keys: BrowserKeys;
  /** Store the key (replacing any earlier one) and adopt the staged clock offset */
  commit(): Promise<I>;
}

export interface BrowserKeysOptions {
  /** Defaults to IndexedDB */
  store?: KeyStore;
  /** Defaults to the global fetch; used only for Google's token endpoint */
  fetch?: FetchLike;
  /** Milliseconds since the epoch; defaults to Date.now */
  clock?: Clock;
  /** Added to the clock, e.g. the server's Date minus local time when this computer's clock is wrong */
  clockOffsetMs?: number;
  /**
   * Called after this instance stores, forgets or forgets all keys, e.g. to
   * tell other tabs (which then call dropCached). Never carries key material.
   */
  onChange?: (event: KeyChangeEvent) => void;
}

/** What changed in the key store; ids only */
export type KeyChangeEvent = { type: 'saved' | 'forgot'; platform: KeyPlatform } | { type: 'forgotAll' };

/**
 * - rejected: the token the server just refused (after a 401). A new one is
 *   made only if that is still the cached token, so parallel 401s share one.
 * - minValidSeconds: make a new token unless at least this long is left, for
 *   a long request (APPLE_APPLY_MIN_VALID_SECONDS, GOOGLE_APPLY_MIN_VALID_SECONDS).
 */
export type TokenOptions = TokenSlotOptions;

/** Clock offsets beyond a day are a bad Date header, not a wrong clock */
const MAX_CLOCK_OFFSET_MS = 24 * 60 * 60 * 1000;

function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(-MAX_CLOCK_OFFSET_MS, Math.min(MAX_CLOCK_OFFSET_MS, Math.round(ms)));
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
  private readonly baseClock: Clock;
  private clockOffsetMs: number;
  private readonly clock: Clock = () => this.baseClock() + this.clockOffsetMs;
  private readonly loaded = new Map<KeyPlatform, StoredKey>();
  /** Bumped on every save or forget, so a slow read can't bring back a replaced or forgotten key */
  private readonly versions: Record<KeyPlatform, number> = { apple: 0, google: 0 };
  private readonly slots: Record<KeyPlatform, TokenSlot>;
  private readonly onChange: (event: KeyChangeEvent) => void;

  constructor(options: BrowserKeysOptions = {}) {
    this.onChange = options.onChange ?? (() => {});
    this.store = options.store ?? new IndexedDbKeyStore();
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseClock = options.clock ?? Date.now;
    this.clockOffsetMs = clampOffset(options.clockOffsetMs ?? 0);
    this.slots = {
      apple: new TokenSlot(APPLE_RESIGN_MARGIN_SECONDS, APPLE_MAX_MIN_VALID_SECONDS, this.clock),
      google: new TokenSlot(GOOGLE_REFRESH_MARGIN_SECONDS, GOOGLE_MAX_MIN_VALID_SECONDS, this.clock),
    };
  }

  /**
   * Correct for a wrong local clock: tokens are signed at local time plus
   * this offset (capped at a day). Changing it drops cached tokens, which were
   * signed with the old time.
   */
  setClockOffsetMs(ms: number): void {
    const next = clampOffset(ms);
    if (next === this.clockOffsetMs) return;
    this.clockOffsetMs = next;
    this.slots.apple.reset();
    this.slots.google.reset();
  }

  getClockOffsetMs(): number {
    return this.clockOffsetMs;
  }

  /** Import an App Store Connect .p8 key and keep it in this browser, replacing any earlier one */
  async importApple(input: AppleKeyInput): Promise<AppleKeyInfo> {
    const imported = await importAppleKey(input);
    const record: StoredKey = { platform: 'apple', keyId: imported.keyId, issuerId: imported.issuerId, createdAt: this.clock(), key: imported.key };
    await this.save(record);
    this.emit({ type: 'saved', platform: 'apple' });
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
    this.emit({ type: 'saved', platform: 'google' });
    return toInfo(record) as GoogleKeyInfo;
  }

  /** Import an App Store Connect key into memory only, to prove before storing (see StagedKey) */
  async stageApple(input: AppleKeyInput): Promise<StagedKey<AppleKeyInfo>> {
    const staged = this.stagingInstance();
    const info = await staged.importApple(input);
    return { info, keys: staged, commit: () => this.commitFrom(staged, 'apple') as Promise<AppleKeyInfo> };
  }

  /** Import a Google service account key into memory only, to prove before storing (see StagedKey) */
  async stageGoogle(json: string | object): Promise<StagedKey<GoogleKeyInfo>> {
    const staged = this.stagingInstance();
    const info = await staged.importGoogle(json);
    return { info, keys: staged, commit: () => this.commitFrom(staged, 'google') as Promise<GoogleKeyInfo> };
  }

  private stagingInstance(): BrowserKeys {
    return new BrowserKeys({ store: new MemoryKeyStore(), fetch: this.fetchFn, clock: this.baseClock, clockOffsetMs: this.clockOffsetMs });
  }

  private async commitFrom(staged: BrowserKeys, platform: KeyPlatform): Promise<KeyInfo> {
    const record = await staged.load(platform);
    if (!record) throw notConnected(platform);
    this.setClockOffsetMs(staged.getClockOffsetMs());
    await this.save(record);
    this.emit({ type: 'saved', platform });
    return toInfo(record);
  }

  /** The stored key's ids, or null when none is stored */
  async info(platform: KeyPlatform): Promise<KeyInfo | null> {
    const record = await this.load(platform);
    return record ? toInfo(record) : null;
  }

  /** An App Store Connect JWT (20 minutes), re-signed once under 2 minutes remain */
  async getAppleToken(options: TokenOptions = {}): Promise<string> {
    return this.token('apple', options, async () => {
      const record = await this.require('apple');
      if (record.platform !== 'apple') throw notConnected('apple');
      const iat = nowSeconds(this.clock);
      const token = await signAppleJwt(record.key, record, iat);
      return { token, expiresAt: iat + APPLE_TOKEN_TTL_SECONDS };
    });
  }

  /** A Google access token minted by the browser at Google's token endpoint, reused until near expiry */
  async getGoogleAccessToken(options: TokenOptions = {}): Promise<string> {
    return this.token('google', options, async () => {
      const record = await this.require('google');
      if (record.platform !== 'google') throw notConnected('google');
      const iat = nowSeconds(this.clock);
      const assertion = await signGoogleAssertion(record.key, record, iat);
      const { accessToken, expiresIn } = await exchangeGoogleAssertion(assertion, this.fetchFn);
      return { token: accessToken, expiresAt: iat + expiresIn };
    });
  }

  /**
   * Delete this platform's key from the browser and drop its tokens. The
   * store is cleared first: if that fails the error is thrown and nothing is
   * dropped, so callers must show it (the key is still stored).
   */
  async forget(platform: KeyPlatform): Promise<void> {
    await this.store.delete(platform);
    this.drop(platform);
    this.emit({ type: 'forgot', platform });
  }

  /** Delete every stored key and token (sign out). Throws, dropping nothing, if the store can't be cleared; callers must show that. */
  async forgetAll(): Promise<void> {
    await this.store.clear();
    this.drop('apple');
    this.drop('google');
    this.emit({ type: 'forgotAll' });
  }

  /**
   * Drop this instance's cached key and tokens for a platform, so the next
   * use reads the store again. For another tab's change (see onChange); the
   * store itself is untouched.
   */
  dropCached(platform: KeyPlatform): void {
    this.drop(platform);
  }

  private emit(event: KeyChangeEvent): void {
    try {
      this.onChange(event);
    } catch {
      // a listener's failure never undoes or hides the change
    }
  }

  private drop(platform: KeyPlatform): void {
    this.versions[platform] += 1;
    this.slots[platform].reset();
    this.loaded.delete(platform);
  }

  /**
   * A token from the platform's slot, made from the key current when it
   * finishes: if the key was replaced or forgotten meanwhile, the token (made
   * from the old key) is not returned. One retry against the current key,
   * which throws not_connected when there is none.
   */
  private async token(platform: KeyPlatform, options: TokenOptions, make: () => Promise<CachedToken>): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const version = this.versions[platform];
      const token = await this.slots[platform].get(make, options);
      if (version === this.versions[platform]) return token;
    }
    throw notConnected(platform);
  }

  private async save(record: StoredKey): Promise<void> {
    // Claim a version first, so a forget or a later import that starts while
    // this is being written wins (the store applies writes in order)
    const version = ++this.versions[record.platform];
    await this.store.put(record);
    if (version !== this.versions[record.platform]) return;
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
