import { NextRequest, NextResponse } from 'next/server';
import { getAppleAuthFromCookies } from '../../../auth/route';
import { getInAppPurchase } from '@/lib/apple-connect/products';
import { appleApiRequest, AppleApiError } from '@/lib/apple-connect/client';
import type {
  AppleApiListResponse,
  AppleInAppPurchasePricePoint,
  AppleTerritory,
} from '@/lib/apple-connect/types';
import {
  alpha2ToAlpha3,
  getTerritoryByAlpha3,
} from '@/lib/apple-connect/territories';
import {
  validateAndDecodeAppleProductId,
  ValidationError,
} from '@/lib/validation';

interface EqualizedPrice {
  customerPrice: string;
  currency: string;
  pricePointId: string;
  proceeds?: string;
}

// GET /api/apple/products/[id]/equalized-prices?territory=USA&price=4.99
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

    let productId: string;
    try {
      productId = validateAndDecodeAppleProductId(id);
    } catch (error) {
      if (error instanceof ValidationError) {
        return NextResponse.json(
          { error: error.message, details: error.details },
          { status: 400 }
        );
      }
      throw error;
    }

    const product = await getInAppPurchase(auth.credentials, productId);
    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

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

    const pricePointsResponse = await appleApiRequest<
      AppleApiListResponse<AppleInAppPurchasePricePoint>
    >(auth.credentials, `/inAppPurchases/${product.id}/pricePoints`, {
      apiVersion: 'v2',
      queryParams: {
        'filter[territory]': baseTerritory,
        include: 'territory',
        limit: '8000',
        'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds,territory',
        'fields[territories]': 'currency',
      },
    });

    if (!pricePointsResponse.data?.length) {
      return NextResponse.json(
        { error: `No Apple price points found for ${baseTerritory}` },
        { status: 404 }
      );
    }

    let source = pricePointsResponse.data[0];
    let minDiff = Math.abs(Number(source.attributes.customerPrice) - basePrice);
    for (const point of pricePointsResponse.data.slice(1)) {
      const diff = Math.abs(Number(point.attributes.customerPrice) - basePrice);
      if (diff < minDiff) {
        source = point;
        minDiff = diff;
      }
    }

    const response = await appleApiRequest<
      AppleApiListResponse<AppleInAppPurchasePricePoint>
    >(
      auth.credentials,
      `/inAppPurchasePricePoints/${encodeURIComponent(source.id)}/equalizations`,
      {
        apiVersion: 'v1',
        queryParams: {
          include: 'territory',
          limit: '8000',
          'fields[inAppPurchasePricePoints]': 'customerPrice,proceeds,territory',
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

      // Product bulk pricing uses alpha-3 region keys.
      const currency =
        currencies.get(alpha3) || getTerritoryByAlpha3(alpha3)?.currency || 'USD';

      prices[alpha3] = {
        customerPrice: point.attributes.customerPrice,
        currency,
        pricePointId: point.id,
        proceeds: point.attributes.proceeds,
      };
    }

    prices[baseTerritory] = {
      customerPrice: source.attributes.customerPrice,
      currency: getTerritoryByAlpha3(baseTerritory)?.currency || 'USD',
      pricePointId: source.id,
      proceeds: source.attributes.proceeds,
    };

    return NextResponse.json({
      sourcePricePointId: source.id,
      sourceCustomerPrice: source.attributes.customerPrice,
      prices,
    });
  } catch (error) {
    console.error('Error fetching Apple IAP equalizations:', error);

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
