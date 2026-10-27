import { NextRequest, NextResponse } from 'next/server';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import { appleKeyConnection } from '@/lib/key-token-source';
import { AppleAdapter } from '@/lib/adapters/apple';
import { RequestBudget } from '@/lib/utils/request-budget';
import { appleErrorResponse } from '../../../_lib/error-response';
import { assertSubscriptionInApp } from '@/lib/apple-connect/ownership';

// GET /api/apple/subscriptions/[id]/offers
// Read-only: every offer of the subscription (introductory, promotional, offer
// codes, win-back) with its prices per territory. [id] is Apple's numeric
// subscription ID.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const connection = appleKeyConnection(auth.credentials);

    const { id } = await params;
    if (!/^\d+$/.test(id)) {
      return NextResponse.json({ error: 'Use the numeric App Store Connect subscription ID' }, { status: 400 });
    }

    const budget = new RequestBudget();
    // API keys reach every app of a team: refuse another app's subscription
    await assertSubscriptionInApp(connection, id, { budget });
    const adapter = new AppleAdapter({ ...connection, budget });
    const offers = await adapter.fetchOffers({ platform: 'apple', type: 'subscription', id });
    return NextResponse.json({ offers });
  } catch (error) {
    console.error('Error fetching subscription offers:', error);
    return appleErrorResponse(error, 'Failed to fetch offers');
  }
}
