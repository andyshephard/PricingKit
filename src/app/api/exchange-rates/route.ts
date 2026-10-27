import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  getExchangeRates,
  getCacheStatus,
  NoApiKeyError,
} from '@/lib/exchange-rates/client';
import { hasAuthenticatedSession } from '@/lib/session';

const API_KEY_COOKIE = 'exchange_rates_api_key';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';
  const statusOnly = searchParams.get('status') === 'true';

  // Get API key from cookie (user-provided) or fall back to env var
  const cookieStore = await cookies();
  const userApiKey = cookieStore.get(API_KEY_COOKIE)?.value;

  // This endpoint is public (index checker), but ?refresh=true bypasses the cache
  // and spends upstream API quota, so it requires a signed-in Google or Apple session.
  if (forceRefresh && !(await hasAuthenticatedSession(cookieStore))) {
    return NextResponse.json(
      { success: false, error: 'Sign in to force a refresh of exchange rates.' },
      { status: 401 }
    );
  }

  try {
    // Just return status if requested
    if (statusOnly) {
      const status = await getCacheStatus();
      return NextResponse.json({
        success: true,
        status,
      });
    }

    const data = await getExchangeRates(forceRefresh, userApiKey);

    return NextResponse.json({
      success: true,
      data: {
        base: data.base,
        rates: data.rates,
        timestamp: data.timestamp,
        fetchedAt: data.fetchedAt,
      },
      metadata: {
        currencyCount: Object.keys(data.rates).length,
        cacheAge: Date.now() - new Date(data.fetchedAt).getTime(),
      },
    });
  } catch (error) {
    if (error instanceof NoApiKeyError) {
      return NextResponse.json({
        success: false,
        noApiKey: true,
        error: error.message,
      });
    }

    console.error('Exchange rates API error:', error);

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch exchange rates',
      },
      { status: 500 }
    );
  }
}
