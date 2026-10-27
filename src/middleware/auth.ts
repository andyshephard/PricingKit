/**
 * Authentication helpers for API routes.
 *
 * The single place that turns session cookies into store credentials. Route
 * files must import these instead of defining their own (or importing a
 * helper from another route file).
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSessionCredentials } from '@/lib/google-play/client';
import { getAppleSessionCredentials } from '@/lib/apple-connect/client';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';

import {
  APPLE_BUNDLE_ID_COOKIE,
  APPLE_SESSION_COOKIE,
  GOOGLE_PACKAGE_NAME_COOKIE,
  GOOGLE_SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE,
} from '@/lib/session';
import { isLegacyCiphertext, reencryptLegacyCiphertext } from '@/lib/encryption';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * Session cookies written before the v2 (HKDF) format are re-encrypted on
 * the request that reads them, so nobody is logged out by the upgrade. Same
 * attributes as the login routes set; the cookie gets a fresh lifetime once.
 * Best effort: where cookies can't be set (e.g. a Server Component render),
 * the old cookie keeps working and is migrated on a later API request.
 */
async function migrateLegacySessionCookie(cookieStore: CookieStore, name: string, value: string): Promise<void> {
  if (!isLegacyCiphertext(value)) return;
  const upgraded = await reencryptLegacyCiphertext(value);
  if (!upgraded) return;
  try {
    cookieStore.set(name, upgraded, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SESSION_COOKIE_MAX_AGE,
      path: '/',
    });
  } catch {
    // read-only cookie store here; try again on the next request
  }
}

/**
 * Google Play authentication result
 */
export interface GoogleAuthResult {
  credentials: ServiceAccountCredentials;
  packageName: string;
}

/**
 * Apple authentication result
 */
export interface AppleAuthResult {
  credentials: AppleConnectCredentials;
  bundleId: string;
}

/**
 * Standard 401 response for unauthenticated requests
 */
export function unauthorizedResponse(message: string = 'Not authenticated') {
  return NextResponse.json({ error: message }, { status: 401 });
}

/**
 * Standard 403 response for unauthorized requests
 */
export function forbiddenResponse(message: string = 'Access denied') {
  return NextResponse.json({ error: message }, { status: 403 });
}

/**
 * Get Google Play credentials from cookies.
 * Returns null if not authenticated.
 */
export async function getGoogleAuthFromCookies(): Promise<GoogleAuthResult | null> {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(GOOGLE_SESSION_COOKIE)?.value;
    const packageName = cookieStore.get(GOOGLE_PACKAGE_NAME_COOKIE)?.value;

    if (!sessionId || !packageName) {
      return null;
    }

    const credentials = await getSessionCredentials(sessionId);
    if (!credentials) {
      return null;
    }
    await migrateLegacySessionCookie(cookieStore, GOOGLE_SESSION_COOKIE, sessionId);

    return { credentials, packageName };
  } catch (error) {
    console.error('Error getting Google auth from cookies:', error);
    return null;
  }
}

/**
 * Apple credentials from the session cookie, without requiring an app to be
 * selected (bundleId is ''). Used before an app is chosen (app list, app switch).
 * Returns null if not authenticated.
 */
export async function getAppleSessionFromCookies(): Promise<AppleConnectCredentials | null> {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(APPLE_SESSION_COOKIE)?.value;
    if (!sessionId) return null;
    const sessionCredentials = await getAppleSessionCredentials(sessionId);
    if (!sessionCredentials) return null;
    await migrateLegacySessionCookie(cookieStore, APPLE_SESSION_COOKIE, sessionId);
    return { ...sessionCredentials, bundleId: sessionCredentials.bundleId ?? '' };
  } catch (error) {
    console.error('Error getting Apple session from cookies:', error);
    return null;
  }
}

/**
 * Get Apple credentials from cookies.
 * Returns null if not authenticated.
 */
export async function getAppleAuthFromCookies(): Promise<AppleAuthResult | null> {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(APPLE_SESSION_COOKIE)?.value;
    const bundleId = cookieStore.get(APPLE_BUNDLE_ID_COOKIE)?.value;

    if (!sessionId || !bundleId) {
      return null;
    }

    const sessionCredentials = await getAppleSessionCredentials(sessionId);
    if (!sessionCredentials) {
      return null;
    }
    await migrateLegacySessionCookie(cookieStore, APPLE_SESSION_COOKIE, sessionId);

    const credentials: AppleConnectCredentials = {
      ...sessionCredentials,
      bundleId,
    };

    return { credentials, bundleId };
  } catch (error) {
    console.error('Error getting Apple auth from cookies:', error);
    return null;
  }
}

/**
 * Require Google Play authentication.
 * Returns the auth result or a 401 response.
 */
export async function requireGoogleAuth(): Promise<
  | { success: true; auth: GoogleAuthResult }
  | { success: false; response: NextResponse }
> {
  const auth = await getGoogleAuthFromCookies();
  if (!auth) {
    return { success: false, response: unauthorizedResponse() };
  }
  return { success: true, auth };
}

/**
 * Require Apple authentication.
 * Returns the auth result or a 401 response.
 */
export async function requireAppleAuth(): Promise<
  | { success: true; auth: AppleAuthResult }
  | { success: false; response: NextResponse }
> {
  const auth = await getAppleAuthFromCookies();
  if (!auth) {
    return { success: false, response: unauthorizedResponse() };
  }
  return { success: true, auth };
}

/**
 * Higher-order function to wrap API route handlers with Google auth.
 * Automatically returns 401 if not authenticated.
 *
 * @example
 * ```ts
 * export const GET = withGoogleAuth(async (request, context, { credentials, packageName }) => {
 *   const products = await listInAppProducts(credentials, packageName);
 *   return NextResponse.json({ products });
 * });
 * ```
 */
export function withGoogleAuth<T extends { params?: Promise<unknown> }>(
  handler: (
    request: Request,
    context: T,
    auth: GoogleAuthResult
  ) => Promise<NextResponse>
) {
  return async (request: Request, context: T): Promise<NextResponse> => {
    const result = await requireGoogleAuth();
    if (!result.success) {
      return result.response;
    }
    return handler(request, context, result.auth);
  };
}

/**
 * Higher-order function to wrap API route handlers with Apple auth.
 * Automatically returns 401 if not authenticated.
 *
 * @example
 * ```ts
 * export const GET = withAppleAuth(async (request, context, { credentials, bundleId }) => {
 *   const products = await listInAppPurchases(credentials);
 *   return NextResponse.json({ products });
 * });
 * ```
 */
export function withAppleAuth<T extends { params?: Promise<unknown> }>(
  handler: (
    request: Request,
    context: T,
    auth: AppleAuthResult
  ) => Promise<NextResponse>
) {
  return async (request: Request, context: T): Promise<NextResponse> => {
    const result = await requireAppleAuth();
    if (!result.success) {
      return result.response;
    }
    return handler(request, context, result.auth);
  };
}
