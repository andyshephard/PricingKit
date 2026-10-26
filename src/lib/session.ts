import { getSessionCredentials } from './google-play/client';
import { getAppleSessionCredentials } from './apple-connect/client';

// Cookie names shared with /api/auth and /api/apple/auth
export const GOOGLE_SESSION_COOKIE = 'gplay_session';
export const APPLE_SESSION_COOKIE = 'apple_session';

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
