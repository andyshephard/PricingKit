import { NextResponse } from 'next/server';
import { googlePlayFetch } from '@/lib/google-play/client';
import type { TokenSource } from '@/lib/token-source';
import { unauthorizedResponse } from '@/middleware/auth';

interface ProbeListResp {
  subscriptions?: Array<{ productId?: string }>;
}

/**
 * One read-only call (list one subscription) that shows the Google access
 * token can read this app. Null when it can; otherwise the response to send,
 * with a message that says what to fix in Play Console or Google Cloud.
 *
 * Pricing write permission is not probed (that would mean writing to the
 * live store); a missing permission surfaces on the first real edit, where
 * the product and subscription routes return GOOGLE_PRICING_WRITE_DENIED_ERROR.
 */
export async function probeGooglePackage(tokens: TokenSource, packageName: string): Promise<NextResponse | null> {
  try {
    await googlePlayFetch<ProbeListResp>(
      tokens,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions`,
      { query: { pageSize: 1 } }
    );
    return null;
  } catch (apiError: unknown) {
    const error = apiError as { code?: number; message?: string; errors?: Array<{ reason?: string; message?: string }> };
    if (error.code === 401) {
      return unauthorizedResponse('Google refused the access token. Check the service account key, or connect again.', 'INVALID_TOKEN');
    }
    if (error.code === 403) {
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
      return NextResponse.json({ error: errorMessage }, { status: 403 });
    }
    if (error.code === 404) {
      return NextResponse.json(
        { error: 'App not found. Check the package name and that the app exists in Play Console.' },
        { status: 404 }
      );
    }
    console.error('Google Play probe failed:', error.code, error.message);
    return NextResponse.json({ error: 'Failed to verify Google Play app access.' }, { status: 502 });
  }
}
