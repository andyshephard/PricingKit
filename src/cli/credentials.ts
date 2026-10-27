// Store credentials for the CLI. They come only from environment variables
// (a key file path counts: the variable names the file). They are held in
// memory, never written anywhere, and every value is registered with the
// Redactor so it can't reach the output.

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';
import type { Redactor } from './redact';
import { CliError } from './errors';

export const APPLE_ENV = {
  keyId: 'ASC_KEY_ID',
  issuerId: 'ASC_ISSUER_ID',
  privateKey: 'ASC_PRIVATE_KEY',
  privateKeyPath: 'ASC_PRIVATE_KEY_PATH',
} as const;

export const GOOGLE_ENV = {
  credentialsPath: 'GOOGLE_APPLICATION_CREDENTIALS',
  credentialsJson: 'GOOGLE_SERVICE_ACCOUNT_JSON',
} as const;

type Env = Record<string, string | undefined>;

function value(env: Env, name: string): string | undefined {
  const v = env[name];
  return v && v.trim() !== '' ? v : undefined;
}

/** Read a key file without ever putting its contents (or the fs error's view of them) in a message */
async function readSecretFile(path: string, variable: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new CliError(`Can't read the file named by ${variable}${code ? ` (${code})` : ''}`);
  }
}

export async function appleCredentialsFromEnv(env: Env, bundleId: string, redactor: Redactor): Promise<AppleConnectCredentials> {
  const keyId = value(env, APPLE_ENV.keyId);
  const issuerId = value(env, APPLE_ENV.issuerId);
  const inlineKey = value(env, APPLE_ENV.privateKey);
  const keyPath = value(env, APPLE_ENV.privateKeyPath);
  // Register before any check can fail, so nothing below can leak them
  redactor.add(keyId);
  redactor.add(issuerId);
  redactor.add(inlineKey);

  const missing = [
    ...(keyId ? [] : [APPLE_ENV.keyId]),
    ...(issuerId ? [] : [APPLE_ENV.issuerId]),
    ...(inlineKey || keyPath ? [] : [`${APPLE_ENV.privateKey} or ${APPLE_ENV.privateKeyPath}`]),
  ];
  if (missing.length > 0) throw new CliError(`Missing App Store Connect credentials: set ${missing.join(', ')}`);
  if (inlineKey && keyPath) throw new CliError(`Set only one of ${APPLE_ENV.privateKey} and ${APPLE_ENV.privateKeyPath}`);

  // CI secrets often hold the PEM with literal \n sequences
  const privateKey = inlineKey ? inlineKey.replace(/\\n/g, '\n') : await readSecretFile(keyPath!, APPLE_ENV.privateKeyPath);
  redactor.add(privateKey);
  if (!/PRIVATE KEY-----/.test(privateKey) && !/^[A-Za-z0-9+/=\s]+$/.test(privateKey)) {
    throw new CliError(`The App Store Connect private key is not a PEM (.p8) key`);
  }
  return { keyId: keyId!, issuerId: issuerId!, privateKey, bundleId };
}

const serviceAccountSchema = z
  .object({
    client_email: z.string().min(1),
    private_key: z.string().min(1),
    private_key_id: z.string().min(1),
  })
  .passthrough();

export async function googleCredentialsFromEnv(env: Env, redactor: Redactor): Promise<ServiceAccountCredentials> {
  const path = value(env, GOOGLE_ENV.credentialsPath);
  const inline = value(env, GOOGLE_ENV.credentialsJson);
  redactor.add(inline);
  if (!path && !inline) {
    throw new CliError(`Missing Google Play credentials: set ${GOOGLE_ENV.credentialsPath} (a service account key file) or ${GOOGLE_ENV.credentialsJson}`);
  }
  if (path && inline) throw new CliError(`Set only one of ${GOOGLE_ENV.credentialsPath} and ${GOOGLE_ENV.credentialsJson}`);

  const variable = path ? GOOGLE_ENV.credentialsPath : GOOGLE_ENV.credentialsJson;
  const text = path ? await readSecretFile(path, GOOGLE_ENV.credentialsPath) : inline!;
  redactor.add(text);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // JSON.parse messages quote the input; never pass them on
    throw new CliError(`The service account key in ${variable} is not valid JSON`);
  }
  const parsed = serviceAccountSchema.safeParse(raw);
  if (raw && typeof raw === 'object') {
    for (const field of ['private_key', 'private_key_id', 'client_email', 'client_id'] as const) {
      const v = (raw as Record<string, unknown>)[field];
      if (typeof v === 'string') redactor.add(v);
    }
  }
  if (!parsed.success) {
    // Name the fields only, never their values
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new CliError(`The service account key in ${variable} is missing or has invalid fields: ${fields}`);
  }
  return parsed.data as unknown as ServiceAccountCredentials;
}
