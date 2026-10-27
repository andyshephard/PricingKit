// Where store API bearer tokens come from.
//
// The Apple and Google clients never see a private key: every request asks a
// TokenSource for a token. Two kinds exist:
// - HeaderTokenSource (here) wraps a token the caller already has (e.g. one a
//   browser signed and sent in a request header). It never sees a key.
// - AppleKeyTokenSource / GoogleKeyTokenSource (src/lib/key-token-source.ts)
//   hold key credentials in this process and sign or mint tokens from them.
//   The CLI and MCP server use them. This module has no runtime import of
//   that signing code.
//
// Tokens live in private (#) fields, so logging or JSON-serialising a source
// never prints them. `label` is a non-secret name (an Apple Key ID / Issuer
// ID, a Google client_email) for logs.

import { ApiError } from './utils/api-error';

export type TokenPlatform = 'apple' | 'google';

export interface TokenSource {
  readonly platform: TokenPlatform;
  /** A bearer token for the store's API */
  getToken(): Promise<string>;
  /** Non-secret name for this source; never key material or a token */
  readonly label: string;
}

const STORE_NAMES: Record<TokenPlatform, string> = { apple: 'App Store Connect', google: 'Google Play' };

/**
 * Throws unless the token source is for the given store, so one store's token
 * is never sent to the other. The clients and adapters call this.
 */
export function assertTokenPlatform(tokens: TokenSource, platform: TokenPlatform): void {
  if (tokens?.platform !== platform) {
    throw new ApiError(`${STORE_NAMES[platform]} requests need a ${STORE_NAMES[platform]} token source`, {
      status: 500,
      code: 'WRONG_TOKEN_PLATFORM',
      platform,
      retryable: false,
    });
  }
}

/** Largest token HeaderTokenSource accepts (Apple JWTs and Google access tokens are far smaller) */
export const MAX_HEADER_TOKEN_CHARS = 4096;

/** Printable ASCII, 1 to 200 characters */
const LABEL_PATTERN = /^[\x20-\x7e]{1,200}$/;

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
    if (typeof label !== 'string' || !LABEL_PATTERN.test(label)) throw new Error('Label must be 1 to 200 printable characters');
    // The label is logged; it must never carry the token
    if (label.includes(token)) throw new Error('Label must not contain the token');
    this.#token = token;
  }

  getToken(): Promise<string> {
    return Promise.resolve(this.#token);
  }
}
