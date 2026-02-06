import { androidpublisher, type androidpublisher_v3 } from '@googleapis/androidpublisher';
import { GoogleAuth } from 'google-auth-library';
import type { ServiceAccountCredentials } from './types';

export type AndroidPublisher = androidpublisher_v3.Androidpublisher;

let cachedClient: AndroidPublisher | null = null;
let cachedCredentialsHash: string | null = null;

function hashCredentials(credentials: ServiceAccountCredentials): string {
  return `${credentials.client_email}-${credentials.private_key_id}`;
}

export function createGooglePlayClient(credentials: ServiceAccountCredentials): AndroidPublisher {
  const credHash = hashCredentials(credentials);

  if (cachedClient && cachedCredentialsHash === credHash) {
    return cachedClient;
  }

  const auth = new GoogleAuth({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  cachedClient = androidpublisher({
    version: 'v3',
    auth,
  });
  cachedCredentialsHash = credHash;

  return cachedClient;
}

export function clearClientCache(): void {
  cachedClient = null;
  cachedCredentialsHash = null;
}

export function validateServiceAccountJson(json: unknown): json is ServiceAccountCredentials {
  if (typeof json !== 'object' || json === null) {
    return false;
  }

  const obj = json as Record<string, unknown>;

  const requiredFields = [
    'type',
    'project_id',
    'private_key_id',
    'private_key',
    'client_email',
    'client_id',
    'auth_uri',
    'token_uri',
    'auth_provider_x509_cert_url',
    'client_x509_cert_url',
  ];

  for (const field of requiredFields) {
    if (typeof obj[field] !== 'string') {
      return false;
    }
  }

  if (obj.type !== 'service_account') {
    return false;
  }

  return true;
}

// Cookie-based encrypted session management
// Credentials are encrypted and stored directly in the cookie (no server-side state)
import { encrypt, decrypt, isEncryptionAvailable } from '../encryption';

export async function createSession(credentials: ServiceAccountCredentials): Promise<string> {
  if (isEncryptionAvailable()) {
    return await encrypt(JSON.stringify(credentials));
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY environment variable is required in production. Set it to a 32+ character random string.');
  } else {
    console.warn('Warning: ENCRYPTION_KEY not set. Credentials stored in plaintext cookie (development only).');
    return Buffer.from(JSON.stringify(credentials)).toString('base64');
  }
}

export async function getSessionCredentials(cookieValue: string): Promise<ServiceAccountCredentials | null> {
  try {
    if (isEncryptionAvailable()) {
      const decrypted = await decrypt(cookieValue);
      return JSON.parse(decrypted) as ServiceAccountCredentials;
    } else {
      const decoded = Buffer.from(cookieValue, 'base64').toString('utf-8');
      return JSON.parse(decoded) as ServiceAccountCredentials;
    }
  } catch (error) {
    console.error('Error decrypting session credentials:', error);
    return null;
  }
}

export async function deleteSession(): Promise<void> {
  // No-op: cookie deletion is handled by the auth route
}
