import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  validateServiceAccountJson,
  googlePlayFetch,
} from '@/lib/google-play/client';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';
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
  SESSION_COOKIE_MAX_AGE,
  writeCookie,
  writeSessionCookie,
} from '@/lib/session';

interface ProbeListResp<T> {
  subscriptions?: T[];
}
interface ProbeProduct {
  productId?: string;
}

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
    const { credentials, packageName } = body;

    if (!credentials || !packageName) {
      return NextResponse.json(
        { error: 'Missing credentials or package name' },
        { status: 400 }
      );
    }

    if (!validateServiceAccountJson(credentials)) {
      return NextResponse.json(
        { error: 'Invalid service account JSON structure' },
        { status: 400 }
      );
    }

    // Fail closed before contacting Google: without ENCRYPTION_KEY (outside
    // `next dev`) the session could not be stored anyway.
    if (!canStoreSessions()) {
      console.error(encryptionKeyMessage());
      return NextResponse.json({ error: encryptionKeyMessage() }, { status: 500 });
    }

    // Test the connection by trying to list subscriptions (uses the newer monetization API)
    const creds = credentials as ServiceAccountCredentials;

    try {
      // Use the monetization API which is the current supported API
      await googlePlayFetch<ProbeListResp<ProbeProduct>>(
        creds,
        `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions`,
        { query: { pageSize: 1 } }
      );
    } catch (apiError: unknown) {
      const error = apiError as { code?: number; message?: string; errors?: Array<{ reason?: string; message?: string }> };
      console.error('Google API error:', JSON.stringify(error, null, 2));

      if (error.code === 401) {
        return NextResponse.json(
          { error: 'Invalid credentials. Please check your service account JSON file.' },
          { status: 401 }
        );
      }
      if (error.code === 403) {
        // Extract more specific error info from Google's response
        const reason = error.errors?.[0]?.reason || '';
        const details = error.message || '';

        let errorMessage = 'Access denied. ';

        if (details.includes('migrate') || details.includes('publishing API')) {
          errorMessage = 'Google requires API migration. Please go to Play Console → Settings → API access and accept any pending terms or agreements. You may need to re-link your API project.';
        } else if (reason === 'projectNotLinked' || details.includes('project')) {
          errorMessage += 'The Google Cloud project may not be properly configured. Ensure the Google Play Android Developer API is enabled.';
        } else if (reason === 'permissionDenied' || details.includes('permission')) {
          errorMessage += 'The service account lacks required permissions. In Play Console → Users and permissions, ensure the service account has "View app information" and "Manage pricing and distribution" permissions.';
        } else if (details.includes('API') || details.includes('enabled')) {
          errorMessage += 'The Google Play Android Developer API may not be enabled. Go to Google Cloud Console → APIs & Services → Enable the "Google Play Android Developer API".';
        } else {
          errorMessage += 'Ensure the service account has been invited to Play Console with correct permissions.';
        }

        return NextResponse.json(
          { error: errorMessage },
          { status: 403 }
        );
      }
      if (error.code === 404) {
        return NextResponse.json(
          { error: `App not found. Please verify the package name "${packageName}" is correct and the app exists in Play Console.` },
          { status: 404 }
        );
      }
      throw apiError;
    }

    // Login is read-only: the list call above confirms auth and app access.
    // Pricing write permission is not probed here (that would mean writing to the
    // live store); a missing permission surfaces on the first real edit, where the
    // product/subscription routes return GOOGLE_PRICING_WRITE_DENIED_ERROR.

    // The session keeps client_email, private_key_id, private_key and
    // project_id only, sealed with a 24-hour expiry. Credentials too large
    // for a cookie are refused here rather than dropped by the browser.
    const cookieStore = await cookies();
    try {
      await writeSessionCookie(cookieStore, 'google', creds);
    } catch (error) {
      if (error instanceof CookieTooLargeError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
    writeCookie(cookieStore, COOKIE_NAMES.googlePackage, packageName, SESSION_COOKIE_MAX_AGE);

    return NextResponse.json({
      success: true,
      projectId: creds.project_id,
      clientEmail: creds.client_email,
    });
  } catch (error) {
    console.error('Auth error:', error);
    const err = error as { code?: number; message?: string };
    if (err.code === 401) {
      return NextResponse.json(
        { error: 'Invalid credentials.' },
        { status: 401 }
      );
    }
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
    const packageName = readAppCookie(cookieStore, COOKIE_NAMES.googlePackage);
    if (!packageName) {
      return NextResponse.json({ authenticated: false });
    }

    const credentials = await readSessionCookie(cookieStore, 'google');
    if (!credentials) {
      return NextResponse.json({ authenticated: false });
    }

    return NextResponse.json({
      authenticated: true,
      packageName,
      projectId: credentials.project_id,
      clientEmail: credentials.client_email,
    });
  } catch (error) {
    console.error('Auth check error:', error);
    return NextResponse.json({ authenticated: false });
  }
}

export async function DELETE() {
  try {
    const cookieStore = await cookies();
    clearCookie(cookieStore, COOKIE_NAMES.googleSession);
    clearCookie(cookieStore, COOKIE_NAMES.googlePackage);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json(
      { error: 'Failed to logout' },
      { status: 500 }
    );
  }
}
