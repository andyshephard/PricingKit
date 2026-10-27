# Changelog

All notable user-visible changes to PricingKit are recorded here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
PricingKit has no tagged releases yet; everything below is on its way to `main`.

## [Unreleased]

### Upgrade notes for self-hosters

1. **Make sure `ENCRYPTION_KEY` is set anywhere other than `npm run dev`.** Production builds (`npm start`, Cloudflare Workers) already needed it to sign anyone in, so a working production deployment is unaffected. What changes: login now checks for the key before contacting Apple or Google and explains how to set it (instead of a generic 500), and session cookies are no longer read as plaintext base64 anywhere except `next dev`, including when `NODE_ENV` is unset or non-standard. If you ran without `NODE_ENV=production` and without a key, existing sessions stop working and sign-in is refused until you set one. Generate a key with `openssl rand -base64 32` and set it in `.env.local`, your process environment, or as a Worker secret (`npx wrangler secret put ENCRYPTION_KEY`). Earlier README text called the key "recommended"; that was wrong.
2. **Node 22 or later** is now declared in `package.json` `engines`; `.nvmrc` pins the version CI uses (22.23.3).
3. **Scripts calling `?refresh=true`** on `/api/ppp` or `/api/exchange-rates` must now send a valid Google or Apple session cookie, or they get `401`. Plain reads without `refresh` are still public.
4. **Clients of `/api/bulk`** should read the per-result `success`, `error` and `skippedRegions` fields. The top-level `success` is now `false` when nothing was written. A subscription item sent without a `basePlanId` now produces one result per base plan (each carrying its `basePlanId`), so `total` and `results` count base plans for subscriptions, not request items.
5. **Optional `TRUSTED_CLIENT_IP_HEADER`.** Set it to `cf-connecting-ip` on Cloudflare (or the header your own proxy sets) to rate-limit anonymous Open Exchange Rates key tests per client. Without it they share one per-instance limit.
6. **Forks importing the pricing maths** should change `@/lib/google-play/currency` to `@/lib/pricing` and `@/lib/conversion-indexes/*` to `@/lib/pricing/indexes/*`. The functions are unchanged.
7. Nothing else needs configuring. There is no database and no session file.

### Added

- **Plans you can review, apply, resume and undo** (library, `src/lib/pricing` and `src/lib/adapters`; no UI yet). A plan is a JSON file (`pricingkit.changeset`) listing every price change with the price expected before and the price set after. Applying it checks each territory first: one already at its target is skipped, one that changed since the plan was made is reported and left alone, so applying a plan twice changes nothing the second time. Each run keeps a JSON log (`pricingkit.applyRun`), saved before and after every write, that can be resumed after a partial failure or a crash and turned into an undo plan. If the log can't be saved, the run stops before writing anything else. Covers base prices of Apple subscriptions and Google Play base plans and one-time products. Current prices can be saved as JSON (`pricingkit.state`); Phase 0 price exports import as state.
- **Snapping to real store prices.** The Apple adapter snaps each territory's target to that territory's live subscription price points. The Google Play adapter snaps through Play's own `convertRegionPrices`, allowing for each region's tax.
- The pricing maths is now a framework-free core with exact decimal money; a test keeps Next.js, React and network code out of it.

- **Price export.** Product and subscription detail pages (Google and Apple) have an "Export prices" menu that downloads the current prices as CSV or JSON. Google subscriptions export per base plan; Apple subscriptions include scheduled prices. Backed by the read-only `GET /api/export` endpoint, which never writes to a store. The JSON format is versioned (`schemaVersion: 1`). An Apple in-app purchase export fails, rather than guessing, if its base territory can't be read.
- **Retries with backoff** for Google Play and App Store Connect calls. 429, 5xx and network errors are retried up to 4 attempts with jittered exponential backoff, honouring `Retry-After` up to 60 seconds. App Store Connect creates (POST) are retried only on 429: after a 5xx, timeout or network error the create may already exist, so it is reported instead of being sent again. Apple's hourly `X-Rate-Limit` is tracked: a 429 is not retried when it reports 0 requests remaining; callers that pass a `RequestBudget` stop sending entirely.
- **CI.** GitHub Actions runs tests, `npm run typecheck` and lint on every pull request and push to `main`. Dependabot opens weekly grouped dependency updates.
- `npm run typecheck` script.
- `SECURITY.md` with private vulnerability reporting and the credential-handling model.

### Changed

- **Bulk Apple routes and `/api/bulk` run within a request budget.** Each run gets its own budget (3,600 requests by default, Apple's hourly allowance per key) that also tracks Apple's `X-Rate-Limit`. Every request a run sends, including reads and pagination, is counted, and the run stops before sending once either limit is reached. The Apple price-point resolver now stops with an error when the budget is spent instead of marking every remaining territory as skipped.
- **Fewer and gentler Apple reads.** The Apple products list reads base prices 4 at a time instead of all at once, and subscription price points are read 8,000 per request (one request per territory instead of about four). Apple in-app purchase price updates by price point are sent one territory at a time.
- **Apple in-app purchase list no longer assumes USA.** A product whose price schedule names no base territory is listed without a price and flagged (`priceUnavailableReason: "BASE_TERRITORY_UNKNOWN"`) instead of showing its US price.
- When Apple refuses a subscription price with 409 and the territory already has a scheduled price, the error now names that scheduled price for immediate changes too. Nothing is deleted on a 409.
- **Testing an Open Exchange Rates key without signing in is rate limited** (429 with `Retry-After`): 50 tests per instance per 10 minutes, and 5 per client when the new optional `TRUSTED_CLIENT_IP_HEADER` names the header your proxy sets to the client IP (e.g. `cf-connecting-ip` on Cloudflare). Client IP headers are ignored unless configured, because clients can forge them. Signed-in users are not limited.

- **Google Play region edits no longer launch or re-enable regions.** Editing prices on a subscription base plan or one-time product changes only the regions you edited. Previously every save turned on new-subscriber availability for all regions, auto-filled every unconfigured region with a price converted from the US price, and required a US price. Other regions, availability settings and other base plans are now sent back exactly as Google returned them, and the product keeps its own `regionsVersion`. If Google needs something more (for example a USD/EUR price), you see Google's error instead of PricingKit guessing prices.
- **Untouched one-time product regions are kept as they are.** Regions with no price are no longer rewritten to a USD 0 price on save.
- **Sign-in and app switching are read-only.** Connecting a Google account or switching apps no longer sends a no-op PATCH to test write permission. If your service account lacks pricing permission, you find out on your first price edit (403).
- **`ENCRYPTION_KEY` is checked up front.** Production builds already required it to create a session; login now checks for it before contacting Apple or Google and shows a message explaining how to set it. The requirement now applies whenever `NODE_ENV` is not `development` (previously only when it was `production`), so an unset or non-standard `NODE_ENV` no longer allows plaintext sessions (see upgrade notes).
- **Missing exchange rates are an error, not USD parity.** A region whose currency has no exchange rate used to be priced as if 1 unit = 1 USD. It is now shown as "No exchange rate", cannot be selected in the bulk pricing modals and is never applied. If the base region has no rate, an Apple update is blocked. The Index Checker shows these regions as flagged instead of a price.
- **"Custom" pricing strategy is hidden** in the bulk pricing modals until per-territory multipliers exist. PPP, Big Mac and Netflix are unchanged.
- **Rounding rounds down.** The bulk "round" operation now rounds to the nearest price ending at or below the current price (12.00 becomes 11.99, not 12.99). Zero-decimal currencies such as JPY and KRW get whole-number prices. Subscription base plans use the same rounding as products.
- Live World Bank PPP multipliers are clamped to 0.1–2.0, like the static indexes.
- **Bulk updates report what they skipped.** `/api/bulk` now marks items where none of the target regions had a price as failed and lists skipped regions with a reason. The bulk modal shows them and no longer says "Successfully updated 0 items".
- **Bulk subscription items without a base plan apply to every base plan.** A subscription item sent to `/api/bulk` without a `basePlanId` is applied to each of the subscription's base plans, with one result per base plan, so a failure in one base plan does not hide the others. `stopOnFailure` still stops the rest, and the base plans not attempted are reported as skipped. A subscription with no base plans, or a `basePlanId` that matches none, is a failed item. The bulk modal labels subscription results by base plan.
- The generic bulk update button was removed from the Apple products and subscriptions list pages. It called the Google-only `/api/bulk` endpoint and could not work for Apple. Use the Apple bulk pricing modals instead.
- **Apple subscription price edits keep scheduled prices.** New prices are created before the scheduled price they replace is deleted. If the create fails, nothing is deleted. When a territory already has a scheduled price and Apple answers 409, the error names that scheduled price and asks you to clear it first and apply again (Apple uses 409 for ordinary validation errors too, so PricingKit never deletes on a 409). The result lists each territory's outcome and is not reported as a success if any territory failed.
- `?refresh=true` on the public `/api/ppp` and `/api/exchange-rates` endpoints requires a signed-in session (see upgrade notes).
- Settings no longer returns any part of an operator's `OPEN_EXCHANGE_RATES_APP_ID`. A key you saved yourself shows only its last 4 characters.
- The site and README now describe credential handling accurately: credentials are sent to the PricingKit server you use, encrypted into an HttpOnly cookie, and not stored server-side.

### Fixed

- **Editing several Apple in-app purchase territories by price point kept only the last one.** Apple's price schedule create replaces the whole schedule, and PricingKit sent one schedule per territory, each making that territory the base. It now reads the current manual prices and sends one schedule: the territories you changed, every other territory's manual prices as they were, and the product's existing base territory. A product without a schedule takes one immediate price, which becomes its base territory.
- The Apple products list and app price reader dropped the cursor from Apple's next-page link, so an app with more than one page of in-app purchases or prices re-read the first page instead of moving on. All Apple list reads now share one pagination helper that follows the next link exactly, and stop with an error rather than return a silently truncated list.

- The bulk update button on the Google subscriptions list page failed every selected subscription, because it sends no base plan. It now updates each subscription's base plans.
- Deleting a Google one-time product region price reported success without changing anything. It now removes the region. Deleting a base plan region removes exactly that region instead of re-filling the others.
- Google 400/409/412 rejections on subscription base-plan price edits and on region deletes now return Google's status and reason instead of 500.
- An Apple in-app purchase price update without a base territory price reported success without writing anything. It now fails with a 422 explaining the missing or unsupported base territory.
- Apple in-app purchase list and price read errors were shown as products without prices. They now show the real error; a product with no price yet still shows without one.
- Apple subscription read errors (auth, rate limit, server errors) were shown as "Subscription not found" or as an empty price list. They now show the real error, and a genuine 404 still shows "Subscription not found".
- The Apple subscription price-tier picker showed "No price tiers available" when loading failed. It now shows the error with a Retry button.
- A completed Apple subscription write is no longer reported as failed when only the follow-up refresh fails.
- Error messages no longer read "[object Object]", and Google-shaped errors such as `{ code: 429 }` are now treated as retryable by the shared rate-limit helper.
- Network failures while fetching a Google access token are now retried.

### Security

- Apple JWTs and Google access tokens are cached per full credential (SHA-256 of the key, 50-entry LRU). On a shared instance, two users whose keys share a Key ID or client email can no longer receive each other's token.
- Reading a session cookie without `ENCRYPTION_KEY` no longer falls back to plaintext base64 outside `next dev`; the cookie is ignored and the request is treated as signed out. Previously any build without the key, production included, would accept a plaintext base64 cookie.
- Public endpoints return generic error messages; upstream error details are logged server-side only.
