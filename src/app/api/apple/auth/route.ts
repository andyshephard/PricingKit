import { NextRequest, NextResponse } from 'next/server';
import { AppleApiError } from '@/lib/apple-connect/client';
import { rejectCrossSite } from '@/lib/request-guard';
import { AttemptLimiter } from '@/lib/utils/attempt-limiter';
import { requireAppleAuth, unauthorizedResponse } from '@/middleware/auth';
import { listAppleApps } from '../_lib/apps';

/**
 * Connect checks per instance: 300 per 10 minutes. A brake on using this
 * route to test tokens at speed, not a guarantee (state is per process).
 */
const connectChecks = new AttemptLimiter({ limit: 300, globalLimit: 300, windowMs: 10 * 60 * 1000 });

function withServerTime(response: NextResponse): NextResponse {
  response.headers.set('Date', new Date().toUTCString());
  return response;
}

// POST /api/apple/auth (App Store Connect connect check)
// The browser signs the JWT with the key it keeps and sends it as
// X-PK-Apple-Token. This lists the key's apps (a read-only call that also
// proves the token works) and returns them with the key's non-secret IDs.
// Nothing is stored and no cookie is set. Every answer carries the server
// time (Date), so the browser can correct its clock.
export async function POST(request: NextRequest) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const auth = requireAppleAuth(request, { app: 'none', long: false });
  if (!auth.ok) return auth.response;

  const decision = connectChecks.attempt(undefined);
  if (!decision.allowed) {
    return withServerTime(
      NextResponse.json(
        { error: 'Too many connection attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } }
      )
    );
  }

  try {
    const apps = await listAppleApps(auth.connection);
    if (apps.length === 0) {
      return withServerTime(
        NextResponse.json(
          { error: 'No apps found for this API key. Verify the key has at least one app assigned in App Store Connect → Users and Access.' },
          { status: 403 }
        )
      );
    }
    // The IDs come from the token's (unverified) claims; Apple accepting the
    // token is what shows they belong to a real key
    return withServerTime(NextResponse.json({ success: true, keyId: auth.claims.kid, issuerId: auth.claims.iss, apps }));
  } catch (error) {
    if (error instanceof AppleApiError) {
      if (error.statusCode === 401) {
        return unauthorizedResponse('App Store Connect refused the key. Check the Key ID, the Issuer ID and the key file.', 'INVALID_TOKEN');
      }
      if (error.statusCode === 403) {
        return withServerTime(
          NextResponse.json({ error: 'Access denied. The API key may not have sufficient permissions.' }, { status: 403 })
        );
      }
    }
    console.error('Apple connect check failed:', error instanceof Error ? error.message : 'unknown error');
    return withServerTime(NextResponse.json({ error: 'Failed to reach App Store Connect. Please try again.' }, { status: 502 }));
  }
}
