import { NextResponse } from 'next/server';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import { appleKeyConnection } from '@/lib/token-source';
import { listInAppPurchases } from '@/lib/apple-connect';
import { appleErrorResponse } from '../_lib/error-response';

export async function GET() {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }
    const connection = appleKeyConnection(auth.credentials);

    const products = await listInAppPurchases(connection);

    // Optionally fetch prices for each product (can be expensive)
    // For list view, we return products without prices
    // Prices should be fetched when viewing individual product

    return NextResponse.json({ products });
  } catch (error) {
    console.error('Error fetching Apple products:', error);

    return appleErrorResponse(error, 'Failed to fetch products');
  }
}
