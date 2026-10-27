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
import {
  MissingEncryptionKeyError,
  MISSING_ENCRYPTION_KEY_MESSAGE,
  canStoreSessions,
} from '@/lib/encryption';
import {
  APPLE_BUNDLE_ID_COOKIE,
  APPLE_SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE,
} from '@/lib/session';

const SESSION_COOKIE = APPLE_SESSION_COOKIE;
const BUNDLE_ID_COOKIE = APPLE_BUNDLE_ID_COOKIE;
const COOKIE_MAX_AGE = SESSION_COOKIE_MAX_AGE;

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
    const { privateKey, keyId, issuerId } = body;

    if (!privateKey || !keyId || !issuerId) {
      return NextResponse.json(
        { error: 'Missing required credentials' },
        { status: 400 }
      );
    }

    const credentials: AppleConnectCredentials = {
      privateKey,
      keyId,
      issuerId,
      bundleId: '',
    };

    if (!validateAppleCredentials(credentials)) {
      return NextResponse.json(
        { error: 'Invalid credentials format. Please check your .p8 key file.' },
        { status: 400 }
      );
    }

    // Fail closed before contacting Apple: without ENCRYPTION_KEY (outside
    // `next dev`) the session could not be stored anyway.
    if (!canStoreSessions()) {
      console.error(MISSING_ENCRYPTION_KEY_MESSAGE);
      return NextResponse.json({ error: MISSING_ENCRYPTION_KEY_MESSAGE }, { status: 500 });
    }

    const testResult = await testAppleConnection(credentials);
    if (!testResult.success) {
      return NextResponse.json(
        { error: testResult.error },
        { status: 401 }
      );
    }

    const sessionId = await createAppleSession(credentials);

    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });
    cookieStore.delete(BUNDLE_ID_COOKIE);

    return NextResponse.json({
      success: true,
      keyId,
      issuerId,
    });
  } catch (error) {
    console.error('Apple auth error:', error);
    if (error instanceof MissingEncryptionKeyError) {
      // Operator misconfiguration; message is safe to show (no secrets).
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
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
    const bundleId = cookieStore.get(BUNDLE_ID_COOKIE)?.value ?? null;

    if (!sessionId) {
      return NextResponse.json({ authenticated: false });
    }

    const credentials = await getAppleSessionCredentials(sessionId);
    if (!credentials) {
      return NextResponse.json({ authenticated: false });
    }

    return NextResponse.json({
      authenticated: true,
      bundleId,
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
