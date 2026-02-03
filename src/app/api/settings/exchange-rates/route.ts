import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const COOKIE_NAME = 'exchange_rates_api_key';

// GET: Return the current API key (from cookie or env)
export async function GET() {
  const cookieStore = await cookies();
  const savedKey = cookieStore.get(COOKIE_NAME)?.value;

  // Use saved key from cookie, or fall back to environment variable
  const apiKey = savedKey || process.env.OPEN_EXCHANGE_RATES_APP_ID || '';

  return NextResponse.json({
    success: true,
    apiKey: apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : '', // Masked for display
    hasKey: !!apiKey,
    source: savedKey ? 'user' : (process.env.OPEN_EXCHANGE_RATES_APP_ID ? 'environment' : 'none'),
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

    // Validate the API key by making a test request
    const testUrl = `https://openexchangerates.org/api/latest.json?app_id=${apiKey}`;
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
    const cookieStore = await cookies();
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
