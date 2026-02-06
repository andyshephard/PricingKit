import { NextRequest, NextResponse } from 'next/server';
import { getAppleAuthFromCookies } from '../../../auth/route';
import {
  getSubscriptionPricePoints,
  AppleApiError,
} from '@/lib/apple-connect';
import { alpha2ToAlpha3 } from '@/lib/apple-connect/territories';

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

    const { id } = await params;
    const territory = request.nextUrl.searchParams.get('territory') || 'US';

    // Convert alpha-2 to alpha-3 if needed (Apple API uses alpha-3)
    const alpha3Territory = alpha2ToAlpha3(territory) || territory;

    const pricePoints = await getSubscriptionPricePoints(
      auth.credentials,
      id,
      alpha3Territory
    );

    return NextResponse.json({ pricePoints });
  } catch (error) {
    console.error('Error fetching subscription price points:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to fetch price points' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch price points' },
      { status: 500 }
    );
  }
}
