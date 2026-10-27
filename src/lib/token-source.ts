// Where store API bearer tokens come from.
//
// The Apple and Google clients never see a private key: every request asks a
// TokenSource for a token. Two kinds exist:
// - KeyTokenSource (AppleKeyTokenSource / GoogleKeyTokenSource) holds key
//   credentials in this process and signs or mints tokens from them, using the
//   in-process token cache (src/lib/token-cache.ts). The CLI and MCP server use it.
// - HeaderTokenSource wraps a token the caller already has (e.g. one a browser
//   signed and sent in a request header). It never sees a key.
//
// Key material and tokens live in private (#) fields, so logging or
// JSON-serialising a source never prints them. `label` is a non-secret name
// (an Apple Key ID / Issuer ID, a Google client_email) for logs and per-key
// bookkeeping such as rate-limit tracking.

import { generateJWT } from './apple-connect/client';
import type { AppleConnectCredentials, AppleConnection } from './apple-connect/types';
import { getGoogleAccessToken } from './google-play/client';
import type { ServiceAccountCredentials } from './google-play/types';

export type TokenPlatform = 'apple' | 'google';

export interface TokenSource {
  platform: TokenPlatform;
  /** A bearer token for the store's API */
  getToken(): Promise<string>;
  /** Non-secret name for this source; never key material or a token */
  label: string;
}

/** The fields of an App Store Connect API key needed to sign a JWT */
export type AppleKeyCredentials = Pick<AppleConnectCredentials, 'privateKey' | 'keyId' | 'issuerId'>;

/** Google service account fields needed to mint an access token */
export type GoogleKeyCredentials = Pick<ServiceAccountCredentials, 'client_email' | 'private_key_id' | 'private_key'>;

/** Label for an App Store Connect key: issuer and key ID, both non-secret */
export function appleKeyLabel(issuerId: string, keyId: string): string {
  return `${issuerId}:${keyId}`;
}

/** Signs App Store Connect JWTs (20 minutes, ES256) from a key held in this process */
export class AppleKeyTokenSource implements TokenSource {
  readonly platform = 'apple' as const;
  readonly label: string;
  readonly #credentials: AppleKeyCredentials;

  constructor(credentials: AppleKeyCredentials) {
    // Copy only what signing needs, so nothing else of the caller's object is kept
    this.#credentials = { privateKey: credentials.privateKey, keyId: credentials.keyId, issuerId: credentials.issuerId };
    this.label = appleKeyLabel(credentials.issuerId, credentials.keyId);
  }

  getToken(): Promise<string> {
    return generateJWT(this.#credentials);
  }
}

/** Mints Google access tokens from a service account key held in this process */
export class GoogleKeyTokenSource implements TokenSource {
  readonly platform = 'google' as const;
  readonly label: string;
  readonly #credentials: GoogleKeyCredentials;

  constructor(credentials: GoogleKeyCredentials) {
    this.#credentials = {
      client_email: credentials.client_email,
      private_key_id: credentials.private_key_id,
      private_key: credentials.private_key,
    };
    this.label = credentials.client_email;
  }

  getToken(): Promise<string> {
    return getGoogleAccessToken(this.#credentials);
  }
}

/** Largest token HeaderTokenSource accepts (Apple JWTs and Google access tokens are far smaller) */
export const MAX_HEADER_TOKEN_CHARS = 4096;

/**
 * A token supplied by the caller, used as is. The store checks it; an expired
 * or invalid one comes back as the store's 401, mapped to the usual errors.
 */
export class HeaderTokenSource implements TokenSource {
  readonly #token: string;

  constructor(
    readonly platform: TokenPlatform,
    token: string,
    readonly label: string
  ) {
    if (platform !== 'apple' && platform !== 'google') throw new Error('Unknown token platform');
    if (typeof token !== 'string' || token.length === 0) throw new Error('Token is empty');
    if (token.length > MAX_HEADER_TOKEN_CHARS) throw new Error('Token is too long');
    // A bearer token is one header value: no whitespace or control characters
    if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('Token has invalid characters');
    this.#token = token;
  }

  getToken(): Promise<string> {
    return Promise.resolve(this.#token);
  }
}

/** An App Store Connect connection that signs with the given key, for the key's app (bundleId, '' for none) */
export function appleKeyConnection(credentials: AppleConnectCredentials): AppleConnection {
  return { tokens: new AppleKeyTokenSource(credentials), bundleId: credentials.bundleId };
}
