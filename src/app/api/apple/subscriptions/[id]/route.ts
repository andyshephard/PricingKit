import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '../../auth/route';
import {
  getSubscription,
  getSubscriptionById,
  getSubscriptionPrices,
  updateSubscriptionPrice,
  deleteSubscriptionPrice,
  AppleApiError,
} from '@/lib/apple-connect';
import { executeWithRateLimit, RateLimitError } from '@/lib/utils/rate-limit';
import {
  validateAndDecodeAppleProductId,
  ValidationError,
  regionCodeSchema,
} from '@/lib/validation';

// Check if the ID is a numeric Apple subscription ID (e.g., "6746950587")
function isNumericSubscriptionId(id: string): boolean {
  return /^\d+$/.test(id);
}

// GET /api/apple/subscriptions/[id] - Get a single subscription with prices
// Supports both numeric subscription ID (e.g., "6746950587") and productId (e.g., "com.example.subscription")
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

    let subscription;

    if (isNumericSubscriptionId(id)) {
      // Fetch directly by Apple subscription ID
      subscription = await getSubscriptionById(auth.credentials, id);
    } else {
      // Validate and decode product ID, then look up
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
      subscription = await getSubscription(auth.credentials, productId);
    }

    if (!subscription) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    // Fetch prices for this subscription
    const pricesResult = await getSubscriptionPrices(auth.credentials, subscription.id);
    subscription.prices = pricesResult.current;
    subscription.scheduledPrices = Object.keys(pricesResult.scheduled).length > 0
      ? pricesResult.scheduled
      : undefined;

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
// Supports both numeric subscription ID and productId
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

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }
    const result = updatePriceSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    // Get the subscription (by ID or productId)
    let subscription;
    if (isNumericSubscriptionId(id)) {
      subscription = await getSubscriptionById(auth.credentials, id);
    } else {
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
      subscription = await getSubscription(auth.credentials, productId);
    }

    if (!subscription) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    // Update prices for each territory with rate limiting to avoid overwhelming Apple's API
    const { prices } = result.data;
    const priceEntries = Object.entries(prices);

    // Fetch current scheduled prices to check for conflicts
    // Apple only allows one scheduled (future) price per territory
    const currentPricesResult = await getSubscriptionPrices(auth.credentials, subscription.id);
    const scheduledPrices = currentPricesResult.scheduled;

    // For each territory being updated with a future startDate, delete existing scheduled price first
    const deleteTasks: (() => Promise<void>)[] = [];

    for (const [territoryCode, { startDate }] of priceEntries) {
      if (startDate && scheduledPrices[territoryCode]?.subscriptionPriceId) {
        deleteTasks.push(() =>
          deleteSubscriptionPrice(
            auth.credentials,
            scheduledPrices[territoryCode].subscriptionPriceId!
          )
        );
      }
    }

    // Execute deletions first (rate-limited)
    if (deleteTasks.length > 0) {
      await executeWithRateLimit(deleteTasks, {
        concurrency: 3,
        delayBetweenBatches: 100,
        maxRetries: 3,
        retryDelay: 1000,
      });
    }

    // Create task functions (not promises) for rate-limited execution
    const createTasks = priceEntries.map(
      ([territoryCode, { pricePointId, startDate }]) =>
        () => updateSubscriptionPrice(
          auth.credentials,
          subscription.id,
          pricePointId,
          territoryCode,
          startDate
        )
    );

    // Execute with rate limiting: 3 concurrent requests, retry on 500 errors
    await executeWithRateLimit(createTasks, {
      concurrency: 3,
      delayBetweenBatches: 100,
      maxRetries: 3,
      retryDelay: 1000,
    });

    // Fetch updated subscription by its ID
    const updatedSubscription = await getSubscriptionById(auth.credentials, subscription.id);
    if (updatedSubscription) {
      const updatedPricesResult = await getSubscriptionPrices(
        auth.credentials,
        updatedSubscription.id
      );
      updatedSubscription.prices = updatedPricesResult.current;
      updatedSubscription.scheduledPrices = Object.keys(updatedPricesResult.scheduled).length > 0
        ? updatedPricesResult.scheduled
        : undefined;
    }

    return NextResponse.json({
      success: true,
      subscription: updatedSubscription,
    });
  } catch (error) {
    console.error('Error updating Apple subscription:', error);

    // Handle rate limit errors with partial success information
    if (error instanceof RateLimitError) {
      const originalError = error.originalError;
      const statusCode = originalError instanceof AppleApiError
        ? originalError.statusCode
        : 500;

      return NextResponse.json(
        {
          error: `Failed to update prices: ${error.successCount} of ${error.totalCount} regions succeeded before failure`,
          successCount: error.successCount,
          totalCount: error.totalCount,
          failedIndex: error.failedIndex,
          originalError: originalError instanceof AppleApiError
            ? originalError.detail
            : originalError.message,
        },
        { status: statusCode }
      );
    }

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

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }
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
