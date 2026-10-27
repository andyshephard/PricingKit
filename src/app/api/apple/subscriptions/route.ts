import { NextResponse } from 'next/server';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import { appleKeyConnection } from '@/lib/token-source';
import {
  listSubscriptionGroups,
} from '@/lib/apple-connect';
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

    const subscriptionGroups = await listSubscriptionGroups(connection);

    // For list view, we return subscriptions without prices.
    // Prices should be fetched when viewing individual subscription.
    const subscriptions = subscriptionGroups.flatMap((group) =>
      group.subscriptions.map((sub) => ({
        ...sub,
        groupName: group.name,
      }))
    );

    return NextResponse.json({
      subscriptionGroups,
      subscriptions,
    });
  } catch (error) {
    console.error('Error fetching Apple subscriptions:', error);

    return appleErrorResponse(error, 'Failed to fetch subscriptions');
  }
}
