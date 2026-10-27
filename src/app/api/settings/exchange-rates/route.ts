import { NextResponse } from 'next/server';

// GET: whether this server has its own Open Exchange Rates key. Never returns
// any part of it.
//
// A user's own key is kept in their browser (Settings), tested there against
// Open Exchange Rates directly, and sent in X-PK-OER-Key only to the routes
// that fetch rates (/api/exchange-rates, /api/ppp). Nothing is stored here.
export async function GET() {
  if (process.env.OPEN_EXCHANGE_RATES_APP_ID) {
    return NextResponse.json({ success: true, hasKey: true, configured: true, source: 'environment' });
  }
  return NextResponse.json({ success: true, hasKey: false, source: 'none' });
}
