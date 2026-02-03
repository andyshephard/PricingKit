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
  value: z.number().optional(),
  roundTo: z.number().optional(),
});

const bulkUpdateSchema = z.object({
  items: z.array(
    z.object({
      type: z.enum(['product', 'subscription']),
      id: z.string(),
      basePlanId: z.string().optional(),
    })
  ),
  operation: bulkOperationSchema,
  targetRegions: z.array(z.string()),
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

    const body = await request.json();
    const result = bulkUpdateSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const { items, operation, targetRegions } = result.data;
    const client = createGooglePlayClient(auth.credentials);

    const results: Array<{
      id: string;
      basePlanId?: string;
      success: boolean;
      error?: string;
      changes?: Array<{
        regionCode: string;
        oldPrice: string;
        newPrice: string;
      }>;
    }> = [];

    for (const item of items) {
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
              error: 'Product not found',
            });
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
              error: 'Subscription not found',
            });
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
              error: 'Base plan not found',
            });
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
            changes,
          });
        }
      } catch (error) {
        results.push({
          id: item.id,
          basePlanId: item.basePlanId,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return NextResponse.json({
      success: failed === 0,
      total: items.length,
      successful,
      failed,
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
