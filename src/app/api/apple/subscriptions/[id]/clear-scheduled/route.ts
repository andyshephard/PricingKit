import { NextRequest, NextResponse } from 'next/server';
import { getAppleAuthFromCookies } from '../../../auth/route';
import {
  getSubscription,
  getSubscriptionById,
  getSubscriptionPrices,
  deleteSubscriptionPrice,
  AppleApiError,
} from '@/lib/apple-connect';
import { executeWithRateLimit, RateLimitError } from '@/lib/utils/rate-limit';
import { createNdjsonStream, NDJSON_HEADERS } from '@/lib/utils/ndjson-stream';
import {
  validateAndDecodeAppleProductId,
  ValidationError,
} from '@/lib/validation';

// Check if the ID is a numeric Apple subscription ID (e.g., "6746950587")
function isNumericSubscriptionId(id: string): boolean {
  return /^\d+$/.test(id);
}

// POST /api/apple/subscriptions/[id]/clear-scheduled - Clear all scheduled (future) prices
export async function POST(
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

    // Fetch current prices to get scheduled prices
    const currentPricesResult = await getSubscriptionPrices(auth.credentials, subscription.id);
    const scheduledPrices = currentPricesResult.scheduled;

    // Check if there are any scheduled prices to delete
    const scheduledPriceEntries = Object.entries(scheduledPrices).filter(
      ([, price]) => price.subscriptionPriceId
    );

    if (scheduledPriceEntries.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No scheduled prices to clear',
        deletedCount: 0,
      });
    }

    // Stream progress back to the client
    const { stream, writer } = createNdjsonStream();

    // Create deletion tasks that catch 409 STATE_ERROR as skips
    const deleteTasks = scheduledPriceEntries.map(
      ([territory, price]) =>
        async () => {
          try {
            await deleteSubscriptionPrice(auth.credentials, price.subscriptionPriceId!);
            return { territory, deleted: true as const };
          } catch (error) {
            if (error instanceof AppleApiError && error.statusCode === 409) {
              return { territory, deleted: false as const, reason: error.detail };
            }
            throw error;
          }
        }
    );

    // Kick off async work — the stream is returned immediately
    const credentials = auth.credentials;
    const subscriptionId = subscription.id;

    (async () => {
      try {
        const results = await executeWithRateLimit(deleteTasks, {
          concurrency: 2,
          delayBetweenBatches: 500,
          maxRetries: 5,
          retryDelay: 2000,
          onProgress: (completed, total) => writer.progress(completed, total),
        });

        const deleted = results.filter(r => r.deleted);
        const skipped = results.filter(r => !r.deleted);

        // Fetch updated prices to confirm
        const updatedPricesResult = await getSubscriptionPrices(credentials, subscriptionId);

        const message = skipped.length > 0
          ? `Cleared ${deleted.length} scheduled price${deleted.length !== 1 ? 's' : ''}, ${skipped.length} skipped (no longer deletable)`
          : `Cleared ${deleted.length} scheduled price${deleted.length !== 1 ? 's' : ''}`;

        writer.done({
          success: true,
          message,
          deletedCount: deleted.length,
          skippedCount: skipped.length,
          remainingScheduled: Object.keys(updatedPricesResult.scheduled).length,
        });
      } catch (error) {
        console.error('Error clearing scheduled prices:', error);

        if (error instanceof RateLimitError) {
          writer.error(
            `Failed to clear scheduled prices: ${error.successCount} of ${error.totalCount} deleted before failure`,
            error.successCount,
            error.totalCount
          );
        } else if (error instanceof AppleApiError) {
          writer.error(error.detail || 'Failed to clear scheduled prices');
        } else {
          writer.error('Failed to clear scheduled prices');
        }
      }
    })();

    return new Response(stream, { headers: NDJSON_HEADERS });
  } catch (error) {
    console.error('Error clearing scheduled prices:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to clear scheduled prices' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to clear scheduled prices' },
      { status: 500 }
    );
  }
}
