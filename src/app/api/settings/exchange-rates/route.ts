import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { clearCookie, COOKIE_NAMES, EXCHANGE_RATES_KEY_MAX_AGE, hasAuthenticatedSession, readCookie, writeCookie } from '@/lib/session';
import { AttemptLimiter, trustedClientIp } from '@/lib/utils/attempt-limiter';
import { readJsonBody, rejectCrossSite, SMALL_BODY_LIMIT } from '@/lib/request-guard';

// Without a store session, testing a key is limited so this endpoint can't be
// used as a free Open Exchange Rates proxy: 50 tests per instance per 10
// minutes, and 5 per client when the client IP comes from a proxy header the
// operator trusts (TRUSTED_CLIENT_IP_HEADER; see trustedClientIp). Signed-in
// users are not limited here. Caveat: under `next dev` sessions may be
// plaintext cookies, so anyone can forge one and skip this limit; outside
// `next dev` a session cookie must decrypt with ENCRYPTION_KEY.
const anonymousKeyTests = new AttemptLimiter({ limit: 5, globalLimit: 50, windowMs: 10 * 60 * 1000 });

// GET: Report whether a key is configured. Never returns any part of the
// operator's environment key; a user-saved key is shown by its last 4 chars only.
export async function GET() {
  const cookieStore = await cookies();
  const savedKey = readCookie(cookieStore, COOKIE_NAMES.exchangeRatesKey)?.value;

  if (savedKey) {
    return NextResponse.json({
      success: true,
      hasKey: true,
      apiKey: `••••${savedKey.slice(-4)}`,
      source: 'user',
    });
  }

  if (process.env.OPEN_EXCHANGE_RATES_APP_ID) {
    return NextResponse.json({
      success: true,
      hasKey: true,
      configured: true,
      source: 'environment',
    });
  }

  return NextResponse.json({
    success: true,
    hasKey: false,
    source: 'none',
  });
}

// POST: Save a new API key
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    // The anonymous limit is checked before the body is read or parsed
    const cookieStore = await cookies();
    if (!(await hasAuthenticatedSession(cookieStore))) {
      const decision = anonymousKeyTests.attempt(
        trustedClientIp(request.headers, process.env.TRUSTED_CLIENT_IP_HEADER)
      );
      if (!decision.allowed) {
        return NextResponse.json(
          { success: false, error: 'Too many key tests. Try again later, or sign in first.' },
          { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } }
        );
      }
    }

    const read = await readJsonBody(request, SMALL_BODY_LIMIT);
    if (!read.ok) return read.response;
    const apiKey = (read.body as { apiKey?: unknown } | null)?.apiKey;

    if (!apiKey || typeof apiKey !== 'string') {
      return NextResponse.json(
        { success: false, error: 'API key is required' },
        { status: 400 }
      );
    }
    // Open Exchange Rates app IDs are 32 hexadecimal characters
    if (!/^[A-Za-z0-9]{8,64}$/.test(apiKey)) {
      return NextResponse.json({ success: false, error: 'That is not an Open Exchange Rates app ID' }, { status: 400 });
    }

    // Validate the API key by making a test request
    const testUrl = `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(apiKey)}`;
    const testResponse = await fetch(testUrl, { signal: AbortSignal.timeout(10_000) });

    if (!testResponse.ok) {
      const errorData = await testResponse.json().catch(() => ({}));
      return NextResponse.json(
        {
          success: false,
          error: errorData.description || 'Invalid API key'
        },
        { status: 400 }
      );
    }

    // Save the API key in a cookie (httpOnly for security)
    writeCookie(cookieStore, COOKIE_NAMES.exchangeRatesKey, apiKey, EXCHANGE_RATES_KEY_MAX_AGE);

    return NextResponse.json({
      success: true,
      message: 'API key saved successfully',
    });
  } catch (error) {
    console.error('Failed to save API key:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to save API key' },
      { status: 500 }
    );
  }
}

// DELETE: Remove the saved API key
export async function DELETE(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const cookieStore = await cookies();
  clearCookie(cookieStore, COOKIE_NAMES.exchangeRatesKey);

  return NextResponse.json({
    success: true,
    message: 'API key removed',
  });
}
