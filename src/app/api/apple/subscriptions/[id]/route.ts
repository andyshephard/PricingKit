import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '../../auth/route';
import {
  getSubscription,
  getSubscriptionPrices,
  updateSubscriptionPrice,
  deleteSubscriptionPrice,
  AppleApiError,
} from '@/lib/apple-connect';
import {
  validateAndDecodeAppleProductId,
  ValidationError,
  regionCodeSchema,
} from '@/lib/validation';

// GET /api/apple/subscriptions/[id] - Get a single subscription with prices
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Validate and decode product ID
    let productId: string;
    try {
      productId = validateAndDecodeAppleProductId(id);
    } catch (error) {
      if (error instanceof ValidationError) {
        return NextResponse.json(
          { error: error.message, details: error.details },
          { status: 400 }
        );
      }
      throw error;
    }

    const subscription = await getSubscription(auth.credentials, productId);
    if (!subscription) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    // Fetch prices for this subscription
    const prices = await getSubscriptionPrices(auth.credentials, subscription.id);
    subscription.prices = prices;

    return NextResponse.json({ subscription });
  } catch (error) {
    console.error('Error fetching Apple subscription:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to fetch subscription' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch subscription' },
      { status: 500 }
    );
  }
}

// Schema for price update
const updatePriceSchema = z.object({
  prices: z.record(
    regionCodeSchema,
    z.object({
      pricePointId: z.string().min(1, 'Price point ID is required'),
      startDate: z.string().optional(),
    })
  ),
});

// PATCH /api/apple/subscriptions/[id] - Update subscription prices
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Validate and decode product ID
    let productId: string;
    try {
      productId = validateAndDecodeAppleProductId(id);
    } catch (error) {
      if (error instanceof ValidationError) {
        return NextResponse.json(
          { error: error.message, details: error.details },
          { status: 400 }
        );
      }
      throw error;
    }

    const body = await request.json();
    const result = updatePriceSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    // Get the subscription to find its internal ID
    const subscription = await getSubscription(auth.credentials, productId);
    if (!subscription) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    // Update prices for each territory
    const { prices } = result.data;
    const updates = Object.entries(prices).map(
      ([territoryCode, { pricePointId, startDate }]) =>
        updateSubscriptionPrice(
          auth.credentials,
          subscription.id,
          pricePointId,
          territoryCode,
          startDate
        )
    );

    await Promise.all(updates);

    // Fetch updated subscription
    const updatedSubscription = await getSubscription(auth.credentials, productId);
    if (updatedSubscription) {
      updatedSubscription.prices = await getSubscriptionPrices(
        auth.credentials,
        updatedSubscription.id
      );
    }

    return NextResponse.json({
      success: true,
      subscription: updatedSubscription,
    });
  } catch (error) {
    console.error('Error updating Apple subscription:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to update subscription' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to update subscription' },
      { status: 500 }
    );
  }
}

// Schema for price deletion
const deletePriceSchema = z.object({
  subscriptionPriceId: z.string().min(1, 'Subscription price ID is required'),
});

// DELETE /api/apple/subscriptions/[id] - Delete a subscription price
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const result = deletePriceSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    await deleteSubscriptionPrice(auth.credentials, result.data.subscriptionPriceId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting Apple subscription price:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to delete price' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to delete price' },
      { status: 500 }
    );
  }
}
