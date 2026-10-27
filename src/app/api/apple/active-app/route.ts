import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { appleApiRequest, AppleApiError } from '@/lib/apple-connect/client';
import { appleKeyConnection } from '@/lib/token-source';
import type {
  AppleApiListResponse,
  AppleConnectCredentials,
} from '@/lib/apple-connect/types';
import { COOKIE_NAMES, readSessionCookie, SESSION_COOKIE_MAX_AGE, writeCookie } from '@/lib/session';
import { readJsonBody, rejectCrossSite, SMALL_BODY_LIMIT } from '@/lib/request-guard';
import { bundleIdSchema } from '@/lib/validation';

export async function POST(request: NextRequest) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const cookieStore = await cookies();
  const sessionCredentials = await readSessionCookie(cookieStore, 'apple');
  if (!sessionCredentials) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const read = await readJsonBody(request, SMALL_BODY_LIMIT);
  if (!read.ok) return read.response;
  const body = (typeof read.body === 'object' && read.body !== null ? read.body : {}) as { bundleId?: unknown };

  if (typeof body.bundleId !== 'string' || body.bundleId.trim() === '') {
    return NextResponse.json(
      { error: 'Missing bundleId in request body' },
      { status: 400 }
    );
  }
  const parsedBundle = bundleIdSchema.safeParse(body.bundleId);
  if (!parsedBundle.success) {
    return NextResponse.json({ error: 'Invalid bundle ID' }, { status: 400 });
  }
  const bundleId = parsedBundle.data;

  const credentials: AppleConnectCredentials = {
    ...sessionCredentials,
    bundleId,
  };

  try {
    const response = await appleApiRequest<
      AppleApiListResponse<{ id: string; attributes: { bundleId: string } }>
    >(appleKeyConnection(credentials), '/apps', {
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

  writeCookie(cookieStore, COOKIE_NAMES.appleBundle, bundleId, SESSION_COOKIE_MAX_AGE);

  return NextResponse.json({ ok: true, bundleId });
}
