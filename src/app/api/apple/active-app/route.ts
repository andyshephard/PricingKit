import { NextRequest, NextResponse } from 'next/server';
import { appleApiRequest, AppleApiError } from '@/lib/apple-connect/client';
import type { AppleApiListResponse } from '@/lib/apple-connect/types';
import { requireAppleAuth, unauthorizedResponse } from '@/middleware/auth';
import { readJsonBody, rejectCrossSite, SMALL_BODY_LIMIT } from '@/lib/request-guard';
import { bundleIdSchema } from '@/lib/validation';

// POST /api/apple/active-app { bundleId }
// Checks that the app is visible with the browser's App Store Connect token.
// Nothing is stored: the browser keeps the selection and sends it as X-PK-App.
export async function POST(request: NextRequest) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const auth = requireAppleAuth(request, { app: 'none', long: false });
  if (!auth.ok) return auth.response;

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

  try {
    const response = await appleApiRequest<
      AppleApiListResponse<{ id: string; attributes: { bundleId: string } }>
    >({ ...auth.connection, bundleId }, '/apps', {
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
      return unauthorizedResponse('Apple credentials are invalid or expired.', 'INVALID_TOKEN');
    }
    console.error('POST /api/apple/active-app verify failed:', error);
    return NextResponse.json(
      { error: 'Failed to verify app access with App Store Connect.' },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, bundleId });
}
