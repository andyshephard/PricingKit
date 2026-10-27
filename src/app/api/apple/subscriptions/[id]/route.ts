import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import {
  getSubscription,
  getSubscriptionById,
  getSubscriptionPrices,
  applySubscriptionPriceChanges,
  deleteSubscriptionPrice,
} from '@/lib/apple-connect';
import { appleErrorResponse, getAppleErrorMessage } from '../../_lib/error-response';
import { RateLimitError } from '@/lib/utils/rate-limit';
import { createNdjsonStream, NDJSON_HEADERS } from '@/lib/utils/ndjson-stream';
import {
  validateAndDecodeAppleProductId,
  ValidationError,
  regionCodeSchema,
} from '@/lib/validation';

// Check if the ID is a numeric Apple subscription ID (e.g., "1234567890")
function isNumericSubscriptionId(id: string): boolean {
  return /^\d+$/.test(id);
}

// GET /api/apple/subscriptions/[id] - Get a single subscription with prices
// Supports both numeric subscription ID (e.g., "1234567890") and productId (e.g., "com.example.subscription")
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

    return appleErrorResponse(error, 'Failed to fetch subscription');
  }
}

// Schema for price update
const updatePriceSchema = z.object({
  preserveCurrentPrice: z.boolean().optional().default(true),
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

    const { prices, preserveCurrentPrice } = result.data;

    // Fetch current scheduled prices: Apple only allows one scheduled (future)
    // price per territory, so a future-dated change replaces the existing one
    const currentPricesResult = await getSubscriptionPrices(auth.credentials, subscription.id);
    const scheduledPrices = currentPricesResult.scheduled;

    // Stream progress back to the client
    const { stream, writer } = createNdjsonStream();
    const credentials = auth.credentials;
    const subscriptionId = subscription.id;

    (async () => {
      try {
        // Creates first, deletes only after the replacement exists; a failed create deletes nothing
        const outcomes = await applySubscriptionPriceChanges(
          credentials,
          subscriptionId,
          prices,
          scheduledPrices,
          {
            preserveCurrentPrice,
            onProgress: (completed, total) => writer.progress(completed, total, 'update'),
          }
        );

        const failed = outcomes.filter((o) => o.status === 'failed');
        const warnings = outcomes.filter((o) => o.warning);

        // Fetch updated subscription by its ID. The writes are already done, so a
        // failed refresh is reported alongside the outcomes rather than as a failure
        let updatedSubscription: Awaited<ReturnType<typeof getSubscriptionById>> = null;
        let refreshError: string | undefined;
        try {
          updatedSubscription = await getSubscriptionById(credentials, subscriptionId);
          if (updatedSubscription) {
            const updatedPricesResult = await getSubscriptionPrices(
              credentials,
              updatedSubscription.id
            );
            updatedSubscription.prices = updatedPricesResult.current;
            updatedSubscription.scheduledPrices = Object.keys(updatedPricesResult.scheduled).length > 0
              ? updatedPricesResult.scheduled
              : undefined;
          }
        } catch (error) {
          console.error('Error refreshing Apple subscription after update:', error);
          updatedSubscription = null;
          refreshError = getAppleErrorMessage(error, 'Could not reload prices after the update');
        }

        writer.done({
          success: failed.length === 0,
          updatedCount: outcomes.length - failed.length,
          failedCount: failed.length,
          warningCount: warnings.length,
          results: outcomes,
          subscription: updatedSubscription,
          ...(refreshError ? { refreshError } : {}),
        });
      } catch (error) {
        console.error('Error updating Apple subscription:', error);

        if (error instanceof RateLimitError) {
          writer.error(
            `Failed to update prices: ${error.successCount} of ${error.totalCount} regions succeeded before failure`,
            error.successCount,
            error.totalCount
          );
        } else {
          writer.error(getAppleErrorMessage(error, 'Failed to update subscription'));
        }
      }
    })();

    return new Response(stream, { headers: NDJSON_HEADERS });
  } catch (error) {
    console.error('Error updating Apple subscription:', error);

    return appleErrorResponse(error, 'Failed to update subscription');
  }
}

// Schema for price deletion
const deletePriceSchema = z.object({
  subscriptionPriceId: z.string().min(1, 'Subscription price ID is required'),
});

// DELETE /api/apple/subscriptions/[id] - Delete a subscription price
export async function DELETE(
  request: NextRequest,
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

    return appleErrorResponse(error, 'Failed to delete price');
  }
}
