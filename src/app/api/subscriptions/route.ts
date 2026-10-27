import { NextResponse } from 'next/server';
import { requireGoogleAuth } from '@/middleware/auth';
import { listSubscriptions } from '@/lib/google-play/subscriptions';

export async function GET(request: Request) {
  try {
    const auth = requireGoogleAuth(request);
    if (!auth.ok) return auth.response;
    const { tokens } = auth;

    const subscriptions = await listSubscriptions(tokens, auth.packageName);

    return NextResponse.json({ subscriptions });
  } catch (error: unknown) {
    console.error('Subscriptions list error:', error);
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
      { error: 'Failed to fetch subscriptions' },
      { status: 500 }
    );
  }
}
