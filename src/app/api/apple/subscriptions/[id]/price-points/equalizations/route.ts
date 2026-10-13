import { NextRequest, NextResponse } from 'next/server';
import { getAppleAuthFromCookies } from '../../../../auth/route';
import { getSubscriptionPricePoints } from '@/lib/apple-connect/subscriptions';
import { appleApiRequest, AppleApiError } from '@/lib/apple-connect/client';
import type {
  AppleApiListResponse,
  AppleSubscriptionPricePoint,
  AppleTerritory,
} from '@/lib/apple-connect/types';
import {
  alpha2ToAlpha3,
  alpha3ToAlpha2,
  getTerritoryByAlpha3,
} from '@/lib/apple-connect/territories';

interface EqualizedPrice {
  customerPrice: string;
  currency: string;
  pricePointId: string;
  proceeds?: string;
  proceedsYear2?: string;
}

// GET /api/apple/subscriptions/[id]/price-points/equalizations?territory=USA&price=4.99
//
// Resolve the selected base customer price to a real Apple subscription price
// point, then ask App Store Connect for Apple's equivalent price point in each
// storefront. These are the authoritative localized baselines for Smart pricing.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { id } = await params;
    const territoryParam = request.nextUrl.searchParams.get('territory') || 'USA';
    const priceParam = request.nextUrl.searchParams.get('price');
    const basePrice = priceParam === null ? NaN : Number(priceParam);

    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return NextResponse.json(
        { error: 'A positive numeric base price is required' },
        { status: 400 }
      );
    }

    const baseTerritory =
      territoryParam.length === 2
        ? alpha2ToAlpha3(territoryParam) || territoryParam
        : territoryParam;

    const basePricePoints = await getSubscriptionPricePoints(
      auth.credentials,
      id,
      baseTerritory
    );

    if (basePricePoints.length === 0) {
      return NextResponse.json(
        { error: `No Apple price points found for ${baseTerritory}` },
        { status: 404 }
      );
    }

    let source = basePricePoints[0];
    let minDiff = Math.abs(Number(source.customerPrice) - basePrice);
    for (const point of basePricePoints.slice(1)) {
      const diff = Math.abs(Number(point.customerPrice) - basePrice);
      if (diff < minDiff) {
        source = point;
        minDiff = diff;
      }
    }

    const response = await appleApiRequest<
      AppleApiListResponse<AppleSubscriptionPricePoint>
    >(
      auth.credentials,
      `/subscriptionPricePoints/${encodeURIComponent(source.id)}/equalizations`,
      {
        queryParams: {
          include: 'territory',
          limit: '8000',
          'fields[subscriptionPricePoints]': 'customerPrice,proceeds,proceedsYear2,territory',
          'fields[territories]': 'currency',
        },
      }
    );

    const currencies = new Map<string, string>();
    for (const included of response.included || []) {
      if (included.type === 'territories') {
        const territory = included as AppleTerritory;
        currencies.set(territory.id, territory.attributes.currency);
      }
    }

    const prices: Record<string, EqualizedPrice> = {};

    for (const point of response.data || []) {
      const alpha3 = point.relationships?.territory?.data?.id;
      if (!alpha3) continue;

      const key = alpha3ToAlpha2(alpha3) || alpha3;
      const currency =
        currencies.get(alpha3) || getTerritoryByAlpha3(alpha3)?.currency || 'USD';

      prices[key] = {
        customerPrice: point.attributes.customerPrice,
        currency,
        pricePointId: point.id,
        proceeds: point.attributes.proceeds,
        proceedsYear2: point.attributes.proceedsYear2,
      };
    }

    // Apple's equalizations normally describe the *other* storefronts, so add
    // the selected source point explicitly as the anchor.
    const sourceKey = alpha3ToAlpha2(baseTerritory) || baseTerritory;
    prices[sourceKey] = {
      customerPrice: source.customerPrice,
      currency: getTerritoryByAlpha3(baseTerritory)?.currency || 'USD',
      pricePointId: source.id,
      proceeds: source.proceeds,
      proceedsYear2: source.proceedsYear2,
    };

    return NextResponse.json({
      sourcePricePointId: source.id,
      sourceCustomerPrice: source.customerPrice,
      prices,
    });
  } catch (error) {
    console.error('Error fetching Apple subscription equalizations:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to fetch Apple equalized prices' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch Apple equalized prices' },
      { status: 500 }
    );
  }
}
