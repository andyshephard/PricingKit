import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthFromCookies } from '../../auth/route';
import { createGooglePlayClient } from '@/lib/google-play/client';
import { getInAppProduct, updateInAppProductPrices, deleteRegionPrice } from '@/lib/google-play/products';
import {
  validateAndDecodeSku,
  ValidationError,
  moneySchema,
  regionCodeSchema,
} from '@/lib/validation';

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
    const auth = await getAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

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

    const client = createGooglePlayClient(auth.credentials);
    const product = await getInAppProduct(client, auth.packageName, sku);

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
  try {
    const auth = await getAuthFromCookies();

    if (!auth) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

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

    const body = await request.json();

    const result = updatePricesSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const client = createGooglePlayClient(auth.credentials);
    const updatedProduct = await updateInAppProductPrices(
      client,
      auth.packageName,
      sku,
      result.data.prices,
      result.data.defaultPrice
    );

    return NextResponse.json({ product: updatedProduct });
  } catch (error: unknown) {
    console.error('Product update error:', error);
    const err = error as { code?: number; message?: string };

    if (err.code === 404) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: err.message || 'Failed to update product' },
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

    const body = await request.json();

    const result = deleteRegionSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: result.error.issues },
        { status: 400 }
      );
    }

    const client = createGooglePlayClient(auth.credentials);
    const updatedProduct = await deleteRegionPrice(
      client,
      auth.packageName,
      sku,
      result.data.regionCode
    );

    return NextResponse.json({ product: updatedProduct });
  } catch (error: unknown) {
    console.error('Region price delete error:', error);
    const err = error as { code?: number; message?: string };

    return NextResponse.json(
      { error: err.message || 'Failed to delete region price' },
      { status: 500 }
    );
  }
}
