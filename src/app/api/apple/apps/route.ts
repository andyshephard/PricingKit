import { NextResponse } from 'next/server';
import { AppleApiError } from '@/lib/apple-connect/client';
import { requireAppleAuth, storeRefusedTokenResponse } from '@/middleware/auth';
import { listAppleApps } from '../_lib/apps';

export type { AppleAppSummary } from '../_lib/apps';

export async function GET(request: Request) {
  const auth = requireAppleAuth(request, { app: 'none' });
  if (!auth.ok) return auth.response;

  try {
    const apps = await listAppleApps(auth.connection);
    return NextResponse.json({ apps });
  } catch (error) {
    if (error instanceof AppleApiError) {
      if (error.statusCode === 401) {
        return storeRefusedTokenResponse('App Store Connect refused the access token.');
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
