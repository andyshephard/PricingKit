import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import { appleKeyConnection } from '@/lib/key-token-source';
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
import { RequestBudget } from '@/lib/utils/request-budget';
import { assertSubscriptionInApp } from '@/lib/apple-connect/ownership';
import { listSubscriptionPriceEntries } from '@/lib/apple-connect/price-points';
import { rejectCrossSite, readJsonBody, LARGE_BODY_LIMIT } from '@/lib/request-guard';

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
    const connection = appleKeyConnection(auth.credentials);

    const { id } = await params;

    let subscription;

    if (isNumericSubscriptionId(id)) {
      // API keys reach every app of a team: refuse another app's subscription
      await assertSubscriptionInApp(connection, id);
      // Fetch directly by Apple subscription ID
      subscription = await getSubscriptionById(connection, id);
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
      subscription = await getSubscription(connection, productId);
    }

    if (!subscription) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    // Fetch prices for this subscription
    const pricesResult = await getSubscriptionPrices(connection, subscription.id);
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
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }
    const connection = appleKeyConnection(auth.credentials);

    const { id } = await params;
    // One budget for the whole run: reads, creates and deletes (Apple allows ~3600/hour per key)
    const budget = new RequestBudget();
    const ctx = { budget };

    const read = await readJsonBody(request, LARGE_BODY_LIMIT);
    if (!read.ok) return read.response;
    const body = read.body;
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
      subscription = await getSubscriptionById(connection, id, ctx);
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
      subscription = await getSubscription(connection, productId, ctx);
    }

    if (!subscription) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    // API keys reach every app of a team: refuse another app's subscription
    await assertSubscriptionInApp(connection, subscription.id, ctx);

    const { prices, preserveCurrentPrice } = result.data;

    // Fetch current scheduled prices: Apple only allows one scheduled (future)
    // price per territory, so a future-dated change replaces the existing one
    const currentPricesResult = await getSubscriptionPrices(connection, subscription.id, ctx);
    const scheduledPrices = currentPricesResult.scheduled;

    // Stream progress back to the client
    const { stream, writer } = createNdjsonStream();
    const subscriptionId = subscription.id;

    (async () => {
      try {
        // Creates first, deletes only after the replacement exists; a failed create deletes nothing
        const outcomes = await applySubscriptionPriceChanges(
          connection,
          subscriptionId,
          prices,
          scheduledPrices,
          {
            preserveCurrentPrice,
            budget,
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
          updatedSubscription = await getSubscriptionById(connection, subscriptionId, ctx);
          if (updatedSubscription) {
            const updatedPricesResult = await getSubscriptionPrices(
              connection,
              updatedSubscription.id,
              ctx
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
  { params }: { params: Promise<{ id: string }> }
) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }
    const connection = appleKeyConnection(auth.credentials);

    const read = await readJsonBody(request, LARGE_BODY_LIMIT);
    if (!read.ok) return read.response;
    const body = read.body;
    const result = deletePriceSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    // The price must belong to this subscription, and the subscription to the
    // session's app: API keys reach every app of a team
    const { id } = await params;
    const ctx = { budget: new RequestBudget() };
    let subscription;
    if (isNumericSubscriptionId(id)) {
      subscription = await getSubscriptionById(connection, id, ctx);
    } else {
      let productId: string;
      try {
        productId = validateAndDecodeAppleProductId(id);
      } catch (error) {
        if (error instanceof ValidationError) {
          return NextResponse.json({ error: error.message, details: error.details }, { status: 400 });
        }
        throw error;
      }
      subscription = await getSubscription(connection, productId, ctx);
    }
    if (!subscription) {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });
    }
    await assertSubscriptionInApp(connection, subscription.id, ctx);
    const entries = await listSubscriptionPriceEntries(connection, subscription.id, ctx);
    if (!entries.some((e) => e.subscriptionPriceId === result.data.subscriptionPriceId)) {
      return NextResponse.json({ error: 'That price is not one of this subscription\'s prices' }, { status: 404 });
    }

    await deleteSubscriptionPrice(connection, result.data.subscriptionPriceId, ctx);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting Apple subscription price:', error);

    return appleErrorResponse(error, 'Failed to delete price');
  }
}
