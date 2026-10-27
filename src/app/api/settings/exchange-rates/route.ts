import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { hasAuthenticatedSession } from '@/lib/session';
import { AttemptLimiter, trustedClientIp } from '@/lib/utils/attempt-limiter';

const COOKIE_NAME = 'exchange_rates_api_key';

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
  const savedKey = cookieStore.get(COOKIE_NAME)?.value;

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
  try {
    const { apiKey } = await request.json();

    if (!apiKey || typeof apiKey !== 'string') {
      return NextResponse.json(
        { success: false, error: 'API key is required' },
        { status: 400 }
      );
    }

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

    // Validate the API key by making a test request
    const testUrl = `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(apiKey)}`;
    const testResponse = await fetch(testUrl);

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
    cookieStore.set(COOKIE_NAME, apiKey, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 365, // 1 year
      path: '/',
    });

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
export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);

  return NextResponse.json({
    success: true,
    message: 'API key removed',
  });
}
