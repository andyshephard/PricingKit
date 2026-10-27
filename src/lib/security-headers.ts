// Response headers for every route (next.config.ts). Kept here so tests can
// check them without loading the Next config.
//
// The Content-Security-Policy still allows inline scripts and styles: Next's
// App Router inlines its bootstrap scripts, and a nonce-based policy needs a
// proxy (middleware) that makes every page render dynamically. 'unsafe-eval'
// is only allowed under `next dev`, where React's dev tooling needs it.
//
// connect-src: the browser mints Google access tokens itself (Google's token
// endpoint; the service account key never leaves the browser) and tests a
// user's own Open Exchange Rates key directly. App Store Connect has no CORS,
// so Apple calls go through this server with a browser-signed token.

export function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://cdn.buymeacoffee.com",
    "font-src 'self' data:",
    "connect-src 'self' https://oauth2.googleapis.com https://openexchangerates.org",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(dev: boolean): Array<{ key: string; value: string }> {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(dev) },
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  ];
}
