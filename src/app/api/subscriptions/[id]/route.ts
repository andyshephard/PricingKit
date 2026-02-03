import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthFromCookies } from '../../auth/route';
import { createGooglePlayClient } from '@/lib/google-play/client';
import {
  getSubscription,
  updateBasePlanPrices,
  deleteBasePlanRegionPrice,
} from '@/lib/google-play/subscriptions';
import {
  validateAndDecodeSku,
  ValidationError,
  moneySchema,
  regionCodeSchema,
  googlePlaySkuSchema,
} from '@/lib/validation';

const regionalConfigSchema = z.object({
  regionCode: regionCodeSchema,
  price: moneySchema,
  newSubscriberAvailability: z.boolean().optional(),
});

const updateBasePlanSchema = z.object({
  basePlanId: googlePlaySkuSchema,
  regionalConfigs: z.array(regionalConfigSchema),
});

const deleteRegionSchema = z.object({
  basePlanId: googlePlaySkuSchema,
  regionCode: regionCodeSchema,
});

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const auth = await getAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const params = await context.params;

    // Validate and decode product ID
    let productId: string;
    try {
      productId = validateAndDecodeSku(params.id);
    } catch (error) {
      if (error instanceof ValidationError) {
        return NextResponse.json(
          { error: error.message, details: error.details },
          { status: 400 }
        );
      }
      throw error;
    }

    const client = createGooglePlayClient(auth.credentials);
    const subscription = await getSubscription(client, auth.packageName, productId);

    if (!subscription) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ subscription });
  } catch (error: unknown) {
    console.error('Subscription get error:', error);
    const err = error as { code?: number };

    if (err.code === 404) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch subscription' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const auth = await getAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const params = await context.params;

    // Validate and decode product ID
    let productId: string;
    try {
      productId = validateAndDecodeSku(params.id);
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

    const result = updateBasePlanSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const client = createGooglePlayClient(auth.credentials);
    const updatedBasePlan = await updateBasePlanPrices(
      client,
      auth.packageName,
      productId,
      result.data.basePlanId,
      result.data.regionalConfigs
    );

    return NextResponse.json({ basePlan: updatedBasePlan });
  } catch (error: unknown) {
    console.error('Subscription update error:', error);
    const err = error as { code?: number; message?: string };

    if (err.code === 404) {
      return NextResponse.json(
        { error: 'Subscription or base plan not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: err.message || 'Failed to update subscription' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const auth = await getAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const params = await context.params;

    // Validate and decode product ID
    let productId: string;
    try {
      productId = validateAndDecodeSku(params.id);
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

    const result = deleteRegionSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const client = createGooglePlayClient(auth.credentials);
    const updatedBasePlan = await deleteBasePlanRegionPrice(
      client,
      auth.packageName,
      productId,
      result.data.basePlanId,
      result.data.regionCode
    );

    return NextResponse.json({ basePlan: updatedBasePlan });
  } catch (error: unknown) {
    console.error('Region price delete error:', error);
    const err = error as { code?: number; message?: string };

    return NextResponse.json(
      { error: err.message || 'Failed to delete region price' },
      { status: 500 }
    );
  }
}
