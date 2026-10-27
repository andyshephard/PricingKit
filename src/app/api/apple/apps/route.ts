import { NextResponse } from 'next/server';
import { appleApiRequest, AppleApiError } from '@/lib/apple-connect/client';
import type { AppleApiListResponse } from '@/lib/apple-connect/types';
import { getAppleSessionFromCookies } from '@/middleware/auth';
import { appleKeyConnection } from '@/lib/key-token-source';

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
  const credentials = await getAppleSessionFromCookies();
  if (!credentials) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const response = await appleApiRequest<AppleApiListResponse<AppleAppListItem>>(
      appleKeyConnection(credentials),
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
