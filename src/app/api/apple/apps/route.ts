import { NextResponse } from 'next/server';
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

interface AppleAppListItem {
  id: string;
  type: 'apps';
  attributes: {
    name: string;
    bundleId: string;
    sku?: string;
  };
}

export interface AppleAppSummary {
  id: string;
  name: string;
  bundleId: string;
  sku: string | null;
}

export async function GET() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(APPLE_SESSION_COOKIE)?.value;
  if (!sessionId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const sessionCredentials = await getAppleSessionCredentials(sessionId);
  if (!sessionCredentials) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const credentials: AppleConnectCredentials = {
    ...sessionCredentials,
    bundleId: sessionCredentials.bundleId ?? '',
  };

  try {
    const response = await appleApiRequest<AppleApiListResponse<AppleAppListItem>>(
      credentials,
      '/apps',
      {
        queryParams: {
          'fields[apps]': 'name,bundleId,sku',
          limit: '200',
        },
      }
    );

    const apps: AppleAppSummary[] = (response.data ?? []).map((app) => ({
      id: app.id,
      name: app.attributes.name,
      bundleId: app.attributes.bundleId,
      sku: app.attributes.sku ?? null,
    }));

    return NextResponse.json({ apps });
  } catch (error) {
    if (error instanceof AppleApiError) {
      if (error.statusCode === 401) {
        return NextResponse.json(
          { error: 'Apple credentials are invalid or expired.' },
          { status: 401 }
        );
      }
      if (error.statusCode === 403) {
        return NextResponse.json(
          { error: 'Apple API key lacks permission to list apps.' },
          { status: 403 }
        );
      }
    }
    console.error('GET /api/apple/apps failed:', error);
    return NextResponse.json(
      { error: 'Failed to fetch apps from App Store Connect.' },
      { status: 500 }
    );
  }
}
