// Connecting a store: the key file is read and imported in this browser, then
// proved with one read-only call. The file's text lives only in a local
// variable here; the imported key can't be read back out (non-extractable).
// If the proof fails, the key is forgotten again.

import { BrowserKeyError, type BrowserKeys, type KeyPlatform } from '@/lib/browser-keys';
import type { ApiFetch } from './api-fetch';

export interface AppleAppSummary {
  id: string;
  name: string;
  bundleId: string;
  sku: string | null;
}

export class ConnectError extends Error {
  constructor(
    message: string,
    /** Optional link to the setup guide section that fixes this */
    public helpHref?: string,
    public helpText?: string
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

const STORAGE_MESSAGE =
  "This browser can't store the key (IndexedDB is unavailable, for example in some private windows or when site data is blocked). PricingKit keeps your key in this browser, so it needs IndexedDB to connect.";

function importError(error: unknown, fallback: string): ConnectError {
  if (error instanceof BrowserKeyError) {
    return new ConnectError(error.code === 'storage' ? STORAGE_MESSAGE : error.message);
  }
  return new ConnectError(fallback);
}

async function errorMessage(response: Response, fallback: string): Promise<ConnectError> {
  const data = (await response.json().catch(() => ({}))) as { error?: unknown; helpHref?: unknown; helpText?: unknown };
  return new ConnectError(
    typeof data.error === 'string' && data.error ? data.error : fallback,
    typeof data.helpHref === 'string' ? data.helpHref : undefined,
    typeof data.helpText === 'string' ? data.helpText : undefined
  );
}

/** Forget a key that failed its proof; never hides the original error */
async function forgetQuietly(keys: BrowserKeys, platform: KeyPlatform): Promise<void> {
  try {
    await keys.forget(platform);
  } catch {
    // Still stored: the next connect replaces it, and Sign out reports a failure to delete
  }
}

export interface ConnectDeps {
  keys: BrowserKeys;
  apiFetch: ApiFetch;
}

/** Import an App Store Connect key from its file and prove it by listing its apps */
export async function connectApple(
  deps: ConnectDeps,
  input: { file: Blob; keyId: string; issuerId: string }
): Promise<{ keyId: string; issuerId: string; apps: AppleAppSummary[] }> {
  try {
    await deps.keys.importApple({ privateKeyPem: await input.file.text(), keyId: input.keyId, issuerId: input.issuerId });
  } catch (error) {
    throw importError(error, 'Could not read that key file.');
  }

  let response: Response;
  try {
    response = await deps.apiFetch('/api/apple/auth', { method: 'POST', quietAuthFailure: true });
  } catch {
    await forgetQuietly(deps.keys, 'apple');
    throw new ConnectError('Could not reach PricingKit. Check your connection and try again.');
  }
  if (!response.ok) {
    await forgetQuietly(deps.keys, 'apple');
    throw await errorMessage(response, 'App Store Connect did not accept this key.');
  }
  const data = (await response.json()) as { keyId: string; issuerId: string; apps: AppleAppSummary[] };
  return { keyId: data.keyId, issuerId: data.issuerId, apps: data.apps ?? [] };
}

/** Import a Google service account key from its file and prove it can read the package */
export async function connectGoogle(
  deps: ConnectDeps,
  input: { file: Blob; packageName: string }
): Promise<{ clientEmail: string; projectId: string; packageName: string }> {
  let info: { clientEmail: string; projectId: string };
  try {
    info = await deps.keys.importGoogle(await input.file.text());
  } catch (error) {
    throw importError(error, 'Could not read that service account file.');
  }

  let response: Response;
  try {
    // The access token is minted here, in the browser, at Google's token endpoint
    response = await deps.apiFetch('/api/auth', { method: 'POST', app: input.packageName, quietAuthFailure: true });
  } catch {
    await forgetQuietly(deps.keys, 'google');
    throw new ConnectError('Could not reach PricingKit. Check your connection and try again.');
  }
  if (!response.ok) {
    await forgetQuietly(deps.keys, 'google');
    throw await errorMessage(response, 'Google Play did not accept this key.');
  }
  return { clientEmail: info.clientEmail, projectId: info.projectId, packageName: input.packageName };
}
