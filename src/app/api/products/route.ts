import { NextResponse } from 'next/server';
import { getGoogleAuthFromCookies } from '@/middleware/auth';
import { GoogleKeyTokenSource } from '@/lib/token-source';
import { listInAppProducts } from '@/lib/google-play/products';

export async function GET() {
  try {
    const auth = await getGoogleAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }
    const tokens = new GoogleKeyTokenSource(auth.credentials);

    const products = await listInAppProducts(tokens, auth.packageName);

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
