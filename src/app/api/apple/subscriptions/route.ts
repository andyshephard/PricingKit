import { NextResponse } from 'next/server';
import { getAppleAuthFromCookies } from '../auth/route';
import {
  listSubscriptionGroups,
  AppleApiError,
} from '@/lib/apple-connect';

export async function GET() {
  try {
    console.log('[Apple Subscriptions Route] Starting GET request');
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      console.log('[Apple Subscriptions Route] Not authenticated');
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    // Log bundle ID only (non-sensitive identifier)
    console.log('[Apple Subscriptions Route] Authenticated with bundleId:', auth.credentials.bundleId);

    const subscriptionGroups = await listSubscriptionGroups(auth.credentials);
    console.log('[Apple Subscriptions Route] Subscription groups returned:', subscriptionGroups.length);

    // Flatten subscriptions for easier consumption
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
        { error: error.detail || 'Failed to fetch subscriptions' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch subscriptions' },
      { status: 500 }
    );
  }
}
