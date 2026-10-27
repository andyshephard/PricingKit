// Request headers as the browser sends them, for route handler tests.
//
// The Apple token is shaped like a real App Store Connect JWT but its
// signature is junk: the server only runs shape checks, and these tests never
// reach Apple.

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export const TEST_APPLE_KEY_ID = 'TESTKEY123';
export const TEST_APPLE_ISSUER_ID = '00000000-0000-4000-8000-000000000000';

export interface TestAppleTokenOptions {
  /** Issued at, seconds since the epoch (default: now) */
  iat?: number;
  /** Lifetime in seconds (default 20 minutes) */
  ttl?: number;
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
}

export function testAppleToken(options: TestAppleTokenOptions = {}): string {
  const iat = options.iat ?? Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: TEST_APPLE_KEY_ID, typ: 'JWT', ...options.header };
  const claims = { iss: TEST_APPLE_ISSUER_ID, iat, exp: iat + (options.ttl ?? 20 * 60), aud: 'appstoreconnect-v1', ...options.claims };
  return `${b64url(header)}.${b64url(claims)}.${Buffer.from('not-a-real-signature').toString('base64url')}`;
}

export const TEST_GOOGLE_TOKEN = 'ya29.test-access-token-0123456789';

/** X-PK-Apple-Token (and X-PK-App when an app is given) */
export function appleHeaders(bundleId: string | null = 'com.example.test', token: string = testAppleToken()): Record<string, string> {
  return { 'x-pk-apple-token': token, ...(bundleId ? { 'x-pk-app': bundleId } : {}) };
}

/** X-PK-Google-Token (and X-PK-App when a package is given) */
export function googleHeaders(packageName: string | null = 'com.example.app', token: string = TEST_GOOGLE_TOKEN): Record<string, string> {
  return { 'x-pk-google-token': token, ...(packageName ? { 'x-pk-app': packageName } : {}) };
}
