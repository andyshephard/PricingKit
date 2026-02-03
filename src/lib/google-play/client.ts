import { google, androidpublisher_v3 } from 'googleapis';
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

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  cachedClient = google.androidpublisher({
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

// File-based session store for credentials
// Persists across server restarts in development
import fs from 'fs';
import path from 'path';
import { encrypt, decrypt, isEncryptionAvailable } from '../encryption';

interface Session {
  credentials: ServiceAccountCredentials;
  createdAt: number;
}

interface EncryptedSession {
  encryptedCredentials: string;
  createdAt: number;
}

interface SessionStore {
  [sessionId: string]: Session | EncryptedSession;
}

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const SESSION_FILE = path.join(process.cwd(), '.sessions.json');

// In-memory cache to avoid file I/O on every request
let sessionCache: SessionStore | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL = 60 * 1000; // 1 minute cache

// Check if a session entry is encrypted
function isEncryptedSession(session: Session | EncryptedSession): session is EncryptedSession {
  return 'encryptedCredentials' in session;
}

// Load sessions from file with caching
function loadSessions(): SessionStore {
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
function saveSessions(sessions: SessionStore): void {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
    sessionCache = sessions;
    cacheLoadedAt = Date.now();
  } catch (error) {
    console.error('Error saving sessions:', error);
  }
}

// Invalidate cache (useful when sessions are modified externally)
export function invalidateSessionCache(): void {
  sessionCache = null;
  cacheLoadedAt = 0;
}

// Clean up expired sessions
function cleanupExpiredSessions(sessions: SessionStore): SessionStore {
  const now = Date.now();
  const cleaned: SessionStore = {};
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (now - session.createdAt <= SESSION_TTL) {
      cleaned[sessionId] = session;
    }
  }
  return cleaned;
}

// Generate a random session ID
function generateSessionId(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createSession(credentials: ServiceAccountCredentials): string {
  let sessions = loadSessions();
  sessions = cleanupExpiredSessions(sessions);

  const sessionId = generateSessionId();

  // Encrypt credentials if ENCRYPTION_KEY is available
  if (isEncryptionAvailable()) {
    sessions[sessionId] = {
      encryptedCredentials: encrypt(JSON.stringify(credentials)),
      createdAt: Date.now(),
    };
  } else {
    console.warn('Warning: ENCRYPTION_KEY not set. Credentials will be stored in plaintext.');
    sessions[sessionId] = {
      credentials,
      createdAt: Date.now(),
    };
  }

  saveSessions(sessions);
  return sessionId;
}

export function getSessionCredentials(sessionId: string): ServiceAccountCredentials | null {
  const sessions = loadSessions();
  const session = sessions[sessionId];

  if (!session) {
    return null;
  }

  // Check if session has expired
  if (Date.now() - session.createdAt > SESSION_TTL) {
    deleteSession(sessionId);
    return null;
  }

  // Decrypt credentials if encrypted
  if (isEncryptedSession(session)) {
    try {
      const decrypted = decrypt(session.encryptedCredentials);
      return JSON.parse(decrypted) as ServiceAccountCredentials;
    } catch (error) {
      console.error('Error decrypting session credentials:', error);
      return null;
    }
  }

  return session.credentials;
}

export function deleteSession(sessionId: string): void {
  const sessions = loadSessions();
  delete sessions[sessionId];
  saveSessions(sessions);
}
