// Token sources that hold store keys in this process (the CLI and MCP server).
//
// AppleKeyTokenSource signs App Store Connect JWTs (20 minutes, ES256) and
// GoogleKeyTokenSource mints Google access tokens, both through the existing
// in-process token cache (src/lib/token-cache.ts). Key material lives in
// private (#) fields, so logging or JSON-serialising a source never prints it.
// The TokenSource interface and HeaderTokenSource are in src/lib/token-source.ts.

import { generateJWT } from './apple-connect/client';
import type { AppleConnectCredentials, AppleConnection } from './apple-connect/types';
import { getGoogleAccessToken } from './google-play/client';
import type { ServiceAccountCredentials } from './google-play/types';
import type { TokenSource } from './token-source';

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

/** An App Store Connect connection that signs with the given key, for the key's app (bundleId, '' for none) */
export function appleKeyConnection(credentials: AppleConnectCredentials): AppleConnection {
  return { tokens: new AppleKeyTokenSource(credentials), bundleId: credentials.bundleId };
}
