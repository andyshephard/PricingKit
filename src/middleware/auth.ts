/**
 * Authentication Middleware Utilities
 *
 * Provides reusable authentication helpers for API routes.
 * Reduces code duplication and ensures consistent auth handling.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSessionCredentials } from '@/lib/google-play/client';
import { getAppleSessionCredentials } from '@/lib/apple-connect/client';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';

const GOOGLE_SESSION_COOKIE = 'gplay_session';
const GOOGLE_PACKAGE_NAME_COOKIE = 'gplay_package_name';
const APPLE_SESSION_COOKIE = 'apple_session';
const APPLE_BUNDLE_ID_COOKIE = 'apple_bundle_id';

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

    const credentials = getSessionCredentials(sessionId);
    if (!credentials) {
      return null;
    }

    return { credentials, packageName };
  } catch (error) {
    console.error('Error getting Google auth from cookies:', error);
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

    const credentials = getAppleSessionCredentials(sessionId);
    if (!credentials) {
      return null;
    }

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
 *   const client = createGooglePlayClient(credentials);
 *   // ... use client
 *   return NextResponse.json({ data });
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
