/**
 * Authentication helpers for API routes.
 *
 * The single place that turns session cookies into store credentials. Route
 * files must import these instead of defining their own (or importing a
 * helper from another route file).
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';
import { COOKIE_NAMES, readAppCookie, readSessionCookie } from '@/lib/session';

// Sessions are sealed envelopes with an absolute expiry (src/lib/session-envelope.ts).
// readSessionCookie re-writes a legacy cookie (old format or old name) as v3
// under the current name, keeping its expiry; where the cookie store is
// read-only the old cookie keeps working until the legacy cutoff.

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
    const packageName = readAppCookie(cookieStore, COOKIE_NAMES.googlePackage);
    if (!packageName) return null;
    const credentials: ServiceAccountCredentials | null = await readSessionCookie(cookieStore, 'google');
    if (!credentials) return null;
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
    const sessionCredentials = await readSessionCookie(await cookies(), 'apple');
    if (!sessionCredentials) return null;
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
    const bundleId = readAppCookie(cookieStore, COOKIE_NAMES.appleBundle);
    if (!bundleId) return null;
    const sessionCredentials = await readSessionCookie(cookieStore, 'apple');
    if (!sessionCredentials) return null;

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
