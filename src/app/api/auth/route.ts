import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  validateServiceAccountJson,
  createSession,
  getSessionCredentials,
  deleteSession,
  googlePlayFetch,
} from '@/lib/google-play/client';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';
import { GOOGLE_PRICING_WRITE_DENIED_ERROR } from '@/lib/google-play/errors';

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

    // Verify write permission for pricing edits. Probe = no-op PATCH on first existing
    // product or subscription, sending the same listings back (true no-op data-wise).
    // Google validates resource existence before IAM perm, so we must use a real resource.
    //   - 403 → service account lacks pricing write perm; block login.
    //   - any other error → inconclusive; proceed (the route-level 403 handlers catch the
    //     real edit later with a clear message).
    try {
      const appsBase = `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;

      // Try a one-time product first.
      const otpList = await googlePlayFetch<ProbeListResp<ProbeProduct>>(
        creds,
        `${appsBase}/oneTimeProducts`,
        { query: { pageSize: 1 } }
      );
      const probeProduct = otpList.oneTimeProducts?.[0];

      if (probeProduct?.productId) {
        const full = await googlePlayFetch<ProbeProduct>(
          creds,
          `${appsBase}/oneTimeProducts/${encodeURIComponent(probeProduct.productId)}`
        );
        // PATCH path is lowercase per Google's discovery doc (only this one method is).
        // updateMask=purchaseOptions tests the actual pricing-edit permission.
        await googlePlayFetch<unknown>(
          creds,
          `${appsBase}/onetimeproducts/${encodeURIComponent(probeProduct.productId)}`,
          {
            method: 'PATCH',
            query: { 'regionsVersion.version': '2025/03', updateMask: 'purchaseOptions' },
            body: full,
          }
        );
      } else {
        const subList = await googlePlayFetch<ProbeListResp<ProbeProduct>>(
          creds,
          `${appsBase}/subscriptions`,
          { query: { pageSize: 1 } }
        );
        const probeSub = subList.subscriptions?.[0];

        if (probeSub?.productId) {
          const fullSub = await googlePlayFetch<ProbeProduct>(
            creds,
            `${appsBase}/subscriptions/${encodeURIComponent(probeSub.productId)}`
          );
          // updateMask=basePlans tests the pricing-edit permission for subscriptions.
          await googlePlayFetch<unknown>(
            creds,
            `${appsBase}/subscriptions/${encodeURIComponent(probeSub.productId)}`,
            {
              method: 'PATCH',
              query: { 'regionsVersion.version': '2025/03', updateMask: 'basePlans' },
              body: fullSub,
            }
          );
        }
        // No products or subscriptions on this app — cannot probe write perm.
        // The route-level 403 handlers will surface the issue at first edit.
      }
    } catch (apiError: unknown) {
      const error = apiError as { code?: number; message?: string; errors?: Array<{ reason?: string; message?: string }> };

      if (error.code === 403) {
        console.error('Google write-permission probe denied:', JSON.stringify(error, null, 2));
        return NextResponse.json(GOOGLE_PRICING_WRITE_DENIED_ERROR, { status: 403 });
      }
      // Inconclusive — read probe already confirmed auth + app exist.
      console.warn('Write-permission probe inconclusive:', error.code, error.message);
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
