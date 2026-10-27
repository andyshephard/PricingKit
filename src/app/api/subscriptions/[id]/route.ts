import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getGoogleAuthFromCookies } from '@/middleware/auth';
import { GoogleKeyTokenSource } from '@/lib/key-token-source';
import {
  getSubscription,
  updateBasePlanPrices,
  deleteBasePlanRegionPrice,
} from '@/lib/google-play/subscriptions';
import { GOOGLE_PRICING_WRITE_DENIED_ERROR } from '@/lib/google-play/errors';
import {
  validateAndDecodeSku,
  ValidationError,
  moneySchema,
  regionCodeSchema,
  googlePlayBasePlanIdSchema,
} from '@/lib/validation';
import { rejectCrossSite, readJsonBody, LARGE_BODY_LIMIT } from '@/lib/request-guard';

const regionalConfigSchema = z.object({
  regionCode: regionCodeSchema,
  price: moneySchema,
  newSubscriberAvailability: z.boolean().optional(),
});

const updateBasePlanSchema = z.object({
  basePlanId: googlePlayBasePlanIdSchema,
  regionalConfigs: z.array(regionalConfigSchema),
});

const deleteRegionSchema = z.object({
  basePlanId: googlePlayBasePlanIdSchema,
  regionCode: regionCodeSchema,
});

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const auth = await getGoogleAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }
    const tokens = new GoogleKeyTokenSource(auth.credentials);

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

    const subscription = await getSubscription(tokens, auth.packageName, productId);

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
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const auth = await getGoogleAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }
    const tokens = new GoogleKeyTokenSource(auth.credentials);

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

    const read = await readJsonBody(request, LARGE_BODY_LIMIT);
    if (!read.ok) return read.response;
    const body = read.body;

    const result = updateBasePlanSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const updatedBasePlan = await updateBasePlanPrices(
      tokens,
      auth.packageName,
      productId,
      result.data.basePlanId,
      result.data.regionalConfigs
    );

    return NextResponse.json({ basePlan: updatedBasePlan });
  } catch (error: unknown) {
    console.error('Subscription update error:', error);
    const err = error as { code?: number; message?: string };

    if (err.code === 403) {
      return NextResponse.json(GOOGLE_PRICING_WRITE_DENIED_ERROR, { status: 403 });
    }
    if (err.code === 404) {
      return NextResponse.json(
        { error: 'Subscription or base plan not found' },
        { status: 404 }
      );
    }

    // Google rejected the change (e.g. a region it requires, or one with
    // existing subscribers). Pass its reason through rather than a generic 500.
    if (err.code === 400 || err.code === 409 || err.code === 412) {
      return NextResponse.json(
        { error: err.message || 'Failed to update subscription' },
        { status: err.code }
      );
    }

    // Unexpected failures: the details are logged above, not sent to the client
    return NextResponse.json(
      { error: 'Failed to update subscription' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteParams
) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const auth = await getGoogleAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }
    const tokens = new GoogleKeyTokenSource(auth.credentials);

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

    const read = await readJsonBody(request, LARGE_BODY_LIMIT);
    if (!read.ok) return read.response;
    const body = read.body;

    const result = deleteRegionSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const updatedBasePlan = await deleteBasePlanRegionPrice(
      tokens,
      auth.packageName,
      productId,
      result.data.basePlanId,
      result.data.regionCode
    );

    return NextResponse.json({ basePlan: updatedBasePlan });
  } catch (error: unknown) {
    console.error('Region price delete error:', error);
    const err = error as { code?: number; message?: string };

    if (err.code === 401) {
      return NextResponse.json(
        { error: 'Authentication expired. Please reconnect.' },
        { status: 401 }
      );
    }
    if (err.code === 403) {
      return NextResponse.json(GOOGLE_PRICING_WRITE_DENIED_ERROR, { status: 403 });
    }
    if (err.code === 404) {
      return NextResponse.json(
        { error: 'Subscription or region not found' },
        { status: 404 }
      );
    }

    // Google rejected the change (e.g. a region it requires, or one with
    // existing subscribers). Pass its reason through rather than a generic 500.
    if (err.code === 400 || err.code === 409 || err.code === 412) {
      return NextResponse.json(
        { error: err.message || 'Failed to delete region price' },
        { status: err.code }
      );
    }

    // Unexpected failures: the details are logged above, not sent to the client
    return NextResponse.json(
      { error: 'Failed to delete region price' },
      { status: 500 }
    );
  }
}
