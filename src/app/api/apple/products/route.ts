import { NextResponse } from 'next/server';
import { requireAppleAuth } from '@/middleware/auth';
import { listInAppPurchases } from '@/lib/apple-connect';
import { appleErrorResponse } from '../_lib/error-response';

export async function GET(request: Request) {
  try {
    const auth = requireAppleAuth(request);
    if (!auth.ok) return auth.response;
    const { connection } = auth;

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
