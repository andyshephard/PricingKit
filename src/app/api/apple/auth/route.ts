import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  validateAppleCredentials,
  createAppleSession,
  getAppleSessionCredentials,
  deleteAppleSession,
  testAppleConnection,
  resolveAppleCredentials,
} from '@/lib/apple-connect/client';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';
import { getAppleAuthFromCookies as getAppleAuthFromMiddleware } from '@/middleware/auth';

const SESSION_COOKIE = 'apple_session';
const BUNDLE_ID_COOKIE = 'apple_bundle_id';
const COOKIE_MAX_AGE = 24 * 60 * 60; // 24 hours

export async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }
    const { privateKey, keyId, issuerId, bundleId } = body;

    if (!privateKey || !keyId || !issuerId || !bundleId) {
      return NextResponse.json(
        { error: 'Missing required credentials' },
        { status: 400 }
      );
    }

    const credentials: AppleConnectCredentials = {
      privateKey,
      keyId,
      issuerId,
      bundleId,
    };

    if (!validateAppleCredentials(credentials)) {
      return NextResponse.json(
        { error: 'Invalid credentials format. Please check your .p8 key file.' },
        { status: 400 }
      );
    }

    // Test the connection
    const testResult = await testAppleConnection(credentials);
    if (!testResult.success) {
      return NextResponse.json(
        { error: testResult.error },
        { status: 401 }
      );
    }

    // Create session and store session ID in cookie
    const sessionId = await createAppleSession(credentials);

    const cookieStore = await cookies();

    cookieStore.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });

    cookieStore.set(BUNDLE_ID_COOKIE, bundleId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });

    return NextResponse.json({
      success: true,
      bundleId,
      keyId,
      issuerId,
    });
  } catch (error) {
    console.error('Apple auth error:', error);
    return NextResponse.json(
      { error: 'Failed to authenticate. Please try again.' },
      { status: 500 }
    );
  }
}

export async function GET() {
  console.log('[Auth API] GET request received');
  try {
    // 1. Check for environment variables via the middleware helper
    const envAuth = await getAppleAuthFromMiddleware();
    console.log(`[Auth API] envAuth result: ${envAuth ? 'Found' : 'Not found'}`);
    
    if (envAuth) {
      console.log(`[Auth API] Testing environment credentials for bundleId: ${envAuth.bundleId}`);
      // Test the environment credentials to ensure they are valid
      const testResult = await testAppleConnection(envAuth.credentials);
      if (!testResult.success) {
        console.log(`[Auth API] Environment credentials failed connection test: ${testResult.error}`);
        return NextResponse.json({ 
          authenticated: false, 
          error: `Environment credentials invalid: ${testResult.error}` 
        });
      }
      console.log(`[Auth API] Connection test successful for: ${envAuth.bundleId}`);

      return NextResponse.json({
        authenticated: true,
        bundleId: envAuth.bundleId,
        keyId: envAuth.credentials.keyId,
        issuerId: envAuth.credentials.issuerId,
      });
    }

    // 2. Fallback to cookie-based session
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

    if (!sessionId) {
      return NextResponse.json({ authenticated: false });
    }

    const credentials = await getAppleSessionCredentials(sessionId);
    if (!credentials) {
      return NextResponse.json({ authenticated: false });
    }

    // Use bundleId from credentials as single source of truth
    return NextResponse.json({
      authenticated: true,
      bundleId: credentials.bundleId,
      keyId: credentials.keyId,
      issuerId: credentials.issuerId,
    });
  } catch (error) {
    console.error('Apple auth check error:', error);
    return NextResponse.json({ authenticated: false });
  }
}

export async function DELETE() {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

    if (sessionId) {
      await deleteAppleSession();
    }

    cookieStore.delete(SESSION_COOKIE);
    cookieStore.delete(BUNDLE_ID_COOKIE);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Apple logout error:', error);
    return NextResponse.json(
      { error: 'Failed to logout' },
      { status: 500 }
    );
  }
}

// Helper to get Apple credentials from cookies (for use in other API routes)
export async function getAppleAuthFromCookies(): Promise<{
  credentials: AppleConnectCredentials;
  bundleId: string;
} | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

  // Use the robust resolver which checks env vars first
  const credentials = await resolveAppleCredentials(sessionId);
  if (!credentials) {
    return null;
  }

  // Use bundleId from credentials as single source of truth
  return { credentials, bundleId: credentials.bundleId };
}
