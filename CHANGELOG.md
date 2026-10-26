# Changelog

All notable user-visible changes to PricingKit are recorded here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
PricingKit has no tagged releases yet; everything below is on its way to `main`.

## [Unreleased]

### Upgrade notes for self-hosters

1. **Set `ENCRYPTION_KEY` before you upgrade.** Production builds (`npm start`, Cloudflare Workers) now refuse to sign anyone in without it, and existing sessions stop working. Generate one with `openssl rand -base64 32` and set it in `.env.local`, your process environment, or as a Worker secret (`npx wrangler secret put ENCRYPTION_KEY`). Only `npm run dev` still works without it. Setting or changing the key signs every user out once; they sign in again as usual.
2. **Node 22 or later** is now declared in `package.json` `engines` and `.nvmrc`.
3. **Scripts calling `?refresh=true`** on `/api/ppp` or `/api/exchange-rates` must now send a valid Google or Apple session cookie, or they get `401`. Plain reads without `refresh` are still public.
4. **Clients of `/api/bulk`** should read the per-item `success`, `error` and `skippedRegions` fields. The top-level `success` is now `false` when nothing was written.
5. Nothing else needs configuring. There is no database, no session file and no new environment variable.

### Added

- **Price export.** Product and subscription detail pages (Google and Apple) have an "Export prices" menu that downloads the current prices as CSV or JSON. Google subscriptions export per base plan; Apple subscriptions include scheduled prices. Backed by the read-only `GET /api/export` endpoint, which never writes to a store. The JSON format is versioned (`schemaVersion: 1`).
- **Retries with backoff** for Google Play and App Store Connect calls. 429, 5xx and network errors are retried up to 4 attempts with jittered exponential backoff, honouring `Retry-After` up to 60 seconds. Apple's hourly `X-Rate-Limit` is tracked, and requests stop once it reports 0 remaining instead of hammering the API.
- **CI.** GitHub Actions runs tests, `npm run typecheck` and lint on every pull request and push to `main`. Dependabot opens weekly grouped dependency updates.
- `npm run typecheck` script.
- `SECURITY.md` with private vulnerability reporting and the credential-handling model.

### Changed

- **Google Play region edits no longer launch or re-enable regions.** Editing prices on a subscription base plan or one-time product changes only the regions you edited. Previously every save turned on new-subscriber availability for all regions, auto-filled every unconfigured region with a price converted from the US price, and required a US price. Other regions, availability settings and other base plans are now sent back exactly as Google returned them, and the product keeps its own `regionsVersion`. If Google needs something more (for example a USD/EUR price), you see Google's error instead of PricingKit guessing prices.
- **Untouched one-time product regions are kept as they are.** Regions with no price are no longer rewritten to a USD 0 price on save.
- **Sign-in and app switching are read-only.** Connecting a Google account or switching apps no longer sends a no-op PATCH to test write permission. If your service account lacks pricing permission, you find out on your first price edit (403).
- **`ENCRYPTION_KEY` is required** outside `npm run dev` (see upgrade notes). Login checks this before contacting Apple or Google and shows a message explaining how to set it.
- **Missing exchange rates are an error, not USD parity.** A region whose currency has no exchange rate used to be priced as if 1 unit = 1 USD. It is now shown as "No exchange rate", cannot be selected in the bulk pricing modals and is never applied. If the base region has no rate, an Apple update is blocked. The Index Checker shows these regions as flagged instead of a price.
- **"Custom" pricing strategy is hidden** in the bulk pricing modals until per-territory multipliers exist. PPP, Big Mac and Netflix are unchanged.
- **Rounding rounds down.** The bulk "round" operation now rounds to the nearest price ending at or below the current price (12.00 becomes 11.99, not 12.99). Zero-decimal currencies such as JPY and KRW get whole-number prices. Subscription base plans use the same rounding as products.
- Live World Bank PPP multipliers are clamped to 0.1–2.0, like the static indexes.
- **Bulk updates report what they skipped.** `/api/bulk` now marks subscription items without a base plan, and items where none of the target regions had a price, as failed, and lists skipped regions with a reason. The bulk modal shows them and no longer says "Successfully updated 0 items".
- The generic bulk update button was removed from the Apple products and subscriptions list pages. It called the Google-only `/api/bulk` endpoint and could not work for Apple. Use the Apple bulk pricing modals instead.
- **Apple subscription price edits keep scheduled prices.** New prices are created before the scheduled price they replace is deleted. On a 409 conflict the old scheduled price is deleted and the create retried; if that retry fails, the old price is restored. The result lists each territory's outcome and is not reported as a success if any territory failed.
- `?refresh=true` on the public `/api/ppp` and `/api/exchange-rates` endpoints requires a signed-in session (see upgrade notes).
- Settings no longer returns any part of an operator's `OPEN_EXCHANGE_RATES_APP_ID`. A key you saved yourself shows only its last 4 characters.
- The site and README now describe credential handling accurately: credentials are sent to the PricingKit server you use, encrypted into an HttpOnly cookie, and not stored server-side.

### Fixed

- Deleting a Google one-time product region price reported success without changing anything. It now removes the region. Deleting a base plan region removes exactly that region instead of re-filling the others.
- Google 400/409/412 rejections on region edits and deletes are shown with Google's reason instead of a generic 500.
- An Apple in-app purchase price update without a base territory price reported success without writing anything. It now fails with a 422 explaining the missing or unsupported base territory.
- Apple subscription read errors (auth, rate limit, server errors) were shown as "Subscription not found" or as an empty price list. They now show the real error, and a genuine 404 still shows "Subscription not found".
- The Apple subscription price-tier picker showed "No price tiers available" when loading failed. It now shows the error with a Retry button.
- A completed Apple subscription write is no longer reported as failed when only the follow-up refresh fails.
- Error messages no longer read "[object Object]", and Google-shaped errors such as `{ code: 429 }` are now treated as retryable by the shared rate-limit helper.
- Network failures while fetching a Google access token are now retried.

### Security

- Apple JWTs and Google access tokens are cached per full credential (SHA-256 of the key, 50-entry LRU). On a shared instance, two users whose keys share a Key ID or client email can no longer receive each other's token.
- Session cookies fail closed without `ENCRYPTION_KEY` instead of falling back to plaintext base64 outside `next dev`.
- Public endpoints return generic error messages; upstream error details are logged server-side only.
