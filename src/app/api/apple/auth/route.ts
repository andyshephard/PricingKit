import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  validateAppleCredentials,
  testAppleConnection,
} from '@/lib/apple-connect/client';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';
import { appleKeyConnection } from '@/lib/key-token-source';
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
import { rejectCrossSite, readJsonBody, SMALL_BODY_LIMIT } from '@/lib/request-guard';
import { signInAttempts, trustedClientIp } from '@/lib/utils/attempt-limiter';

/** An App Store Connect key (P-256) is about 250 characters of PEM; anything far larger isn't one */
const MAX_PRIVATE_KEY_CHARS = 2048;

export async function POST(request: NextRequest) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const read = await readJsonBody(request, SMALL_BODY_LIMIT);
    if (!read.ok) return read.response;
    const body = (typeof read.body === 'object' && read.body !== null ? read.body : {}) as Record<string, unknown>;
    const { privateKey, keyId, issuerId } = body;

    if (typeof privateKey !== 'string' || typeof keyId !== 'string' || typeof issuerId !== 'string' || !privateKey || !keyId || !issuerId) {
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

    if (privateKey.length > MAX_PRIVATE_KEY_CHARS || keyId.length > 64 || issuerId.length > 64 || !validateAppleCredentials(credentials)) {
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

    // Sign-in attempts are limited per client (with TRUSTED_CLIENT_IP_HEADER) and per instance
    const decision = signInAttempts.attempt(trustedClientIp(request.headers, process.env.TRUSTED_CLIENT_IP_HEADER));
    if (!decision.allowed) {
      return NextResponse.json(
        { error: 'Too many sign-in attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } }
      );
    }

    const testResult = await testAppleConnection(appleKeyConnection(credentials));
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

export async function DELETE(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
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
