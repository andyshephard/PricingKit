import { NextResponse } from 'next/server';
import { ApiError } from '@/lib/utils/api-error';
import { AppleApiError } from '@/lib/apple-connect';
import { storeRefusedTokenResponse } from '@/middleware/auth';

/**
 * User-facing message for an error thrown by the Apple client.
 * AppleApiError carries Apple's `detail`; other ApiErrors (network, timeout,
 * validation) carry their own message. Anything else gets the fallback so
 * internal error text isn't leaked.
 */
export function getAppleErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AppleApiError) return error.detail || fallback;
  if (error instanceof ApiError && error.code !== 'UNKNOWN_ERROR') {
    return error.message || fallback;
  }
  return fallback;
}

/**
 * Map an error to a JSON response with the upstream status
 * (401/403/404/409/429/5xx) instead of a blanket 404 or 500.
 */
export function appleErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      // Apple refused the token (STORE_REFUSED_TOKEN): the browser retries a
      // read once with a new token, never a write. Apple's own code isn't
      // forwarded, so it can't pass for a precheck code.
      return storeRefusedTokenResponse('App Store Connect refused the access token. Connect again if this keeps happening.');
    }
    if (error.status === 403) {
      return NextResponse.json(
        { error: 'Access denied. The API key may not have sufficient permissions.', code: error.code },
        { status: 403 }
      );
    }
    return NextResponse.json(
      {
        error: getAppleErrorMessage(error, fallback),
        code: error.code,
        retryable: error.retryable,
      },
      { status: error.status }
    );
  }

  return NextResponse.json({ error: fallback }, { status: 500 });
}
