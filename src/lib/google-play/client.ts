import type { ServiceAccountCredentials } from './types';
import { encrypt, decrypt, isEncryptionAvailable } from '../encryption';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ANDROID_PUBLISHER_BASE = 'https://androidpublisher.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_TTL_SECONDS = 3600; // 1 hour
const TOKEN_REFRESH_MARGIN = 60; // refresh 60s before expiry

interface CachedAccessToken {
  token: string;
  expiresAt: number; // unix seconds
  credentialsHash: string;
}

let cachedAccessToken: CachedAccessToken | null = null;

function hashCredentials(credentials: ServiceAccountCredentials): string {
  return `${credentials.client_email}-${credentials.private_key_id}`;
}

function base64UrlEncodeString(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64UrlEncodeBytes(bytes: ArrayBuffer): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function importPrivateKey(pemKey: string): Promise<CryptoKey> {
  const pemBody = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyBuffer = Buffer.from(pemBody, 'base64');
  return crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function mintAccessToken(credentials: ServiceAccountCredentials): Promise<{
  token: string;
  expiresAt: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + TOKEN_TTL_SECONDS;

  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: credentials.private_key_id,
  };
  const payload = {
    iss: credentials.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: expiresAt,
  };

  const encodedHeader = base64UrlEncodeString(JSON.stringify(header));
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await importPrivateKey(credentials.private_key);
  const signatureBytes = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const encodedSignature = base64UrlEncodeBytes(signatureBytes);
  const assertion = `${signingInput}.${encodedSignature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw {
      code: 401,
      message: `Failed to obtain Google access token (${response.status}): ${text}`,
      errors: [{ reason: 'invalidCredentials', message: text }],
    };
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw {
      code: 401,
      message: 'Google token endpoint returned no access_token',
      errors: [{ reason: 'invalidCredentials', message: 'No access_token in response' }],
    };
  }

  const ttl = typeof data.expires_in === 'number' ? data.expires_in : TOKEN_TTL_SECONDS;
  return { token: data.access_token, expiresAt: now + ttl };
}

export async function getGoogleAccessToken(
  credentials: ServiceAccountCredentials
): Promise<string> {
  const credHash = hashCredentials(credentials);
  const now = Math.floor(Date.now() / 1000);

  if (
    cachedAccessToken &&
    cachedAccessToken.credentialsHash === credHash &&
    cachedAccessToken.expiresAt - now > TOKEN_REFRESH_MARGIN
  ) {
    return cachedAccessToken.token;
  }

  const { token, expiresAt } = await mintAccessToken(credentials);
  cachedAccessToken = { token, expiresAt, credentialsHash: credHash };
  return token;
}

export function clearGoogleAccessTokenCache(): void {
  cachedAccessToken = null;
}

interface GoogleErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

export interface GooglePlayApiError {
  code: number;
  message: string;
  status?: string;
  errors: Array<{ reason?: string; message?: string }>;
}

export interface GooglePlayFetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

function buildUrl(path: string, query?: GooglePlayFetchOptions['query']): string {
  let url = `${ANDROID_PUBLISHER_BASE}${path}`;
  if (!query) return url;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (parts.length > 0) {
    url += `?${parts.join('&')}`;
  }
  return url;
}

export async function googlePlayFetch<T>(
  credentials: ServiceAccountCredentials,
  path: string,
  options: GooglePlayFetchOptions = {}
): Promise<T> {
  const { method = 'GET', body, query } = options;
  const token = await getGoogleAccessToken(credentials);
  const url = buildUrl(path, query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body — leave parsed undefined.
    }
  }

  if (!response.ok) {
    const envelope = (parsed as GoogleErrorEnvelope) ?? {};
    const errInfo = envelope.error ?? {};
    const apiError: GooglePlayApiError = {
      code: errInfo.code ?? response.status,
      message: errInfo.message ?? response.statusText ?? `HTTP ${response.status}`,
      status: errInfo.status,
      errors: Array.isArray(errInfo.errors) ? errInfo.errors : [],
    };
    console.error(
      `[googlePlayFetch] ${method} ${url} → ${response.status}`,
      JSON.stringify({ code: apiError.code, status: apiError.status, message: apiError.message, errors: apiError.errors })
    );
    throw apiError;
  }

  return parsed as T;
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
