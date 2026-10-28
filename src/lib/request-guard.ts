// Guards for API routes that change something (POST, PUT, PATCH, DELETE).
//
// Cross-site requests: there are no cookies; store routes need X-PK-* token
// headers, which a cross-site page can't send without a CORS preflight these
// routes never grant. This guard is a second layer: a cross-site HTML form
// can POST text/plain that parses as JSON. So every non-GET route:
// - refuses a browser request that isn't same-origin: Sec-Fetch-Site must be
//   "same-origin" when sent; otherwise Origin, when sent, must name this host.
//   A request with neither header comes from a non-browser client (curl, a
//   script), which no other site can make a browser send; it is allowed.
// - takes a body only as application/json (an HTML form can't send that
//   cross-site without a CORS preflight, which these routes never grant).
//
// Request bodies are capped: the Content-Length header first, then the bytes
// actually read, so a large or endless body is refused without being held in
// memory.

import { NextResponse } from 'next/server';

/** App switching (the connect checks take no body) */
export const SMALL_BODY_LIMIT = 16 * 1024;
/** Store edits, plans, applies and bulk updates */
export const LARGE_BODY_LIMIT = 1024 * 1024;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function forbidden(): NextResponse {
  return NextResponse.json({ error: 'Cross-site requests are not accepted' }, { status: 403 });
}

/** The hosts this request was addressed to: its URL's, and the Host / X-Forwarded-Host headers' */
function ownHosts(request: Request): Set<string> {
  const hosts = new Set<string>();
  try {
    hosts.add(new URL(request.url).host.toLowerCase());
  } catch {
    // relative or odd URL: rely on the headers
  }
  for (const header of ['host', 'x-forwarded-host']) {
    for (const value of (request.headers.get(header) ?? '').split(',')) {
      const host = value.trim().toLowerCase();
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

/**
 * Null when the request may proceed; otherwise the 403 to send. GET, HEAD
 * and OPTIONS always pass (they change nothing).
 */
export function rejectCrossSite(request: Request): NextResponse | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site.trim().toLowerCase() === 'same-origin' ? null : forbidden();
  const origin = request.headers.get('origin');
  if (origin === null) return null; // not a browser
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return forbidden(); // "null" and other opaque origins
  }
  return ownHosts(request).has(host) ? null : forbidden();
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

export type JsonBodyResult = { ok: true; body: unknown } | { ok: false; response: NextResponse };

/**
 * The request's JSON body, after the cross-site check, a Content-Type of
 * application/json and at most `limit` bytes. Invalid JSON is a 400, too
 * large a 413, another content type a 415.
 */
export async function readJsonBody(request: Request, limit: number): Promise<JsonBodyResult> {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return { ok: false, response: crossSite };
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return { ok: false, response: NextResponse.json({ error: 'Send the request body as application/json' }, { status: 415 }) };
  }
  const tooLarge = () => ({ ok: false as const, response: NextResponse.json({ error: 'Request body too large' }, { status: 413 }) });
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > limit)) return tooLarge();

  const parts: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      parts.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 }) };
  }
}
