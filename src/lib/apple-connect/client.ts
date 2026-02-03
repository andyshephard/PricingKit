import * as crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  AppleConnectCredentials,
  AppleApiResponse,
  AppleApiListResponse,
  AppleApiErrorResponse,
} from './types';

const APPLE_API_BASE = 'https://api.appstoreconnect.apple.com/v1';
const JWT_EXPIRY_SECONDS = 20 * 60; // 20 minutes (max allowed)
const TOKEN_REFRESH_MARGIN = 60; // Refresh 1 minute before expiry

// Cached JWT token
interface CachedToken {
  token: string;
  expiresAt: number; // Unix timestamp
  credentialsHash: string;
}

let cachedToken: CachedToken | null = null;

// Hash credentials for cache validation
function hashCredentials(credentials: AppleConnectCredentials): string {
  return `${credentials.keyId}-${credentials.issuerId}-${credentials.bundleId}`;
}

// Generate JWT for App Store Connect API
export function generateJWT(credentials: AppleConnectCredentials): string {
  const credHash = hashCredentials(credentials);

  // Check if we have a valid cached token
  if (cachedToken && cachedToken.credentialsHash === credHash) {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken.expiresAt - now > TOKEN_REFRESH_MARGIN) {
      return cachedToken.token;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + JWT_EXPIRY_SECONDS;

  // JWT Header
  const header = {
    alg: 'ES256',
    kid: credentials.keyId,
    typ: 'JWT',
  };

  // JWT Payload
  const payload = {
    iss: credentials.issuerId,
    iat: now,
    exp: expiresAt,
    aud: 'appstoreconnect-v1',
  };

  // Encode header and payload
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  // Create signature
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const sign = crypto.createSign('SHA256');
  sign.update(signatureInput);
  sign.end();

  // Sign with the private key
  const signature = sign.sign(
    {
      key: credentials.privateKey,
      dsaEncoding: 'ieee-p1363', // Required for ES256
    },
    'base64'
  );

  // Convert base64 to base64url
  const encodedSignature = base64ToBase64Url(signature);

  const token = `${encodedHeader}.${encodedPayload}.${encodedSignature}`;

  // Cache the token
  cachedToken = {
    token,
    expiresAt,
    credentialsHash: credHash,
  };

  return token;
}

// Base64 URL encoding helpers
function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Clear token cache
export function clearTokenCache(): void {
  cachedToken = null;
}

// Validate Apple Connect credentials structure
export function validateAppleCredentials(
  data: unknown
): data is AppleConnectCredentials {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;

  // Check required fields
  if (typeof obj.privateKey !== 'string' || !obj.privateKey) {
    return false;
  }
  if (typeof obj.keyId !== 'string' || !obj.keyId) {
    return false;
  }
  if (typeof obj.issuerId !== 'string' || !obj.issuerId) {
    return false;
  }
  if (typeof obj.bundleId !== 'string' || !obj.bundleId) {
    return false;
  }

  // Validate private key format (should be a PEM-formatted key)
  const privateKey = obj.privateKey;
  if (
    !privateKey.includes('-----BEGIN PRIVATE KEY-----') &&
    !privateKey.includes('-----BEGIN EC PRIVATE KEY-----')
  ) {
    return false;
  }

  return true;
}

// API request helper
export async function appleApiRequest<T>(
  credentials: AppleConnectCredentials,
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    queryParams?: Record<string, string>;
    apiVersion?: 'v1' | 'v2';
  } = {}
): Promise<T> {
  const { method = 'GET', body, queryParams, apiVersion = 'v1' } = options;

  const token = generateJWT(credentials);

  const baseUrl = `https://api.appstoreconnect.apple.com/${apiVersion}`;
  let url = `${baseUrl}${endpoint}`;

  if (queryParams && Object.keys(queryParams).length > 0) {
    const params = new URLSearchParams(queryParams);
    url += `?${params.toString()}`;
  }

  console.log('[Apple API Request]', method, url);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (body) {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);

  console.log('[Apple API Response] Status:', response.status);

  if (!response.ok) {
    const errorData = (await response.json()) as AppleApiErrorResponse;
    console.error('[Apple API Error] Response:', JSON.stringify(errorData, null, 2));
    const error = errorData.errors?.[0];
    throw new AppleApiError(
      response.status,
      error?.code || 'UNKNOWN_ERROR',
      error?.title || 'Unknown error',
      error?.detail || `Request failed with status ${response.status}`
    );
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

// Custom error class for Apple API errors
export class AppleApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    public title: string,
    public detail: string
  ) {
    super(`${title}: ${detail}`);
    this.name = 'AppleApiError';
  }
}

// Session management (similar to Google Play)
import { encrypt, decrypt, isEncryptionAvailable } from '../encryption';

interface AppleSession {
  credentials: AppleConnectCredentials;
  createdAt: number;
}

interface EncryptedAppleSession {
  encryptedCredentials: string;
  createdAt: number;
}

interface AppleSessionStore {
  [sessionId: string]: AppleSession | EncryptedAppleSession;
}

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const SESSION_FILE = path.join(process.cwd(), '.sessions.json');

// In-memory cache to avoid file I/O on every request
let sessionCache: CombinedSessionStore | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL = 60 * 1000; // 1 minute cache

// Session store includes both Google and Apple sessions
interface CombinedSessionStore {
  [sessionId: string]: {
    type: 'google' | 'apple';
    credentials?: unknown;
    encryptedCredentials?: string;
    createdAt: number;
  };
}

// Check if a session entry is encrypted
function isEncryptedSession(session: CombinedSessionStore[string]): boolean {
  return 'encryptedCredentials' in session && typeof session.encryptedCredentials === 'string';
}

// Load sessions from file with caching
function loadSessions(): CombinedSessionStore {
  const now = Date.now();
  if (sessionCache && now - cacheLoadedAt < CACHE_TTL) {
    return sessionCache;
  }

  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = fs.readFileSync(SESSION_FILE, 'utf-8');
      sessionCache = JSON.parse(data);
      cacheLoadedAt = now;
      return sessionCache!;
    }
  } catch (error) {
    console.error('Error loading sessions:', error);
  }
  sessionCache = {};
  cacheLoadedAt = now;
  return {};
}

// Save sessions to file and update cache
function saveSessions(sessions: CombinedSessionStore): void {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
    sessionCache = sessions;
    cacheLoadedAt = Date.now();
  } catch (error) {
    console.error('Error saving sessions:', error);
  }
}

// Invalidate cache (useful when sessions are modified externally)
export function invalidateAppleSessionCache(): void {
  sessionCache = null;
  cacheLoadedAt = 0;
}

// Clean up expired sessions
function cleanupExpiredSessions(
  sessions: CombinedSessionStore
): CombinedSessionStore {
  const now = Date.now();
  const cleaned: CombinedSessionStore = {};
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (now - session.createdAt <= SESSION_TTL) {
      cleaned[sessionId] = session;
    }
  }
  return cleaned;
}

// Generate a random session ID with apple_ prefix
function generateAppleSessionId(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return (
    'apple_' + Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('')
  );
}

export function createAppleSession(
  credentials: AppleConnectCredentials
): string {
  let sessions = loadSessions();
  sessions = cleanupExpiredSessions(sessions);

  const sessionId = generateAppleSessionId();

  // Encrypt credentials if ENCRYPTION_KEY is available
  if (isEncryptionAvailable()) {
    sessions[sessionId] = {
      type: 'apple',
      encryptedCredentials: encrypt(JSON.stringify(credentials)),
      createdAt: Date.now(),
    };
  } else {
    console.warn('Warning: ENCRYPTION_KEY not set. Apple credentials will be stored in plaintext.');
    sessions[sessionId] = {
      type: 'apple',
      credentials,
      createdAt: Date.now(),
    };
  }

  saveSessions(sessions);
  return sessionId;
}

export function getAppleSessionCredentials(
  sessionId: string
): AppleConnectCredentials | null {
  const sessions = loadSessions();
  const session = sessions[sessionId];

  if (!session || session.type !== 'apple') {
    return null;
  }

  // Check if session has expired
  if (Date.now() - session.createdAt > SESSION_TTL) {
    deleteAppleSession(sessionId);
    return null;
  }

  // Decrypt credentials if encrypted
  if (isEncryptedSession(session)) {
    try {
      const decrypted = decrypt(session.encryptedCredentials!);
      return JSON.parse(decrypted) as AppleConnectCredentials;
    } catch (error) {
      console.error('Error decrypting Apple session credentials:', error);
      return null;
    }
  }

  return session.credentials as AppleConnectCredentials;
}

export function deleteAppleSession(sessionId: string): void {
  const sessions = loadSessions();
  delete sessions[sessionId];
  saveSessions(sessions);
}

// Test connection to App Store Connect
export async function testAppleConnection(
  credentials: AppleConnectCredentials
): Promise<{ success: boolean; error?: string }> {
  try {
    // Try to list apps to verify credentials
    await appleApiRequest<AppleApiListResponse<unknown>>(credentials, '/apps', {
      queryParams: {
        'filter[bundleId]': credentials.bundleId,
        limit: '1',
      },
    });
    return { success: true };
  } catch (error) {
    if (error instanceof AppleApiError) {
      if (error.statusCode === 401) {
        return {
          success: false,
          error: 'Invalid credentials. Please check your API key, Key ID, and Issuer ID.',
        };
      }
      if (error.statusCode === 403) {
        return {
          success: false,
          error: 'Access denied. The API key may not have sufficient permissions.',
        };
      }
      if (error.statusCode === 404) {
        return {
          success: false,
          error: `App with Bundle ID "${credentials.bundleId}" not found in App Store Connect.`,
        };
      }
      return { success: false, error: error.detail };
    }
    return {
      success: false,
      error: 'Failed to connect to App Store Connect. Please check your credentials.',
    };
  }
}

// Get app ID for a bundle ID
export async function getAppIdForBundleId(
  credentials: AppleConnectCredentials
): Promise<string | null> {
  try {
    console.log('[Apple] getAppIdForBundleId - Looking up bundleId:', credentials.bundleId);

    // Fetch apps matching the bundle ID filter (may return partial matches)
    // We need to find the exact match
    const response = await appleApiRequest<AppleApiListResponse<{
      id: string;
      attributes: { bundleId: string; name: string }
    }>>(
      credentials,
      '/apps',
      {
        queryParams: {
          'filter[bundleId]': credentials.bundleId,
          'fields[apps]': 'bundleId,name',
          limit: '200',
        },
      }
    );

    console.log('[Apple] getAppIdForBundleId - Found', response.data?.length ?? 0, 'apps matching filter');

    if (response.data && response.data.length > 0) {
      // Find the app with the EXACT bundle ID match
      const exactMatch = response.data.find(
        app => app.attributes.bundleId === credentials.bundleId
      );

      if (exactMatch) {
        console.log('[Apple] getAppIdForBundleId - Found exact match:', exactMatch.id, exactMatch.attributes.name);
        return exactMatch.id;
      }

      // Log available apps for debugging
      console.log('[Apple] getAppIdForBundleId - Available apps:', response.data.map(app => ({
        id: app.id,
        bundleId: app.attributes.bundleId,
        name: app.attributes.name,
      })));

      console.log('[Apple] getAppIdForBundleId - No exact match found for bundleId:', credentials.bundleId);
      return null;
    }
    console.log('[Apple] getAppIdForBundleId - No apps found for bundleId:', credentials.bundleId);
    return null;
  } catch (error) {
    console.error('[Apple] getAppIdForBundleId - Error:', error);
    return null;
  }
}
