import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  validateServiceAccountJson,
  clearGoogleAccessTokenCache,
  createSession,
  getSessionCredentials,
  deleteSession,
  googlePlayFetch,
} from '@/lib/google-play/client';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';

interface ProbeListResp<T> {
  oneTimeProducts?: T[];
  subscriptions?: T[];
}
interface ProbeProduct {
  productId?: string;
  listings?: unknown;
}

const SESSION_COOKIE = 'gplay_session';
const PACKAGE_NAME_COOKIE = 'gplay_package_name';
const COOKIE_MAX_AGE = 24 * 60 * 60; // 24 hours

export async function POST(request: NextRequest) {
  try {
    let body: {
      credentials?: unknown;
      packageName?: unknown;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }
    const { credentials, packageName } = body;

    if (!credentials || typeof packageName !== 'string' || packageName.trim() === '') {
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

    // Test the connection by trying to list subscriptions (uses the newer monetization API)
    const creds = credentials as ServiceAccountCredentials;
    // A user may reconnect immediately after changing Play Console permissions.
    // Do not reuse a token minted before that grant was updated.
    clearGoogleAccessTokenCache();

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
          errorMessage += 'The service account lacks required permissions. In Play Console → Users and permissions, ensure the exact service-account email has app access with "View app information (read only)" and "Manage store presence".';
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

    // Create session and store session ID in cookie
    const sessionId = await createSession(creds);

    const cookieStore = await cookies();

    cookieStore.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });

    cookieStore.set(PACKAGE_NAME_COOKIE, packageName, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });

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
    return NextResponse.json(
      { error: err.message || 'Failed to authenticate. Please try again.' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
    const packageName = cookieStore.get(PACKAGE_NAME_COOKIE)?.value;

    if (!sessionId || !packageName) {
      return NextResponse.json({ authenticated: false });
    }

    const credentials = await getSessionCredentials(sessionId);
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
    const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

    if (sessionId) {
      await deleteSession();
    }

    cookieStore.delete(SESSION_COOKIE);
    cookieStore.delete(PACKAGE_NAME_COOKIE);
    clearGoogleAccessTokenCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json(
      { error: 'Failed to logout' },
      { status: 500 }
    );
  }
}

// Helper to get credentials and package name from cookies (for use in other API routes)
export async function getAuthFromCookies(): Promise<{
  credentials: ServiceAccountCredentials;
  packageName: string;
} | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  const packageName = cookieStore.get(PACKAGE_NAME_COOKIE)?.value;

  if (!sessionId || !packageName) {
    return null;
  }

  const credentials = await getSessionCredentials(sessionId);
  if (!credentials) {
    return null;
  }

  return { credentials, packageName };
}
