import { NextResponse } from 'next/server';
import { requireAppleAuth } from '@/middleware/auth';
import {
  listSubscriptionGroups,
} from '@/lib/apple-connect';
import { appleErrorResponse } from '../_lib/error-response';

export async function GET(request: Request) {
  try {
    const auth = requireAppleAuth(request);
    if (!auth.ok) return auth.response;
    const { connection } = auth;

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
