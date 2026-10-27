import { NextRequest, NextResponse } from 'next/server';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import { appleKeyConnection } from '@/lib/token-source';
import {
  getSubscriptionPricePoints,
} from '@/lib/apple-connect';
import { appleErrorResponse } from '../../../_lib/error-response';
import { alpha2ToAlpha3 } from '@/lib/apple-connect/territories';
import { assertSubscriptionInApp } from '@/lib/apple-connect/ownership';
import { appleInternalIdSchema } from '@/lib/validation';

// GET /api/apple/subscriptions/[id]/price-points?territory=US
// Returns available price tiers for a territory
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }
    const connection = appleKeyConnection(auth.credentials);

    const { id } = await params;
    // Only a numeric subscription ID reaches the App Store Connect path
    if (!appleInternalIdSchema.safeParse(id).success) {
      return NextResponse.json({ error: 'Use the numeric App Store Connect subscription ID' }, { status: 400 });
    }
    const territory = request.nextUrl.searchParams.get('territory') || 'US';
    if (!/^[A-Z]{2,3}$/.test(territory)) {
      return NextResponse.json({ error: 'territory must be an ISO 3166-1 code, e.g. GB' }, { status: 400 });
    }
    // API keys reach every app of a team: refuse another app's subscription
    await assertSubscriptionInApp(connection, id);

    // Convert alpha-2 to alpha-3 if needed (Apple API uses alpha-3)
    const alpha3Territory = alpha2ToAlpha3(territory) || territory;

    const pricePoints = await getSubscriptionPricePoints(
      connection,
      id,
      alpha3Territory
    );

    return NextResponse.json({ pricePoints });
  } catch (error) {
    console.error('Error fetching subscription price points:', error);

    return appleErrorResponse(error, 'Failed to fetch price points');
  }
}
