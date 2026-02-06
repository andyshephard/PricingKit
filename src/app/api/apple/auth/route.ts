import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  validateAppleCredentials,
  createAppleSession,
  getAppleSessionCredentials,
  deleteAppleSession,
  testAppleConnection,
} from '@/lib/apple-connect/client';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';

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
  try {
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

  if (!sessionId) {
    return null;
  }

  const credentials = await getAppleSessionCredentials(sessionId);
  if (!credentials) {
    return null;
  }

  // Use bundleId from credentials as single source of truth
  // This prevents mismatch between cookie and session data
  return { credentials, bundleId: credentials.bundleId };
}
