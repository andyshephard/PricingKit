import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAppleAuth } from '@/middleware/auth';
import {
  getSubscriptionPricePoints,
} from '@/lib/apple-connect';
import { appleErrorResponse, getAppleErrorMessage } from '../../../../_lib/error-response';
import { alpha2ToAlpha3 } from '@/lib/apple-connect/territories';
import { assertSubscriptionInApp } from '@/lib/apple-connect/ownership';
import { appleInternalIdSchema, regionCodeSchema } from '@/lib/validation';
import { executeWithRateLimit, RateLimitError } from '@/lib/utils/rate-limit';
import { getErrorStatus } from '@/lib/utils/api-error';
import { createNdjsonStream, NDJSON_HEADERS } from '@/lib/utils/ndjson-stream';
import { isBudgetExceeded, RequestBudget } from '@/lib/utils/request-budget';
import { rejectCrossSite, readJsonBody, LARGE_BODY_LIMIT } from '@/lib/request-guard';

const batchSchema = z.object({
  territories: z.record(
    regionCodeSchema,
    z.object({
      targetPrice: z.number().positive(),
      currency: z.string().min(1),
    })
  ),
});

// POST /api/apple/subscriptions/[id]/price-points/batch
// Resolves the closest Apple price point for each territory server-side
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const auth = requireAppleAuth(request);
    if (!auth.ok) return auth.response;
    const { connection } = auth;

    const { id } = await params;
    // Only a numeric subscription ID reaches the App Store Connect path
    if (!appleInternalIdSchema.safeParse(id).success) {
      return NextResponse.json({ error: 'Use the numeric App Store Connect subscription ID' }, { status: 400 });
    }

    const read = await readJsonBody(request, LARGE_BODY_LIMIT);
    if (!read.ok) return read.response;
    const body = read.body;

    const result = batchSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const { territories } = result.data;
    const entries = Object.entries(territories);

    if (entries.length === 0) {
      return NextResponse.json(
        { error: 'No territories provided' },
        { status: 400 }
      );
    }

    const { stream, writer } = createNdjsonStream();

    const subscriptionId = id;
    // One budget for the whole run (Apple allows ~3600 requests/hour per key)
    const ctx = { budget: new RequestBudget() };
    // API keys reach every app of a team: refuse another app's subscription
    await assertSubscriptionInApp(connection, subscriptionId, ctx);

    (async () => {
      try {
        const resolved: Record<string, { pricePointId: string; tierPrice: number }> = {};
        const skipped: string[] = [];
        // Why each skipped territory couldn't be resolved
        const skippedReasons: Record<string, string> = {};

        const skip = (territoryCode: string, reason: string) => {
          skipped.push(territoryCode);
          skippedReasons[territoryCode] = reason;
        };

        // Build tasks — one per territory. A failed lookup skips that territory
        // with its reason; auth failures abort the whole run.
        const tasks = entries.map(
          ([territoryCode, { targetPrice, currency }]) =>
            async () => {
              const alpha3 = alpha2ToAlpha3(territoryCode) || territoryCode;

              try {
                const pricePoints = await getSubscriptionPricePoints(
                  connection,
                  subscriptionId,
                  alpha3,
                  ctx
                );
                return { territoryCode, targetPrice, currency, pricePoints, error: undefined };
              } catch (error) {
                const status = getErrorStatus(error);
                // Auth failures and a spent budget abort the run instead of skipping every territory
                if (status === 401 || status === 403 || isBudgetExceeded(error)) throw error;
                return {
                  territoryCode,
                  targetPrice,
                  currency,
                  pricePoints: [],
                  error: getAppleErrorMessage(error, 'Failed to fetch price points'),
                };
              }
            }
        );

        const results = await executeWithRateLimit(tasks, {
          concurrency: 3,
          delayBetweenBatches: 300,
          maxRetries: 3,
          retryDelay: 2000,
          onProgress: (completed, total) =>
            writer.progress(completed, total, 'resolve'),
        });

        // Find the closest price point for each territory
        for (const { territoryCode, targetPrice, currency, pricePoints, error } of results) {
          if (error) {
            skip(territoryCode, error);
            continue;
          }
          if (!pricePoints || pricePoints.length === 0) {
            skip(territoryCode, `No Apple price points available for ${territoryCode} (${currency})`);
            continue;
          }

          const closest = pricePoints.reduce((best, pp) => {
            const ppPrice = parseFloat(pp.customerPrice);
            const bestPrice = parseFloat(best.customerPrice);
            return Math.abs(ppPrice - targetPrice) < Math.abs(bestPrice - targetPrice)
              ? pp
              : best;
          });

          resolved[territoryCode] = {
            pricePointId: closest.id,
            tierPrice: parseFloat(closest.customerPrice),
          };
        }

        writer.done({ resolved, skipped, skippedReasons });
      } catch (error) {
        console.error('Error resolving subscription price points:', error);

        if (error instanceof RateLimitError) {
          writer.error(
            `Failed to resolve price points: ${error.successCount} of ${error.totalCount} territories succeeded before failure`,
            error.successCount,
            error.totalCount
          );
        } else {
          writer.error(getAppleErrorMessage(error, 'Failed to resolve price points'));
        }
      }
    })();

    return new Response(stream, { headers: NDJSON_HEADERS });
  } catch (error) {
    console.error('Error in batch price points:', error);

    return appleErrorResponse(error, 'Failed to resolve price points');
  }
}
