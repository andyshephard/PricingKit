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
2. **Session cookie.** The server validates them with a read-only API call, then encrypts
   them with AES-256-GCM using a key derived from `ENCRYPTION_KEY` (PBKDF2-SHA-256), and
   returns them in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` in production) that
   expires after 24 hours. Page JavaScript cannot read it.
3. **Per request.** Each API request sends the cookie back. The server decrypts it in
   memory, calls Apple/Google, and discards the plaintext. Credentials are not written to
   disk, a database, or logs.
4. **Token cache.** Short-lived tokens (Apple JWTs, up to 20 minutes; Google access tokens,
   up to 1 hour) are cached in server memory, keyed by a SHA-256 hash of the full
   credential, including the private key. The cache holds at most 50 entries. Two users
   whose keys share a Key ID or client email never share a token.
5. **Sign-in is read-only.** Connecting an account or switching apps only lists data. If
   the key lacks pricing-write permission, you find out on your first edit.
6. **`ENCRYPTION_KEY` is required.** Without it the server refuses to create or read
   sessions. The only exception is `next dev` (`NODE_ENV=development`), which falls back to
   a base64 cookie for local convenience. Never expose a dev server to a network.

Other data:

- The optional Open Exchange Rates API key entered in Settings is stored in an `HttpOnly`
  cookie on your browser and sent to the server on each request. Settings only ever shows
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
production accounts. Set `ENCRYPTION_KEY` to a long random value (for example
`openssl rand -base64 32`), serve over HTTPS, and keep it secret. Rotating it signs every
user out.
