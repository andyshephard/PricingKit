import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  appleApiRequest,
  AppleApiError,
  getAppleSessionCredentials,
} from '@/lib/apple-connect/client';
import type {
  AppleApiListResponse,
  AppleConnectCredentials,
} from '@/lib/apple-connect/types';

const APPLE_SESSION_COOKIE = 'apple_session';
const APPLE_BUNDLE_ID_COOKIE = 'apple_bundle_id';
const COOKIE_MAX_AGE = 24 * 60 * 60;

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(APPLE_SESSION_COOKIE)?.value;
  if (!sessionId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const sessionCredentials = await getAppleSessionCredentials(sessionId);
  if (!sessionCredentials) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { bundleId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  const bundleId = body.bundleId;
  if (typeof bundleId !== 'string' || bundleId.trim() === '') {
    return NextResponse.json(
      { error: 'Missing bundleId in request body' },
      { status: 400 }
    );
  }

  const credentials: AppleConnectCredentials = {
    ...sessionCredentials,
    bundleId,
  };

  try {
    const response = await appleApiRequest<
      AppleApiListResponse<{ id: string; attributes: { bundleId: string } }>
    >(credentials, '/apps', {
      queryParams: {
        'filter[bundleId]': bundleId,
        'fields[apps]': 'bundleId',
        limit: '10',
      },
    });
    const exact = (response.data ?? []).find(
      (app) => app.attributes.bundleId === bundleId
    );
    if (!exact) {
      return NextResponse.json(
        {
          error:
            'This app is no longer accessible with your API key — refresh the apps list.',
        },
        { status: 404 }
      );
    }
  } catch (error) {
    if (error instanceof AppleApiError && error.statusCode === 401) {
      return NextResponse.json(
        { error: 'Apple credentials are invalid or expired.' },
        { status: 401 }
      );
    }
    console.error('POST /api/apple/active-app verify failed:', error);
    return NextResponse.json(
      { error: 'Failed to verify app access with App Store Connect.' },
      { status: 500 }
    );
  }

  cookieStore.set(APPLE_BUNDLE_ID_COOKIE, bundleId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });

  return NextResponse.json({ ok: true, bundleId });
}
