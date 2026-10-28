// Connecting a store: stage, prove, commit.
//
// The key file is read and imported in this browser into memory only (a
// staged key), then proved with one read-only call signed by that staged
// key. Only if the store accepts it is the key committed into the real
// store, replacing any earlier one; otherwise it is dropped and the earlier
// key, if any, stays as it was. The file's text lives only in a local
// variable here; the imported key can't be read back out (non-extractable).

import { BrowserKeyError, type BrowserKeys, type KeyInfo, type KeyPlatform, type StagedKey } from '@/lib/browser-keys';
import type { ApiFetch, TokenProvider } from './api-fetch';

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

export const STORAGE_MESSAGE =
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

export interface ConnectDeps {
  /** The real key store */
  keys: BrowserKeys;
  /** An apiFetch that signs with the given (staged) keys and never opens the Connect prompt */
  apiFetchWith: (keys: TokenProvider) => ApiFetch;
}

/** Fails early, before any work, when the browser can't store keys at all */
async function requireStorage(keys: BrowserKeys, platform: KeyPlatform): Promise<void> {
  try {
    await keys.info(platform);
  } catch (error) {
    throw importError(error, STORAGE_MESSAGE);
  }
}

/** Prove a staged key with one call; commit it only if the store accepted it */
async function proveAndCommit<I extends KeyInfo>(
  deps: ConnectDeps,
  staged: StagedKey<I>,
  request: (apiFetch: ApiFetch) => Promise<Response>,
  refused: string
): Promise<{ info: I; response: Response }> {
  let response: Response;
  try {
    response = await request(deps.apiFetchWith(staged.keys));
  } catch {
    throw new ConnectError('Could not reach PricingKit. Check your connection and try again.');
  }
  if (!response.ok) throw await errorMessage(response, refused);
  try {
    return { info: await staged.commit(), response };
  } catch (error) {
    throw importError(error, STORAGE_MESSAGE);
  }
}

/** Import an App Store Connect key from its file, prove it by listing its apps, then store it */
export async function connectApple(
  deps: ConnectDeps,
  input: { file: Blob; keyId: string; issuerId: string }
): Promise<{ keyId: string; issuerId: string; apps: AppleAppSummary[] }> {
  await requireStorage(deps.keys, 'apple');
  let staged: StagedKey;
  try {
    staged = await deps.keys.stageApple({ privateKeyPem: await input.file.text(), keyId: input.keyId, issuerId: input.issuerId });
  } catch (error) {
    throw importError(error, 'Could not read that key file.');
  }
  const { response } = await proveAndCommit(
    deps,
    staged,
    (apiFetch) => apiFetch('/api/apple/auth', { method: 'POST', long: false, quietAuthFailure: true }),
    'App Store Connect did not accept this key.'
  );
  const data = (await response.json()) as { keyId: string; issuerId: string; apps: AppleAppSummary[] };
  return { keyId: data.keyId, issuerId: data.issuerId, apps: data.apps ?? [] };
}

/** Import a Google service account key from its file, prove it can read the package, then store it */
export async function connectGoogle(
  deps: ConnectDeps,
  input: { file: Blob; packageName: string }
): Promise<{ clientEmail: string; projectId: string; packageName: string }> {
  await requireStorage(deps.keys, 'google');
  let staged: StagedKey;
  try {
    staged = await deps.keys.stageGoogle(await input.file.text());
  } catch (error) {
    throw importError(error, 'Could not read that service account file.');
  }
  // The access token is minted by the staged key, in this browser, at Google's token endpoint
  const { info } = await proveAndCommit(
    deps,
    staged,
    (apiFetch) => apiFetch('/api/auth', { method: 'POST', app: input.packageName, long: false, quietAuthFailure: true }),
    'Google Play did not accept this key.'
  );
  if (info.platform !== 'google') throw new ConnectError('Could not store the key.');
  return { clientEmail: info.clientEmail, projectId: info.projectId, packageName: input.packageName };
}
