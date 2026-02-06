import { NextResponse } from 'next/server';
import { getAppleAuthFromCookies } from '../auth/route';
import {
  listInAppPurchases,
  getInAppPurchasePrices,
  AppleApiError,
} from '@/lib/apple-connect';

export async function GET() {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const products = await listInAppPurchases(auth.credentials);

    // Optionally fetch prices for each product (can be expensive)
    // For list view, we return products without prices
    // Prices should be fetched when viewing individual product

    return NextResponse.json({ products });
  } catch (error) {
    console.error('Error fetching Apple products:', error);

    if (error instanceof AppleApiError) {
      if (error.statusCode === 401) {
        return NextResponse.json(
          { error: 'Session expired. Please reconnect.' },
          { status: 401 }
        );
      }
      if (error.statusCode === 403) {
        return NextResponse.json(
          { error: 'Access denied. The API key may not have sufficient permissions.' },
          { status: 403 }
        );
      }
      return NextResponse.json(
        { error: error.detail || 'Failed to fetch products' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch products' },
      { status: 500 }
    );
  }
}
