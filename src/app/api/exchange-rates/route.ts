import { NextResponse } from 'next/server';
import {
  getExchangeRates,
  getCacheStatus,
  NoApiKeyError,
  UserKeyRateLimitedError,
} from '@/lib/exchange-rates/client';
import { hasStoreTokenHeader, readUserOerKey } from '@/middleware/auth';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';
  const statusOnly = searchParams.get('status') === 'true';

  // The user's own Open Exchange Rates key (Settings), sent by the browser in
  // X-PK-OER-Key and never stored here. It is used only on a request that
  // also carries a store token header (the app's own requests do), so
  // anonymous callers can't spend the per-isolate user-key budget. Rates
  // fetched with it go back to this caller only: getExchangeRates never puts
  // them in the memory, platform or disk caches, and limits such fetches per
  // key and per isolate. Without it the operator key is used.
  const userApiKey = hasStoreTokenHeader(request) ? readUserOerKey(request) : undefined;

  // This endpoint is public (index checker), but ?refresh=true bypasses the
  // caches. It needs a store token header that passes the shape checks: a
  // speed bump, not authentication (the token isn't verified). The real
  // limits are below: a refresh never spends the operator's Open Exchange
  // Rates key, and World Bank refreshes run at most every 10 minutes.
  if (forceRefresh && !hasStoreTokenHeader(request)) {
    return NextResponse.json(
      { success: false, error: 'Connect a store to force a refresh of exchange rates.', code: 'REFRESH_NEEDS_STORE' },
      { status: 403 }
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

    if (error instanceof UserKeyRateLimitedError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 429, headers: { 'Retry-After': '60' } });
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
