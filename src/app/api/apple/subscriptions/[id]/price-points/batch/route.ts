import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '../../../../auth/route';
import {
  getSubscriptionPricePoints,
  AppleApiError,
} from '@/lib/apple-connect';
import { alpha2ToAlpha3 } from '@/lib/apple-connect/territories';
import { executeWithRateLimit, RateLimitError } from '@/lib/utils/rate-limit';
import { createNdjsonStream, NDJSON_HEADERS } from '@/lib/utils/ndjson-stream';

const batchSchema = z.object({
  territories: z.record(
    z.string(),
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

    const credentials = auth.credentials;
    const subscriptionId = id;

    (async () => {
      try {
        const resolved: Record<string, { pricePointId: string; tierPrice: number }> = {};
        const skipped: string[] = [];

        // Build tasks — one per territory
        const tasks = entries.map(
          ([territoryCode, { targetPrice, currency }]) =>
            async () => {
              const alpha3 = alpha2ToAlpha3(territoryCode) || territoryCode;

              const pricePoints = await getSubscriptionPricePoints(
                credentials,
                subscriptionId,
                alpha3
              );

              return { territoryCode, targetPrice, currency, pricePoints };
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
        for (const { territoryCode, targetPrice, pricePoints } of results) {
          if (!pricePoints || pricePoints.length === 0) {
            skipped.push(territoryCode);
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

        writer.done({ resolved, skipped });
      } catch (error) {
        console.error('Error resolving subscription price points:', error);

        if (error instanceof RateLimitError) {
          writer.error(
            `Failed to resolve price points: ${error.successCount} of ${error.totalCount} territories succeeded before failure`,
            error.successCount,
            error.totalCount
          );
        } else if (error instanceof AppleApiError) {
          writer.error(error.detail || 'Failed to resolve price points');
        } else {
          writer.error('Failed to resolve price points');
        }
      }
    })();

    return new Response(stream, { headers: NDJSON_HEADERS });
  } catch (error) {
    console.error('Error in batch price points:', error);

    if (error instanceof AppleApiError) {
      return NextResponse.json(
        { error: error.detail || 'Failed to resolve price points' },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      { error: 'Failed to resolve price points' },
      { status: 500 }
    );
  }
}
