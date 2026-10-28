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
**The private key never reaches the PricingKit server**: the published code keeps it in your
browser and sends the server only short-lived access tokens, and the server keeps nothing.
(See "Hosted vs self-hosted" for what that relies on.)

1. **Import in the browser.** When you connect, the browser reads the key file and imports
   the private key with the Web Crypto API as a *non-extractable* key: it can sign, but no
   script, PricingKit's own included, can read it back out. The file's text is then dropped.
   The key is kept in this browser's IndexedDB with its non-secret IDs (Key ID and Issuer
   ID; or the service account's `client_email`, `private_key_id` and `project_id`).
2. **Proved before it is kept.** A new key is first held in memory only and proved with one
   read-only call (listing your apps, or reading one subscription of the Google Play app).
   Only if the store accepts it is it stored, replacing any earlier key; otherwise it is
   dropped and the earlier key stays as it was. Google keys are accepted only as RSA keys of
   2048 to 4096 bits.
3. **Short-lived tokens.** For each request the browser makes a token:
   - App Store Connect: a JWT signed in the browser (ES256, valid for 20 minutes).
   - Google Play: the browser signs an assertion and exchanges it itself at Google's token
     endpoint (`oauth2.googleapis.com`) for an access token (valid for up to 1 hour). The
     server never sees the assertion.

   The token goes to the PricingKit server in a request header (`X-PK-Apple-Token` or
   `X-PK-Google-Token`, with the app in `X-PK-App`). App Store Connect doesn't accept calls
   from browsers, so the server forwards each call to Apple or Google with that token. It
   keeps no session, sets no cookie and stores no credential.
4. **Checked, not trusted.** Before using an App Store Connect token the server checks its
   shape: a JWT signed with ES256, for App Store Connect, valid for at most 20 minutes, not
   expired, and not issued in the future (allowing up to 60 seconds of clock difference).
   These checks only save a pointless call; Apple and
   Google verify every token. The server never logs, caches or echoes a token or these
   headers.
5. **Long requests.** Writes, applies, bulk updates and exports ask the browser for a token
   with most of its life left, and the server refuses an App Store Connect token with under
   10 minutes left for them (`TOKEN_TOO_SHORT`), so a token can't expire halfway through.
6. **Connecting is read-only.** Connecting or switching apps only lists data. If the key
   lacks pricing-write permission, you find out on your first edit.
7. **Kept until you remove it.** The key stays in that browser profile until you **Sign
   out** or use **Forget this key** in Settings. Signing out deletes both store keys, the
   saved Open Exchange Rates key, the selected apps and the list of recent apps, and signs
   the other tabs out too. On a shared computer, always sign out.

Requests that change something (`POST`, `PUT`, `PATCH`, `DELETE`):

- must come from the app's own pages: a browser request whose `Sec-Fetch-Site` isn't
  `same-origin`, or whose `Origin` names another host, is refused with `403`. A request with
  neither header (curl, a script) is not from a browser, so no other site can make a visitor's
  browser send it; it is allowed and still needs a store token where the route does. The
  token headers also force a CORS preflight, which these routes never grant, so this check is
  a second layer.
- take a body only as `application/json` (`415` otherwise), so a cross-site HTML form can't
  act for a visitor.
- are size-limited: 16 KB for app switching, 1 MB for store edits, plans, applies and bulk
  updates (`413`), by `Content-Length` and by the bytes actually read.

Every response carries a Content-Security-Policy (no `eval` outside `next dev`, no `<base>`
changes, forms only to this site, connections only to this site, Google's token endpoint and
Open Exchange Rates, no plugins, no framing), `X-Frame-Options: DENY`, `nosniff`, a strict
referrer policy and HSTS. Inline scripts and styles are still allowed (Next.js inlines its
bootstrap code; a nonce-based policy is planned).

Other data:

- The optional Open Exchange Rates key entered in Settings is tested from your browser
  against Open Exchange Rates, kept in this browser's local storage, and sent (in
  `X-PK-OER-Key`) only with requests to `/api/exchange-rates` and `/api/ppp`. The server
  uses it only on a request that also carries a store token. Rates fetched with it are
  returned to you only, never cached for other visitors, and such fetches are rate limited
  per key and per server instance; over the limit, the operator's cached rates are served.
  Signing out deletes it. Settings only ever shows its last four characters. An operator key
  set through `OPEN_EXCHANGE_RATES_APP_ID` is never returned to clients.
- The selected app (bundle ID or package name) and a list of recently used apps are kept in
  this browser's local storage. They aren't secret.
- The connect checks (`/api/apple/auth`, `/api/auth`) are rate limited per server instance.
- The public endpoints (`/api/ppp`, `/api/exchange-rates`, `/index-checker`) need no
  sign-in. Forcing an upstream refresh with `?refresh=true` needs a store token header
  (`403` otherwise). That is a speed bump, not authentication: a refresh never spends the
  operator's Open Exchange Rates key, and World Bank data is refreshed at most every 10
  minutes.

## Command line and agents

The CLI and MCP server are local tools: they take credentials only from environment variables
on your machine, hold them in memory, sign tokens in that process, and scrub everything they
print or write to a run log. They never talk to a PricingKit server.

## Hosted vs self-hosted

**Hosted instance.** Your private key never reaches the PricingKit server, and the published
code never sends it there. But the hosted operator serves the page's JavaScript, so using a
hosted instance still means trusting that operator to serve the published code. Modified or
injected script running in the page could read the key file while you connect, or use the
stored key to sign tokens, including tokens dated for later, and so keep access until you
revoke the key. The server also sees the short-lived tokens it forwards (App Store Connect up
to 20 minutes, Google Play up to 1 hour). Use a dedicated API key with only the permissions
PricingKit needs, revoke it when you are done, and revoke it at once in App Store Connect or
Google Cloud if you suspect a compromise.

**Self-hosted.** You run the server and serve the JavaScript yourself, so neither the key nor
the tokens depend on anyone else. Running the `pricingkit` CLI locally is the other way to
keep everything on your machine. This is the recommended setup for production accounts.
Serve it over HTTPS. There is no secret to configure: `ENCRYPTION_KEY`, `SESSION_VERSION` and
`TRUSTED_CLIENT_IP_HEADER` from earlier versions are no longer used and can be deleted.

## Remaining risks

- **Script running in the page.** Injected script, or a modified copy of the page, can't read
  a key already stored (it is non-extractable), but it can ask the browser to sign with it.
  It could sign App Store Connect tokens dated for later and keep using them after the tab is
  closed, so it keeps access until you revoke the key. The Content-Security-Policy is the main
  defence against injected script; self-hosting is the defence against a dishonest host.
- **Shared computers.** The key stays in that browser profile until you sign out or forget
  it.
