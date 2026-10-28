// Types shared by the browser key module. Nothing here holds key material
// except the CryptoKey in StoredKey, which is non-extractable.

export type KeyPlatform = 'apple' | 'google';

/** What callers may see about a stored App Store Connect key: ids only */
export interface AppleKeyInfo {
  platform: 'apple';
  keyId: string;
  issuerId: string;
  /** When the key was imported, in milliseconds since the epoch */
  createdAt: number;
}

/** What callers may see about a stored Google service account key: ids only */
export interface GoogleKeyInfo {
  platform: 'google';
  clientEmail: string;
  privateKeyId: string;
  projectId: string;
  createdAt: number;
}

export type KeyInfo = AppleKeyInfo | GoogleKeyInfo;

/** One record per platform: the non-extractable key and its non-secret ids */
export type StoredKey =
  | (AppleKeyInfo & { key: CryptoKey })
  | (GoogleKeyInfo & { key: CryptoKey });

export type BrowserKeyErrorCode =
  /** The file or a field is missing, malformed or the wrong kind of key */
  | 'invalid_key'
  /** No key is stored for this platform */
  | 'not_connected'
  /** IndexedDB is unavailable or failed */
  | 'storage'
  /** Google refused the key or the assertion */
  | 'token_rejected'
  /** The token endpoint could not be reached or answered unexpectedly */
  | 'network'
  /** The clock correction needed is over 10 minutes: the computer's clock is wrong */
  | 'clock';

/**
 * Errors from this module. Messages are fixed strings or name fields only:
 * they never carry key material, tokens or a response body.
 */
export class BrowserKeyError extends Error {
  constructor(
    public code: BrowserKeyErrorCode,
    message: string,
    /** HTTP status from the token endpoint, when there was one */
    public status?: number
  ) {
    super(message);
    this.name = 'BrowserKeyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
