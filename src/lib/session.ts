import { getSessionCredentials } from './google-play/client';
import { getAppleSessionCredentials } from './apple-connect/client';

// Session cookie names, shared by the auth routes and src/middleware/auth.ts
export const GOOGLE_SESSION_COOKIE = 'gplay_session';
export const GOOGLE_PACKAGE_NAME_COOKIE = 'gplay_package_name';
export const APPLE_SESSION_COOKIE = 'apple_session';
export const APPLE_BUNDLE_ID_COOKIE = 'apple_bundle_id';
/** Session cookie lifetime in seconds (24 hours) */
export const SESSION_COOKIE_MAX_AGE = 24 * 60 * 60;

interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/**
 * True when the request carries a Google Play or Apple session cookie that
 * decrypts to valid credentials. Used to gate operations that cost operator
 * resources (e.g. forcing an upstream refresh on otherwise public endpoints).
 */
export async function hasAuthenticatedSession(cookieStore: CookieReader): Promise<boolean> {
  const googleSession = cookieStore.get(GOOGLE_SESSION_COOKIE)?.value;
  if (googleSession && (await getSessionCredentials(googleSession))) {
    return true;
  }

  const appleSession = cookieStore.get(APPLE_SESSION_COOKIE)?.value;
  if (appleSession && (await getAppleSessionCredentials(appleSession))) {
    return true;
  }

  return false;
}
