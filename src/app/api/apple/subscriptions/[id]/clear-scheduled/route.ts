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

    // Create deletion tasks that catch 409 STATE_ERROR as skips
    // Apple returns 409 for prices it considers no longer "future" (e.g., taking effect tomorrow)
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

    // Execute deletions with rate limiting
    const results = await executeWithRateLimit(deleteTasks, {
      concurrency: 3,
      delayBetweenBatches: 350,
      maxRetries: 5,
      retryDelay: 2000,
    });

    const deleted = results.filter(r => r.deleted);
    const skipped = results.filter(r => !r.deleted);

    // Fetch updated prices to confirm
    const updatedPricesResult = await getSubscriptionPrices(auth.credentials, subscription.id);

    return NextResponse.json({
      success: true,
      message: skipped.length > 0
        ? `Cleared ${deleted.length} scheduled price${deleted.length !== 1 ? 's' : ''}, ${skipped.length} skipped (no longer deletable)`
        : `Cleared ${deleted.length} scheduled price${deleted.length !== 1 ? 's' : ''}`,
      deletedCount: deleted.length,
      skippedCount: skipped.length,
      remainingScheduled: Object.keys(updatedPricesResult.scheduled).length,
    });
  } catch (error) {
    console.error('Error clearing scheduled prices:', error);

    // Handle rate limit errors with partial success information
    if (error instanceof RateLimitError) {
      const originalError = error.originalError;
      const statusCode = originalError instanceof AppleApiError
        ? originalError.statusCode
        : 500;

      return NextResponse.json(
        {
          error: `Failed to clear scheduled prices: ${error.successCount} of ${error.totalCount} deleted before failure`,
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
