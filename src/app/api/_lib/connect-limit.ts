import { NextResponse } from 'next/server';
import { AttemptLimiter } from '@/lib/utils/attempt-limiter';

/** Connect checks (/api/apple/auth, /api/auth) allowed per server instance per window */
export const CONNECT_CHECKS_PER_WINDOW = 300;
const WINDOW_MS = 10 * 60 * 1000;

let connectChecks = new AttemptLimiter({ limit: CONNECT_CHECKS_PER_WINDOW, globalLimit: CONNECT_CHECKS_PER_WINDOW, windowMs: WINDOW_MS });

/**
 * A per-instance brake on the connect checks, so this server can't be used
 * to test tokens against the stores at speed. Not per client: client IP
 * headers can be forged unless a trusted proxy sets them. Null when the
 * check may run; otherwise the 429 to send.
 */
export function limitConnectCheck(): NextResponse | null {
  const decision = connectChecks.attempt(undefined);
  if (decision.allowed) return null;
  return NextResponse.json(
    { error: 'Too many connection attempts. Try again later.', code: 'TOO_MANY_CONNECT_CHECKS' },
    { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds), Date: new Date().toUTCString() } }
  );
}

/** Test-only: start a fresh window */
export function resetConnectLimitForTests(): void {
  connectChecks = new AttemptLimiter({ limit: CONNECT_CHECKS_PER_WINDOW, globalLimit: CONNECT_CHECKS_PER_WINDOW, windowMs: WINDOW_MS });
}
