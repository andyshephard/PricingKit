// The browser's single way to call this app's /api routes.
//
// It adds what each route needs:
// - store routes: X-PK-Apple-Token (a JWT signed in this browser) or
//   X-PK-Google-Token (an access token this browser minted), and X-PK-App
// - /api/ppp and /api/exchange-rates: the user's own Open Exchange Rates key
//   (X-PK-OER-Key) when one is saved, and a store token on ?refresh=true
//
// Writes, applies, bulk updates and exports ask for a token with most of its
// life left (APPLE_/GOOGLE_APPLY_MIN_VALID_SECONDS). On a 401 it sets the
// clock offset from the server's Date header and retries once with a new
// token (the refused one is passed as `rejected`); a write is retried only
// when the server's auth check refused it, before anything was sent to a
// store. If that fails too, onAuthFailure runs (the Connect prompt).
//
// Tokens are never logged or kept anywhere but the BrowserKeys slots.

import { APPLE_APPLY_MIN_VALID_SECONDS, BrowserKeyError, GOOGLE_APPLY_MIN_VALID_SECONDS, type KeyPlatform, type TokenOptions } from '@/lib/browser-keys';

export const APPLE_TOKEN_HEADER = 'X-PK-Apple-Token';
export const GOOGLE_TOKEN_HEADER = 'X-PK-Google-Token';
export const APP_HEADER = 'X-PK-App';
export const OER_KEY_HEADER = 'X-PK-OER-Key';

/** The parts of BrowserKeys apiFetch uses */
export interface TokenProvider {
  getAppleToken(options?: TokenOptions): Promise<string>;
  getGoogleAccessToken(options?: TokenOptions): Promise<string>;
  setClockOffsetMs(ms: number): void;
  getClockOffsetMs(): number;
}

export interface ApiFetchDeps {
  keys: () => TokenProvider;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** The selected app for a platform (bundle ID or package name), or null */
  activeApp: (platform: KeyPlatform) => string | null;
  /** The store the dashboard is showing, for public routes that take an optional token */
  activePlatform: () => KeyPlatform | null;
  /** The user's own Open Exchange Rates app ID, or null */
  oerKey: () => string | null;
  /** The store refused this browser's token twice, or no key is stored: prompt to connect */
  onAuthFailure: (platform: KeyPlatform) => void;
  now?: () => number;
}

export interface ApiFetchInit extends RequestInit {
  /** Overrides the route's store (e.g. the connect check for a package not yet selected) */
  platform?: KeyPlatform;
  /** Overrides X-PK-App; null sends none */
  app?: string | null;
  /** Ask for a token that outlives a long request (defaults: writes and exports) */
  long?: boolean;
  /** Don't call onAuthFailure on a persistent 401 (the connect flow shows its own message) */
  quietAuthFailure?: boolean;
}

interface RoutePlan {
  platform: KeyPlatform | null;
  /** The route takes X-PK-App */
  needsApp: boolean;
  /** /api/ppp, /api/exchange-rates: no store, optional extras */
  publicData: boolean;
}

const GOOGLE_PREFIXES = ['/api/products', '/api/subscriptions', '/api/bulk'];
/** Routes that take a store token but no app */
const NO_APP = new Set(['/api/apple/apps', '/api/apple/active-app', '/api/apple/auth', '/api/active-app']);

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Which store (if any) an /api path belongs to */
export function planRoute(url: URL): RoutePlan {
  const path = url.pathname;
  if (under(path, '/api/ppp') || under(path, '/api/exchange-rates')) return { platform: null, needsApp: false, publicData: true };
  if (under(path, '/api/apple')) return { platform: 'apple', needsApp: !NO_APP.has(path), publicData: false };
  if (path === '/api/auth') return { platform: 'google', needsApp: true, publicData: false };
  if (path === '/api/active-app') return { platform: 'google', needsApp: false, publicData: false };
  if (GOOGLE_PREFIXES.some((p) => under(path, p))) return { platform: 'google', needsApp: true, publicData: false };
  if (path === '/api/export') {
    const platform = url.searchParams.get('platform');
    return { platform: platform === 'apple' || platform === 'google' ? platform : null, needsApp: true, publicData: false };
  }
  return { platform: null, needsApp: false, publicData: false };
}

/** Codes from the server's own auth check: nothing reached a store, so a write can be retried */
const PRE_CHECK_CODES = new Set(['NOT_AUTHENTICATED', 'INVALID_TOKEN', 'TOKEN_EXPIRED', 'TOKEN_TOO_SHORT']);
/** Correct the clock only when it is clearly off (Date has 1-second resolution, plus latency) */
const CLOCK_SKEW_THRESHOLD_MS = 30_000;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const STORE: Record<KeyPlatform, string> = { apple: 'App Store Connect', google: 'Google Play' };

/** A Response for a token this browser couldn't make, so callers' usual error paths apply */
function tokenFailure(platform: KeyPlatform, error: unknown): { response: Response; auth: boolean } {
  if (error instanceof BrowserKeyError) {
    if (error.code === 'not_connected' || error.code === 'token_rejected' || error.code === 'invalid_key') {
      return { response: jsonResponse(401, { error: error.message, code: 'NOT_CONNECTED' }), auth: true };
    }
    if (error.code === 'storage') {
      return { response: jsonResponse(401, { error: error.message, code: 'KEY_STORAGE' }), auth: true };
    }
    return { response: jsonResponse(503, { error: error.message, code: 'TOKEN_NETWORK' }), auth: false };
  }
  return { response: jsonResponse(500, { error: `Could not make a ${STORE[platform]} token in this browser.` }), auth: false };
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return typeof body?.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

export function createApiFetch(deps: ApiFetchDeps) {
  const now = deps.now ?? Date.now;

  async function token(platform: KeyPlatform, options: TokenOptions): Promise<string> {
    const keys = deps.keys();
    return platform === 'apple' ? keys.getAppleToken(options) : keys.getGoogleAccessToken(options);
  }

  function minValid(platform: KeyPlatform): number {
    return platform === 'apple' ? APPLE_APPLY_MIN_VALID_SECONDS : GOOGLE_APPLY_MIN_VALID_SECONDS;
  }

  /** Server time minus local time, from a response's Date header */
  function syncClock(response: Response): void {
    const date = response.headers.get('date');
    if (!date) return;
    const server = Date.parse(date);
    if (!Number.isFinite(server)) return;
    const offset = server - now();
    const keys = deps.keys();
    // The offset is applied to the local clock, so compare against the current correction
    if (Math.abs(offset - keys.getClockOffsetMs()) > CLOCK_SKEW_THRESHOLD_MS) keys.setClockOffsetMs(offset);
  }

  return async function apiFetch(input: string, init: ApiFetchInit = {}): Promise<Response> {
    const { platform: platformOverride, app: appOverride, long: longOverride, quietAuthFailure, ...requestInit } = init;
    const url = new URL(input, 'http://localhost');
    const plan = planRoute(url);
    const method = (requestInit.method ?? 'GET').toUpperCase();
    const headers = new Headers(requestInit.headers);

    if (plan.publicData) {
      const oer = deps.oerKey();
      if (oer) headers.set(OER_KEY_HEADER, oer);
      // A refresh needs a store token (a speed bump on the server); best effort
      const refreshPlatform = url.searchParams.get('refresh') === 'true' ? deps.activePlatform() : null;
      if (refreshPlatform) {
        try {
          headers.set(refreshPlatform === 'apple' ? APPLE_TOKEN_HEADER : GOOGLE_TOKEN_HEADER, await token(refreshPlatform, {}));
        } catch {
          // no key: the server answers without a refresh
        }
      }
      return deps.fetch(input, { ...requestInit, headers });
    }

    const platform = platformOverride ?? plan.platform;
    if (!platform) return deps.fetch(input, { ...requestInit, headers });

    const app = appOverride !== undefined ? appOverride : plan.needsApp ? deps.activeApp(platform) : null;
    if (app) headers.set(APP_HEADER, app);
    const long = longOverride ?? (WRITE_METHODS.has(method) || url.pathname === '/api/export');
    const tokenHeader = platform === 'apple' ? APPLE_TOKEN_HEADER : GOOGLE_TOKEN_HEADER;

    const send = async (options: TokenOptions): Promise<{ response: Response; sent?: string }> => {
      let value: string;
      try {
        value = await token(platform, options);
      } catch (error) {
        const failure = tokenFailure(platform, error);
        if (failure.auth && !quietAuthFailure) deps.onAuthFailure(platform);
        return { response: failure.response };
      }
      headers.set(tokenHeader, value);
      return { response: await deps.fetch(input, { ...requestInit, headers }), sent: value };
    };

    const first = await send(long ? { minValidSeconds: minValid(platform) } : {});
    if (first.response.status !== 401 || first.sent === undefined) return first.response;

    syncClock(first.response);
    const code = await errorCode(first.response);
    const replayable = !(requestInit.body instanceof ReadableStream);
    const safe = !WRITE_METHODS.has(method) || (code !== undefined && PRE_CHECK_CODES.has(code));
    if (!replayable || !safe) {
      if (!quietAuthFailure) deps.onAuthFailure(platform);
      return first.response;
    }

    const retryOptions: TokenOptions =
      code === 'TOKEN_TOO_SHORT'
        ? { rejected: first.sent, minValidSeconds: minValid(platform) }
        : { rejected: first.sent, ...(long ? { minValidSeconds: minValid(platform) } : {}) };
    const second = await send(retryOptions);
    if (second.response.status === 401 && second.sent !== undefined) {
      syncClock(second.response);
      if (!quietAuthFailure) deps.onAuthFailure(platform);
    }
    return second.response;
  };
}

export type ApiFetch = ReturnType<typeof createApiFetch>;
