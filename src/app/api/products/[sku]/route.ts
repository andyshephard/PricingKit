import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getGoogleAuthFromCookies } from '@/middleware/auth';
import { GoogleKeyTokenSource } from '@/lib/token-source';
import { getInAppProduct, updateInAppProductPrices, deleteRegionPrice } from '@/lib/google-play/products';
import { GOOGLE_PRICING_WRITE_DENIED_ERROR } from '@/lib/google-play/errors';
import {
  validateAndDecodeSku,
  ValidationError,
  moneySchema,
  regionCodeSchema,
} from '@/lib/validation';
import { rejectCrossSite, readJsonBody, LARGE_BODY_LIMIT } from '@/lib/request-guard';

const updatePricesSchema = z.object({
  prices: z.record(regionCodeSchema, moneySchema),
  defaultPrice: moneySchema.optional(),
});

const deleteRegionSchema = z.object({
  regionCode: regionCodeSchema,
});

type RouteParams = { params: Promise<{ sku: string }> };

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

    // Validate and decode SKU
    let sku: string;
    try {
      sku = validateAndDecodeSku(params.sku);
    } catch (error) {
      if (error instanceof ValidationError) {
        return NextResponse.json(
          { error: error.message, details: error.details },
          { status: 400 }
        );
      }
      throw error;
    }

    const product = await getInAppProduct(tokens, auth.packageName, sku);

    if (!product) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ product });
  } catch (error: unknown) {
    console.error('Product get error:', error);
    const err = error as { code?: number };

    if (err.code === 404) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch product' },
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

    // Validate and decode SKU
    let sku: string;
    try {
      sku = validateAndDecodeSku(params.sku);
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

    const result = updatePricesSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const updatedProduct = await updateInAppProductPrices(
      tokens,
      auth.packageName,
      sku,
      result.data.prices,
      result.data.defaultPrice
    );

    return NextResponse.json({ product: updatedProduct });
  } catch (error: unknown) {
    console.error('Product update error:', error);
    const err = error as { code?: number; message?: string };

    if (err.code === 403) {
      return NextResponse.json(GOOGLE_PRICING_WRITE_DENIED_ERROR, { status: 403 });
    }
    if (err.code === 404) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      );
    }

    // Unexpected failures: the details are logged above, not sent to the client
    return NextResponse.json(
      { error: 'Failed to update product' },
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

    // Validate and decode SKU
    let sku: string;
    try {
      sku = validateAndDecodeSku(params.sku);
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

    const updatedProduct = await deleteRegionPrice(
      tokens,
      auth.packageName,
      sku,
      result.data.regionCode
    );

    return NextResponse.json({ product: updatedProduct });
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
        { error: 'Product or region not found' },
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
