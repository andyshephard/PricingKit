import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthFromCookies } from '../auth/route';
import { createGooglePlayClient } from '@/lib/google-play/client';
import {
  getInAppProduct,
  updateInAppProductPrices,
  calculateNewPrice,
} from '@/lib/google-play/products';
import {
  getSubscription,
  updateBasePlanPrices,
  calculateNewBasePlanPrice,
} from '@/lib/google-play/subscriptions';
import type { Money, RegionalBasePlanConfig } from '@/lib/google-play/types';

const bulkOperationSchema = z.object({
  type: z.enum(['fixed', 'percentage', 'round']),
  value: z.number().min(-99, 'Percentage cannot reduce price by more than 99%').max(10000, 'Value cannot exceed 10000').optional(),
  roundTo: z.number().min(0, 'Round-to value must be non-negative').max(0.99, 'Round-to value must be at most 0.99').optional(),
});

const bulkUpdateSchema = z.object({
  items: z.array(
    z.object({
      type: z.enum(['product', 'subscription']),
      id: z.string(),
      basePlanId: z.string().optional(),
    })
  ).min(1, 'At least one item is required').max(100, 'Maximum 100 items per bulk update'),
  operation: bulkOperationSchema,
  targetRegions: z.array(z.string()).min(1, 'At least one target region is required').max(200, 'Maximum 200 target regions per bulk update'),
  stopOnFailure: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthFromCookies();

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
    const result = bulkUpdateSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const { items, operation, targetRegions, stopOnFailure } = result.data;
    const client = createGooglePlayClient(auth.credentials);

    const results: Array<{
      id: string;
      basePlanId?: string;
      success: boolean;
      committed: boolean;
      error?: string;
      changes?: Array<{
        regionCode: string;
        oldPrice: string;
        newPrice: string;
      }>;
    }> = [];

    let stopped = false;

    for (const item of items) {
      if (stopped) {
        results.push({
          id: item.id,
          basePlanId: item.basePlanId,
          success: false,
          committed: false,
          error: 'Skipped due to earlier failure (stopOnFailure)',
        });
        continue;
      }

      try {
        if (item.type === 'product') {
          const product = await getInAppProduct(
            client,
            auth.packageName,
            item.id
          );

          if (!product) {
            results.push({
              id: item.id,
              success: false,
              committed: false,
              error: 'Product not found',
            });
            if (stopOnFailure) { stopped = true; }
            continue;
          }

          const changes: Array<{
            regionCode: string;
            oldPrice: string;
            newPrice: string;
          }> = [];
          const newPrices: Record<string, Money> = {};

          for (const regionCode of targetRegions) {
            const currentPrice = product.prices?.[regionCode];
            if (!currentPrice) continue;

            const newPrice = calculateNewPrice(currentPrice, operation);
            newPrices[regionCode] = newPrice;

            const oldAmount =
              parseFloat(currentPrice.units) +
              (currentPrice.nanos ? currentPrice.nanos / 1_000_000_000 : 0);
            const newAmount =
              parseFloat(newPrice.units) +
              (newPrice.nanos ? newPrice.nanos / 1_000_000_000 : 0);

            changes.push({
              regionCode,
              oldPrice: `${currentPrice.currencyCode} ${oldAmount.toFixed(2)}`,
              newPrice: `${newPrice.currencyCode} ${newAmount.toFixed(2)}`,
            });
          }

          if (Object.keys(newPrices).length > 0) {
            await updateInAppProductPrices(
              client,
              auth.packageName,
              item.id,
              newPrices
            );
          }

          results.push({
            id: item.id,
            success: true,
            committed: true,
            changes,
          });
        } else if (item.type === 'subscription' && item.basePlanId) {
          const subscription = await getSubscription(
            client,
            auth.packageName,
            item.id
          );

          if (!subscription) {
            results.push({
              id: item.id,
              basePlanId: item.basePlanId,
              success: false,
              committed: false,
              error: 'Subscription not found',
            });
            if (stopOnFailure) { stopped = true; }
            continue;
          }

          const basePlan = subscription.basePlans?.find(
            (bp) => bp.basePlanId === item.basePlanId
          );

          if (!basePlan) {
            results.push({
              id: item.id,
              basePlanId: item.basePlanId,
              success: false,
              committed: false,
              error: 'Base plan not found',
            });
            if (stopOnFailure) { stopped = true; }
            continue;
          }

          const changes: Array<{
            regionCode: string;
            oldPrice: string;
            newPrice: string;
          }> = [];
          const newConfigs: RegionalBasePlanConfig[] = [];

          for (const regionCode of targetRegions) {
            const currentConfig = basePlan.regionalConfigs?.find(
              (rc) => rc.regionCode === regionCode
            );
            if (!currentConfig) continue;

            const newConfig = calculateNewBasePlanPrice(currentConfig, operation);
            newConfigs.push(newConfig);

            const oldAmount =
              parseFloat(currentConfig.price.units) +
              (currentConfig.price.nanos
                ? currentConfig.price.nanos / 1_000_000_000
                : 0);
            const newAmount =
              parseFloat(newConfig.price.units) +
              (newConfig.price.nanos
                ? newConfig.price.nanos / 1_000_000_000
                : 0);

            changes.push({
              regionCode,
              oldPrice: `${currentConfig.price.currencyCode} ${oldAmount.toFixed(2)}`,
              newPrice: `${newConfig.price.currencyCode} ${newAmount.toFixed(2)}`,
            });
          }

          if (newConfigs.length > 0) {
            await updateBasePlanPrices(
              client,
              auth.packageName,
              item.id,
              item.basePlanId,
              newConfigs
            );
          }

          results.push({
            id: item.id,
            basePlanId: item.basePlanId,
            success: true,
            committed: true,
            changes,
          });
        }
      } catch (error) {
        results.push({
          id: item.id,
          basePlanId: item.basePlanId,
          success: false,
          committed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        if (stopOnFailure) { stopped = true; }
      }
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const committed = results.filter((r) => r.committed).length;
    const skipped = results.filter((r) => !r.success && r.error?.includes('Skipped')).length;

    return NextResponse.json({
      success: failed === 0,
      total: items.length,
      successful,
      failed,
      committed,
      ...(stopped ? { stoppedEarly: true, skipped } : {}),
      results,
    });
  } catch (error) {
    console.error('Bulk update error:', error);
    return NextResponse.json(
      { error: 'Failed to perform bulk update' },
      { status: 500 }
    );
  }
}
