import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  validateAppleCredentials,
  testAppleConnection,
} from '@/lib/apple-connect/client';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';
import {
  MissingEncryptionKeyError,
  canStoreSessions,
  encryptionKeyMessage,
} from '@/lib/encryption';
import {
  clearCookie,
  COOKIE_NAMES,
  CookieTooLargeError,
  readAppCookie,
  readSessionCookie,
  writeSessionCookie,
} from '@/lib/session';

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
      console.error(encryptionKeyMessage());
      return NextResponse.json({ error: encryptionKeyMessage() }, { status: 500 });
    }

    const testResult = await testAppleConnection(credentials);
    if (!testResult.success) {
      return NextResponse.json(
        { error: testResult.error },
        { status: 401 }
      );
    }

    const cookieStore = await cookies();
    try {
      await writeSessionCookie(cookieStore, 'apple', credentials);
    } catch (error) {
      if (error instanceof CookieTooLargeError) {
        return NextResponse.json({ error: 'These credentials are too large to keep in a browser cookie.' }, { status: 400 });
      }
      throw error;
    }
    clearCookie(cookieStore, COOKIE_NAMES.appleBundle);

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
    const bundleId = readAppCookie(cookieStore, COOKIE_NAMES.appleBundle) ?? null;
    const credentials = await readSessionCookie(cookieStore, 'apple');
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
    clearCookie(cookieStore, COOKIE_NAMES.appleSession);
    clearCookie(cookieStore, COOKIE_NAMES.appleBundle);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Apple logout error:', error);
    return NextResponse.json(
      { error: 'Failed to logout' },
      { status: 500 }
    );
  }
}
