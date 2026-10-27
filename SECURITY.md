# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/andyshephard/PricingKit/security/advisories/new).

Do not open a public issue for security problems. Include the affected version or commit,
steps to reproduce, and the impact you expect. You should get an acknowledgement within a
few days. Fixes are released on `main` and credited in the advisory unless you prefer
otherwise.

Only the latest `main` is supported.

## How credentials are handled

PricingKit needs store API credentials to read and update prices: an App Store Connect API
key (`.p8` private key, Key ID, Issuer ID) and/or a Google Play service account JSON key.

1. **Upload.** The browser sends the credentials over HTTPS to the PricingKit server you are
   using. They do leave your browser: the server makes the Apple/Google API calls.
2. **Session cookie.** The server validates them with a read-only API call and keeps only
   the fields it needs (for Google: `client_email`, `private_key_id`, `private_key`,
   `project_id`). It seals them in an envelope with the session type, the time issued and an
   absolute expiry 24 hours later, encrypts that with AES-256-GCM under a key derived from
   `ENCRYPTION_KEY` (HKDF-SHA-256 over the key's bytes, derived once per process), with the
   cookie's name and the session version as additional authenticated data, and returns it in
   an `HttpOnly`, `SameSite=Strict`, `Secure` cookie named with the `__Host-` prefix (in
   production; under `next dev` the cookie is neither `Secure` nor prefixed). Page JavaScript
   cannot read it. **The server enforces the 24 hours**: a copied cookie stops working when its
   envelope expires, whatever the browser does, and nothing extends it (moving a cookie to a
   new name or format keeps its expiry). One kind of session can't be used as another. Setting
   or changing `SESSION_VERSION` signs everyone out at once. Credentials too large for a cookie
   (about 4 KB) are refused at sign-in instead of being silently dropped by the browser.
3. **Per request.** Each API request sends the cookie back. The server decrypts it in
   memory, calls Apple/Google, and discards the plaintext. Credentials are not written to
   disk, a database, or logs.
4. **Token cache.** Short-lived tokens (Apple JWTs, up to 20 minutes; Google access tokens,
   up to 1 hour) are cached in server memory, keyed by a SHA-256 hash of the full
   credential, including the private key. The cache holds at most 50 entries. Two users
   whose keys share a Key ID or client email never share a token.
5. **Sign-in is read-only.** Connecting an account or switching apps only lists data. If
   the key lacks pricing-write permission, you find out on your first edit. Sign-in accepts
   Google keys only as RSA keys of 2048 to 4096 bits (checked before the key is imported) and
   is rate limited: 10 attempts per client per 10 minutes when `TRUSTED_CLIENT_IP_HEADER` is
   set, and 300 per server instance.
6. **`ENCRYPTION_KEY` is required, and must be random.** It must be base64 (or base64url)
   of at least 32 bytes, as `openssl rand -base64 32` prints. Without it, or with anything
   else (a passphrase, a short value), the server refuses to create or read sessions. The only
   exception is `next dev` (`NODE_ENV=development`), which accepts any key (with a warning)
   and without one falls back to an unencrypted cookie for local convenience. Never expose a
   dev server to a network.
7. **Cookies from earlier versions.** Session cookies written before the envelope (formats
   v1 and v2, and the cookie names without `__Host-`) are read until **2026-11-10 00:00 UTC**
   (`LEGACY_SESSION_CUTOFF` in `src/lib/encryption.ts`) and re-written in the current format
   on the request that reads them, with an expiry no later than that date; from then on they
   are refused. Under an old name only an old-format cookie is accepted: a current-format
   session found there was planted (a sibling subdomain can set unprefixed cookies) and is
   refused. Anything that isn't a well-formed cookie of a plausible size is refused before
   any key is derived. Legacy cookies are refused at once when `SESSION_VERSION` is set.

Requests that change something (`POST`, `PUT`, `PATCH`, `DELETE`):

- must come from the app's own pages: a browser request whose `Sec-Fetch-Site` isn't
  `same-origin`, or whose `Origin` names another host, is refused with `403`. A request with
  neither header (curl, a script) is not from a browser, so no other site can make a visitor's
  browser send it; it is allowed and still needs a session where the route does.
- take a body only as `application/json` (`415` otherwise), so a cross-site HTML form can't
  sign a visitor in to an attacker's account or plant an Open Exchange Rates key.
- are size-limited: 16 KB for sign-in, app switching and settings, 1 MB for store edits,
  plans, applies and bulk updates (`413`), by `Content-Length` and by the bytes actually read.

Every response carries a Content-Security-Policy (no `eval` outside `next dev`, no `<base>`
changes, forms only to this site, no plugins, no framing), `X-Frame-Options: DENY`,
`nosniff`, a strict referrer policy and HSTS. Inline scripts and styles are still allowed
(Next.js inlines its bootstrap code; a nonce-based policy is planned).

Other data:

- The optional Open Exchange Rates API key entered in Settings is stored in an `HttpOnly`
  cookie (`__Host-` prefixed in production) on your browser for up to a year and sent to the
  server on each request; signing out deletes it. Settings only ever shows
  its last four characters. An operator key set through `OPEN_EXCHANGE_RATES_APP_ID` is
  never returned to clients.
- The public endpoints (`/api/ppp`, `/api/exchange-rates`, `/index-checker`) need no
  sign-in. Forcing an upstream refresh with `?refresh=true` needs a valid Apple or Google
  session; without one the endpoint returns `401`.

## Hosted vs self-hosted

**Hosted instance.** Your credentials pass through, and are decrypted in the memory of,
a server you do not control. The code does not store them, but you are trusting the
operator to run the published code with a secret `ENCRYPTION_KEY`. Use a dedicated API key
with only the permissions PricingKit needs, and revoke it when you are done.

**Self-hosted.** You control the server, `ENCRYPTION_KEY`, and logs, so credentials never
reach a third party apart from Apple and Google. This is the recommended setup for
production accounts. Set `ENCRYPTION_KEY` to 32 random bytes in base64
(`openssl rand -base64 32`), serve over HTTPS, and keep it secret. Rotating it signs every
user out: there is one key and no key ID, so cookies made under the old key no longer decrypt
and are treated as signed out. Rotate it (set a new random value and restart or redeploy) when
it may have leaked. To sign everyone out without changing the key, for example when a copied
session cookie must stop working before its 24 hours are up, set or change `SESSION_VERSION`.
