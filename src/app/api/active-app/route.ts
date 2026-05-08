import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  googlePlayFetch,
  getSessionCredentials,
} from '@/lib/google-play/client';
import { GOOGLE_PRICING_WRITE_DENIED_ERROR } from '@/lib/google-play/errors';

const GOOGLE_SESSION_COOKIE = 'gplay_session';
const GOOGLE_PACKAGE_NAME_COOKIE = 'gplay_package_name';
const COOKIE_MAX_AGE = 24 * 60 * 60;

interface ProbeListResp<T> {
  oneTimeProducts?: T[];
  subscriptions?: T[];
}
interface ProbeProduct {
  productId?: string;
  listings?: unknown;
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(GOOGLE_SESSION_COOKIE)?.value;
  if (!sessionId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const credentials = await getSessionCredentials(sessionId);
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

  // Verify write permission so a switch-to doesn't silently downgrade UX:
  // service account might have read access but lack pricing-edit perms.
  // Mirror the auth route's probe — no-op PATCH on first existing product or
  // subscription. 403 → block; any other error → inconclusive, proceed.
  try {
    const appsBase = `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;

    const otpList = await googlePlayFetch<ProbeListResp<ProbeProduct>>(
      credentials,
      `${appsBase}/oneTimeProducts`,
      { query: { pageSize: 1 } }
    );
    const probeProduct = otpList.oneTimeProducts?.[0];

    if (probeProduct?.productId) {
      const full = await googlePlayFetch<ProbeProduct>(
        credentials,
        `${appsBase}/oneTimeProducts/${encodeURIComponent(probeProduct.productId)}`
      );
      // PATCH path is lowercase per Google's discovery doc.
      await googlePlayFetch<unknown>(
        credentials,
        `${appsBase}/onetimeproducts/${encodeURIComponent(probeProduct.productId)}`,
        {
          method: 'PATCH',
          query: { 'regionsVersion.version': '2025/03', updateMask: 'purchaseOptions' },
          body: full,
        }
      );
    } else {
      const subList = await googlePlayFetch<ProbeListResp<ProbeProduct>>(
        credentials,
        `${appsBase}/subscriptions`,
        { query: { pageSize: 1 } }
      );
      const probeSub = subList.subscriptions?.[0];
      if (probeSub?.productId) {
        const fullSub = await googlePlayFetch<ProbeProduct>(
          credentials,
          `${appsBase}/subscriptions/${encodeURIComponent(probeSub.productId)}`
        );
        await googlePlayFetch<unknown>(
          credentials,
          `${appsBase}/subscriptions/${encodeURIComponent(probeSub.productId)}`,
          {
            method: 'PATCH',
            query: { 'regionsVersion.version': '2025/03', updateMask: 'basePlans' },
            body: fullSub,
          }
        );
      }
      // No products/subs on this app — cannot probe write. Route-level 403 handlers
      // surface the issue on first real edit.
    }
  } catch (apiError: unknown) {
    const error = apiError as { code?: number; message?: string };
    if (error.code === 403) {
      console.error('POST /api/active-app write probe denied:', error);
      return NextResponse.json(GOOGLE_PRICING_WRITE_DENIED_ERROR, { status: 403 });
    }
    console.warn('Write-permission probe inconclusive:', error.code, error.message);
  }

  cookieStore.set(GOOGLE_PACKAGE_NAME_COOKIE, packageName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });

  return NextResponse.json({ ok: true, packageName });
}
