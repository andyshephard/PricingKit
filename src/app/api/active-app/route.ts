import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { googlePlayFetch } from '@/lib/google-play/client';
import { COOKIE_NAMES, readSessionCookie, SESSION_COOKIE_MAX_AGE, writeCookie } from '@/lib/session';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const credentials = await readSessionCookie(cookieStore, 'google');
  if (!credentials) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { packageName?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  const packageName = body.packageName;
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    return NextResponse.json(
      { error: 'Missing packageName in request body' },
      { status: 400 }
    );
  }

  try {
    await googlePlayFetch(
      credentials,
      `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/subscriptions`,
      { query: { pageSize: 1 } }
    );
  } catch (apiError: unknown) {
    const error = apiError as { code?: number; message?: string };
    if (error.code === 401) {
      return NextResponse.json(
        { error: 'Google credentials are invalid or expired.' },
        { status: 401 }
      );
    }
    if (error.code === 403) {
      return NextResponse.json(
        {
          error:
            "Service account doesn't have access to this app. Invite it via Play Console → Users and permissions.",
        },
        { status: 403 }
      );
    }
    if (error.code === 404) {
      return NextResponse.json(
        {
          error: `App not found. Verify the package name "${packageName}" is correct and the app exists in Play Console.`,
        },
        { status: 404 }
      );
    }
    console.error('POST /api/active-app probe failed:', apiError);
    return NextResponse.json(
      { error: 'Failed to verify Google Play app access.' },
      { status: 500 }
    );
  }

  // Switching apps is read-only: the list call above confirms access. Pricing
  // write permission is not probed (that would mean writing to the live store);
  // a missing permission surfaces on the first real edit via the route-level 403
  // handlers.

  writeCookie(cookieStore, COOKIE_NAMES.googlePackage, packageName, SESSION_COOKIE_MAX_AGE);

  return NextResponse.json({ ok: true, packageName });
}
