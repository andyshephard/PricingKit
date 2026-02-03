import { NextResponse } from 'next/server';
import { getAuthFromCookies } from '../auth/route';
import { createGooglePlayClient } from '@/lib/google-play/client';
import { listInAppProducts } from '@/lib/google-play/products';

export async function GET() {
  try {
    const auth = await getAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const client = createGooglePlayClient(auth.credentials);
    const products = await listInAppProducts(client, auth.packageName);

    return NextResponse.json({ products });
  } catch (error: unknown) {
    console.error('Products list error:', error);
    const err = error as { code?: number; message?: string };

    if (err.code === 401) {
      return NextResponse.json(
        { error: 'Authentication expired. Please reconnect.' },
        { status: 401 }
      );
    }
    if (err.code === 403) {
      return NextResponse.json(
        { error: 'Access denied. Check service account permissions.' },
        { status: 403 }
      );
    }
    if (err.code === 429) {
      return NextResponse.json(
        { error: 'Rate limited. Please try again later.' },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch products' },
      { status: 500 }
    );
  }
}
