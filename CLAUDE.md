# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PricingKit is a Next.js application for managing in-app product and subscription pricing across Google Play Store and Apple App Store. It enables developers to view, edit, bulk-update and export pricing by region with currency conversion and multiple pricing strategies: PPP (World Bank), Big Mac Index and Netflix Index (a `custom` multiplier strategy exists in code but is hidden in the UI).

## Commands

```bash
npm run dev          # Start development server (http://localhost:3000)
npm run build        # Production build
npm start            # Start production server
npm run lint         # Run ESLint
npm run typecheck    # tsc --noEmit
npm test             # Run Vitest test suite
npm test -- <path>   # Run specific test file(s)
npm run preview      # OpenNext build, run locally on the Cloudflare Workers runtime
npm run deploy       # OpenNext build, deploy to Cloudflare Workers
npx pricingkit --help  # CLI (src/cli, launched by bin/pricingkit.mjs through tsx); only `apply` writes, with --confirm
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm test`, `npm run typecheck` and `npm run lint` on Node 22 (`.nvmrc`) for every PR and every push to `main`. Run all three locally before committing.

## Architecture

### Tech Stack
- **Framework:** Next.js 16 (App Router) with TypeScript; deployed to Cloudflare Workers via `@opennextjs/cloudflare`, also runs on Node with `npm start`
- **UI:** Tailwind CSS 4 + shadcn/ui (New York style) + Radix UI
- **State:** Zustand (client state with localStorage persistence) + TanStack React Query (server state)
- **Forms:** React Hook Form + Zod validation
- **APIs:** hand-rolled `fetch` clients, no store SDKs (there is no `googleapis` dependency). Google Play: service-account JWT signed with Web Crypto and exchanged for an OAuth access token (`googlePlayFetch` in `/lib/google-play/client.ts`). Apple: ES256 JWT (`appleApiRequest` in `/lib/apple-connect/client.ts`).

### Key Directories

```
/src/app/api/           # API routes - Google Play and Apple endpoints
  /auth, /active-app    # Google sign-in and app switch (read-only store calls)
  /products             # Google Play products CRUD
  /subscriptions        # Google Play subscriptions
  /apple/               # Apple App Store routes (parallel structure)
    /_lib/error-response.ts  # appleErrorResponse(): ApiError -> JSON with upstream status
  /bulk                 # Bulk price update operations (Google only)
  /export               # Read-only price export (GET, JSON/CSV)
  /exchange-rates       # Currency conversion endpoint (public)
  /ppp                  # PPP calculation endpoint (public)
  /settings             # User-supplied Open Exchange Rates key

/src/lib/
  /google-play/         # Google Play Developer API integration
  /apple-connect/       # Apple App Store Connect API (JWT auth, price tiers)
  /pricing/             # Framework-free core (see "Pricing core" below)
    strategies.ts       # PricingStrategy + calculateRegionalPrice (was google-play/currency.ts)
    rounding.ts         # applyRounding, roundDownToPriceEnding, currencyScale
    /indexes/           # PPP, Big Mac, Netflix indexes + FALLBACK_EXCHANGE_RATES
    decimal.ts, snap.ts # String-backed Decimal money; snapping to price points
    model.ts, changeset.ts, diff.ts, inverse.ts, state.ts   # Plan files
    executor.ts, run.ts, adapter.ts, concurrency.ts         # Apply, run log, undo
  /adapters/            # AppleAdapter, PlayAdapter (store I/O for the executor)
  /exchange-rates/      # Open Exchange Rates API client (memory cache + best-effort disk cache)
  /world-bank/          # Live World Bank PPP data (in-memory cache)
  /export/              # Pure transforms: store state -> versioned PriceExport, CSV
  /utils/api-error.ts   # ApiError + toApiError / getErrorStatus / isRetryableStatus
  /utils/retry.ts       # Backoff and Retry-After helpers shared by both store clients
  /utils/request-budget.ts  # RequestBudget: per-run request cap (default 3600/hour)
  /utils/rate-limit.ts  # executeWithRateLimit for bulk/batch loops
  /utils/attempt-limiter.ts  # In-memory per-client limiter (anonymous OER key tests)
  /apple-connect/pagination.ts  # appleListPages / appleListAll: the one links.next loop
  encryption.ts         # AES-256-GCM cookie encryption, MissingEncryptionKeyError
  session.ts            # Session cookie names and lifetime, hasAuthenticatedSession()
  token-cache.ts        # LRU cache for Apple JWTs / Google access tokens

/src/cli/               # pricingkit CLI: args, commands/, credentials (env only), redact; `apply` is its only write
/bin/pricingkit.mjs     # CLI launcher (tsx)
/examples/github-actions/  # Example workflows for users' repos (not active here)
/src/middleware/auth.ts # The only place routes get credentials: getGoogleAuthFromCookies,
                        # getAppleAuthFromCookies, getAppleSessionFromCookies
/src/hooks/             # React Query hooks for products/subscriptions
/src/store/             # Zustand stores (auth-store, selection-store)
/src/components/ui/     # shadcn/ui components
```

### Data Flow & State Management

**No database** - stateless architecture:
- Session credentials stored encrypted (AES-256-GCM, key derived from `ENCRYPTION_KEY`) in HTTP-only cookies (24-hour expiry). Sessions are cookie-only; nothing is written server-side.
- `ENCRYPTION_KEY` is required everywhere except `next dev`. Without it (outside `next dev`), creating a session throws `MissingEncryptionKeyError` and reading a session cookie returns null (treated as signed out); login checks `canStoreSessions()` before any store call. Only under `next dev` (`NODE_ENV=development`) is a plaintext base64 cookie allowed.
- Short-lived store tokens (Apple JWTs, Google access tokens) are cached in memory in a 50-entry LRU keyed by a SHA-256 of the full credential, so users of a shared instance never share a token.
- Exchange rates: in-memory cache with a 6-hour TTL; stale data is served if the API fails. On Node the client also tries `.exchange-rates.json` in the working directory. Cloudflare Workers has no filesystem, so that step silently no-ops and only the per-isolate memory cache applies.
- Client auth state persisted to localStorage via Zustand

**API Authentication:**
- Google Play: Service account JSON credentials
- Apple: JWT with private key (.p8 file), issuer ID, and key ID
- Login (`/api/auth`, `/api/apple/auth`) and app switching (`/api/active-app`) only issue GET requests to the stores. Do not add a write "permission probe": a missing write permission surfaces on the first real edit.

### Store API errors, retries and budgets
- Both clients throw subclasses of `ApiError` (`AppleApiError`, `GooglePlayApiError`) shaped `{ status, code?, platform, retryable, details? }`. Normalise unknown errors with `toApiError()`; never `String(err)` (it yields `[object Object]`).
- `appleApiRequest` and `googlePlayFetch` retry 429, 5xx and network errors with jittered exponential backoff (default 4 attempts) and honour `Retry-After` up to 60s, failing fast above that. Apple POSTs (creates) retry only 429, and their other failures are `retryable: false`, because a create that timed out or got a 5xx may already exist. Apple's `X-Rate-Limit` header is tracked: a 429 is not retried when it reports 0 requests remaining. Later requests are only stopped when the caller passes a `RequestBudget` (no route does yet).
- For long loops, pass a `RequestBudget` via the `budget` option. Once spent it throws `ApiError(429, 'BUDGET_EXCEEDED')` before sending. Budgets hold no module-level state, so create one per run or user.
- Every store helper in `lib/apple-connect` and `lib/google-play` takes an optional trailing `ctx: RequestContext` (`{ budget }`) and passes it to every request it makes, including pagination and the app lookup. New helpers must do the same. The bulk routes (Apple subscription PATCH, price-points/batch, clear-scheduled, Apple IAP PATCH, `/api/bulk`) create one `RequestBudget` per request.
- No unbounded `Promise.all` over store requests: use `mapWithConcurrency` (`lib/pricing/concurrency.ts`). Apple list reads use `appleListPages`/`appleListAll`; never hand-roll a `links.next` loop (it must keep the cursor).
- Apple routes map the `ApiError` status through `appleErrorResponse` (401/403/404/409/429/5xx) instead of a blanket 404/500. The Google subscription base-plan PATCH and the Google region DELETEs (product and base plan) pass Google's 400/409/412 through. Public endpoints return generic messages and log the raw error server-side. Other Google detail-route errors still become a 500 carrying the upstream message.

### Store write rules
- Google region edits change only the regions passed in. Everything else (other regions, availability, `newSubscriberAvailability`, other base plans) is sent back exactly as fetched. Never fill in missing regions, force availability on, or invent prices. `regionsVersion` comes from the fetched resource; the constants in `products.ts` / `subscriptions.ts` are fallbacks only.
- Region delete removes exactly one region. If Google refuses, its reason is passed through to the client.
- Apple subscription price edits create the new price before deleting the scheduled price it replaces, and report per-territory outcomes.
- Bulk results report skipped items and regions. A run that wrote nothing is a failure, not "Successfully updated 0 items". A subscription item without `basePlanId` expands to one result per base plan (`total` counts results); a subscription with no base plans, or an unknown `basePlanId`, is a failed item.
- `/api/export` is read-only: the route may import only store read functions (enforced by `src/app/api/export/__tests__/route.test.ts`).

### API Route Patterns
- RESTful: `GET/PATCH/DELETE /api/products/[sku]`
- Platform-specific: `/api/products` (Google) vs `/api/apple/products` (Apple)
- Error codes: 401 (auth), 403 (permission), 404 (not found), 422 (e.g. Apple IAP update without a base territory price), 429 (rate limit)
- Routes get credentials only from `@/middleware/auth`; never define a cookie helper in a route file or import one from another route (`src/app/api/__tests__/auth-helpers.test.ts`).
- Public, no auth: Index Checker page at `/index-checker`, `GET /api/ppp` and `GET /api/exchange-rates`. Their `?refresh=true` (bypasses caches, spends upstream quota) needs a valid Google or Apple session and returns 401 otherwise. Saving an Open Exchange Rates key (`POST /api/settings/exchange-rates`) tests it upstream; without a session that is limited to 50 per instance per 10 minutes, and 5 per client when `TRUSTED_CLIENT_IP_HEADER` is set. Under `next dev` a plaintext session cookie can be forged to skip the limit (dev only).

### Currency & Pricing
- **Pricing strategies:** `'direct' | 'ppp' | 'bigmac' | 'netflix' | 'custom'` — defined in `/lib/pricing/strategies.ts` (`PricingStrategy` type + `calculateRegionalPrice` switch). Import from `@/lib/pricing`. `custom` is kept for API compatibility but hidden in the bulk modals until per-territory multipliers exist.
- **Multiplier convention:** all indexes clamp to `[0.1, 2.0]` (live World Bank PPP included), normalized to base region (not US directly)
- **Missing exchange rates:** `getExchangeRate` never falls back to 1.0. A region without a rate gets `error: 'MISSING_EXCHANGE_RATE'` and a zero price; `filterApplicablePrices()` drops it and the UI shows "No exchange rate". Never apply a flagged price.
- **Rounding:** `calculateNewPrice` `round` rounds down to the nearest price ending at or below the current price; zero-decimal currencies (JPY, KRW, ...) get whole-number results.
- **Canonical territories:** `getSupportedAppleTerritories()` in `/lib/apple-connect/territories.ts` — use for coverage checks when adding new indexes
- **Exchange rates:** Open Exchange Rates API with caching (see above)
- **PPP multipliers:** Static `PRICING_INDEX` in `/lib/pricing/indexes/ppp.ts`; partial fallback to `FALLBACK_EXCHANGE_RATES` with UI banner when API fails
- **Apple price tiers:** Large mapping file (`price-tier-data.ts`, 400K+ lines)

### Price export
- `/lib/export` turns fetched store state into a `PriceExport` (`schemaVersion: 1`, see `types.ts`). Amounts are canonical decimal strings built without floating point; CSV is RFC 4180 with formula-injection guarding. Bump `PRICE_EXPORT_SCHEMA_VERSION` on any breaking change.
- `GET /api/export?platform=google|apple&type=inapp|subscription&id=...&basePlanId=...&format=json|csv` (`basePlanId` required for Google subscriptions). UI: `ExportPricesButton` on product and subscription detail pages.

### Pricing core (`src/lib/pricing`)
- **Framework-free.** No `next`, `react`, web-app, adapter or network imports, directly or transitively. `src/lib/pricing/__tests__/core-boundary.test.ts` walks the import graph; an ESLint rule blocks direct imports. Only `zod` is allowed as a package. Store I/O belongs in `src/lib/adapters`.
- **Money is Decimal strings** (`decimal.ts`), compared and computed on BigInt-scaled integers. `decimalFromNumber()` is the only float-to-Decimal boundary (strategy output). Never put a JS number amount in a plan, run or state file.
- **Plans** (`changeset.ts`): `ChangeSet` (`kind: pricingkit.changeset`, `schemaVersion: 1`) of `BasePriceOp`s (`setPrice`, `schedulePrice`, `deleteScheduled`, `removePrice`), each with `before`, `after` and `idempotencyKey` (`computeIdempotencyKey`). `parseChangeSet` enforces one op per product/territory/slot, Apple ops naming a price point, and matching keys. Offer ops (`offer-ops.ts`) are the other op shape in `ops` (`ChangeOp = BasePriceOp | OfferOp`; read base ops with `basePriceOps()`). Availability and cohort kinds are reserved and refused until their phase. Bump `CHANGESET_SCHEMA_VERSION` on breaking changes.
- **Executor** (`executor.ts`): reads each product once, then skips ops already at `after`, applies ops at `before`, and fails anything else with `STATE_CHANGED` without sending. Resume by passing the saved `ApplyRun`; undo with `buildUndoChangeSet`. The run is published to `onUpdate` before every write (attempt recorded) and after; a failed save stops the run (`PERSIST_FAILED`). A unit starts only if the budget covers `adapter.requestsNeeded()` plus in-flight reservations. A slot the adapter flags in `TerritoryPriceState.problems` is never planned or applied against. Adapters (`adapter.ts`) implement `fetchState`, `resolvePricePoints`, `apply`, optional `applyMany`/`batchKey`, and `inverse`; for offers, optional `fetchOffers`, `applyOffer` and `offerRequestsNeeded`.
- **Apple adapter**: subscriptions only in Phase 1. Reads prices with `listSubscriptionPriceEntries` (relationships only, no fallbacks; two future prices in a territory become a problem, never a pick). Snaps to each territory's live price points (`listSubscriptionPricePointsByTerritory`, limit 8000, territory from the relationship). A scheduled price is replaced create-first, delete-after; a budget refusal on the delete fails the op. `startDate` is always `YYYY-MM-DD`.
- **Offers (Phase 2a, read-only)** (`offers.ts`, `offer-derivation.ts`): `OfferSpec` (kinds `apple.intro|promo|offerCode|winBack`, `play.offer` reserved), ISO durations (`P1Y`; Apple enums map via `appleDurationToIso`), and the `StoreOffer` read model. `deriveOfferPrices` applies `percentOfCurrent` per territory: `current x percent` (`perPeriod`) or `x offerDuration/billingPeriod` (`totalOverDuration`; weeks vs months is refused), snapped to that territory's own ladder (ties lower) against the exact fraction (percent has at most 4 decimals), with flags (`NOT_BELOW_CURRENT`, `NO_PRICE_POINT`, deviation above 5% as a warning; weeks vs months skip the below-current check with `SPAN_NOT_COMPARABLE`). Without a basis, pay-up-front offers use `totalOverDuration` (`defaultOfferBasis`). `AppleAdapter.checkOfferDrift`/`previewOffer` refuse a free trial, unknown mode/duration or an impossible ratio before reading base prices or ladders. `checkOfferDrift` returns a JSON `pricingkit.offerDrift` report (match/mismatch/missing/extra/unresolved/unreadable). Pay-up-front promotional offer prices are the total for the whole duration (confirmed on a real account: `totalOverDuration` drift of a 1-year offer on an annual subscription matched every territory).
- **Apple offer reads** (`lib/apple-connect/offers.ts`, `AppleAdapter.fetchOffers/fetchOffer/previewOffer/checkOfferDrift`): offer lists without `include=prices` (capped at 50), then each offer's `/prices` list (limit 200, paginated) with `include=territory,subscriptionPricePoint`. Territory, price point and currency come only from relationships and included resources; anything missing is a `territoryProblems`/`problems` entry. Intro offers (one resource per territory) are grouped by their terms. Routes: `GET /api/apple/subscriptions/[id]/offers` and `.../offers/drift` (numeric subscription ID, one `RequestBudget` per request).
- **Offer ops (Phase 2b)** (`offer-ops.ts`, `offer-plan.ts`): `createOffer`, `updateOfferPrices` (promotional offers only), `deactivateOffer`/`activateOffer` (offer codes: `active`; intro and win-back: end date; never promos), `deleteOffer` (never offer codes: the API has no DELETE). Each op targets `{ product, offer: { kind, key } }` with `before`/`after` `OfferState` (terms + per-territory prices) and `computeOfferIdempotencyKey`. Offers are found by key (promo `offerCode`, offer code `name`, win-back `offerId`); intro offers by `introOfferKey` (terms + start date) and judged territory by territory (`classifyOfferOp`), so a half-done intro create resumes with only the missing territories. `planOfferChanges` (pure) and `AppleAdapter.planOffers` (reads) turn `OfferSpec`s into a ChangeSet plus `OfferPlanEntry` previews (derivation rows, changes, refusals: `PROMO_OFFER_CAP` (10), `TERMS_IMMUTABLE`, `PRICES_IMMUTABLE`, `MISSING_SETTINGS`, overlapping intro windows as `OFFER_CONFLICT` skips). `pricingkit.offerPlanSpec` holds several offers (e.g. one per product); keys must be unique per kind. `planOfferLifecycle` plans end/reactivate/delete. Re-pricing never removes a territory. The executor applies offer ops only with `confirm === changeSetHash(plan)` (`ConfirmationRequiredError` before any read), and `deleteOffer` only with `force.deleteOffers` (`REDEMPTIONS_UNCHECKED`: the API reports no redemptions). Undo also reverses offer ops that failed after an attempt was sent (they may have taken effect) and lists caveats in `notReversible` (redeemed codes, deleted offers' history).
- **Apple offer writes** (`lib/apple-connect/offer-writes.ts`, `AppleAdapter.applyOffer`): bodies follow OpenAPI 4.5.1 and are checked against `src/lib/apple-connect/__tests__/fixtures/offer-write-requests.schema.json` (derived from the spec: names, required fields, enums). Inline prices use local IDs `${price-<alpha3>}` (confirmed on a test app for promo creates). A promo price replace sends the full list (Apple replaces the whole list with it: confirmed, see Testing): unchanged territories by their price ID (`StoreOffer.priceRefs`), the rest inline. Refusals are rewritten by `explainOfferRefusal` (status and code kept; a spent budget stays `BUDGET_EXCEEDED`). Routes: `POST .../offers/plan` (reads only) and `POST .../offers/apply` (promotional offer creates and price updates only, `op.target.offer.kind === 'apple.promo'`, on this subscription, signed-in app, `confirm` = plan hash). The web flow keeps nothing server-side and has no resume or undo; the dialog offers the plan and run log as downloads (named `<plan id>.json` / `.run.json`, the CLI's defaults) and shows the CLI `apply --resume` and `undo` commands.
- **App ownership** (`lib/apple-connect/ownership.ts`): API keys are team-wide, so every write path checks the subscription belongs to the app: `SubscriptionOwnership` resolves the app by exact bundle ID (`GET /apps?filter[bundleId]`), its groups (`GET /apps/{id}/subscriptionGroups`) and the subscription's group (`GET /subscriptions/{id}?include=group`; spec 4.5.1 has no group -> app relationship). `AppleAdapter.verifyProduct` runs it in `planOffers`/`planOfferLifecycle`, and the executor calls `adapter.verifyProduct` per product before reading or writing (`APP_MISMATCH`, 409). The offer routes check up front; the subscription PATCH/DELETE and clear-scheduled routes use `assertSubscriptionInApp` (DELETE also requires the price to be the subscription's). The in-app purchase and app price routes are scoped by construction (the product is found by SKU in the session app's own list; the price schedule names the session app), pinned by tests.
- **Intro offer resources:** an intro create records `createdIds` (territory -> resource ID) in the run log, also on a partial failure (`partialResponse` on the error). Resume and verify use them; undo deletes only those resources (`OfferState.storeRefs`) and lists territories with no recorded ID as not reversible. Without IDs, an intro offer is found by terms + start date, and "no offer with these terms but an overlapping one" is drift, never done. Undo skips an offer create only when its single attempt was refused with a 4xx (after a timeout, a later 409 keeps it in undo). A resume that finds intro territories of a create already in place after an attempt adds their IDs to `createdIds` (`foundOnResume`), so undo deletes them. The confirm-mismatch error never includes the plan's hash (executor, route, CLI); `plan` and `diff` print it. `src/app/api/__tests__/write-routes-auth.test.ts` checks every write route takes credentials from the session.
- **Sync engine (Phase 4)** (`offer-sync.ts`, `AppleAdapter.readRuleProducts/planOfferSync/checkRulesDrift`): rules live in a checked-in `pricingkit.offerRules` v1 file (`parseOfferRules`: product, kind, key (offer key or store ID), `pricing` percentOfCurrent with optional basis (defaults by mode), `territories`, `syncWithBase`, `deviationThreshold`; Apple only, Play refused until Phase 3; one entry per offer). `planOfferSync` re-derives `syncWithBase` offers against `projectBasePrices(state, baseOps)` (setPrice targets; schedulePrice only under `deriveNow`), only in territories the offer already has, and appends `updateOfferPrices` ops after the base plan's ops (same IDs) with `dependsOn` = that product's base ops in scope. Offer codes, win-back and intro offers that would change, missing/unreadable offers, free trials, and offers over scheduled base ops under the default `scheduledBase: 'hold'` become `ChangeSet.manualActions` (`PRICES_IMMUTABLE`, `OFFER_NOT_FOUND`, `OFFER_UNREADABLE`, `RULE_NOT_APPLICABLE`, `BASE_SCHEDULED`); never an op that deletes or re-creates. `checkRulesDrift` returns `pricingkit.rulesDrift` (inSync/drifted/notFound/error per offer). Executor: all base-price units run before any offer unit; an offer op whose `dependsOn` has a failed op fails `BASE_NOT_APPLIED` (nothing sent), and waits (stays pending) if one didn't run. `checkChangeSetRules` requires `dependsOn` to name base ops of the same product.
- **Apple IAP schedules**: `POST /inAppPurchasePriceSchedules` replaces the whole schedule. Change prices with `replaceInAppPurchaseManualPrices` (one schedule, other territories kept), never one POST per territory. **Play adapter**: base plans and one-time products; snapping via `convertRegionPrices`; one PATCH per product.

### CLI (`src/cli`, Phase 5a; `apply` from Phase 2b)
- `bin/pricingkit.mjs` registers `tsx` (CJS and ESM hooks, the repo's tsconfig for `@/`) and runs `src/cli/main.ts`; `npx pricingkit` works from the repo. No build step. `runCli(argv, io)` is the testable entry and never throws.
- Commands: `export`, `plan --spec` / `plan --rules [--spec] [--scheduled-base hold|now]`, `diff` (groups base and offer ops, lists manual actions), `offers`, `drift` / `drift --rules` (exit 2 on drifted or missing offers, else 1 on uncheckable ones), `apply`, `undo` (offline: plan + run log -> undo plan file, `--out`/`--force`; prints hash and not-reversible items). `plan` receives only a `PriceReader` (`fetchState` + `resolvePricePoints`, see `readOnly()` in `context.ts`) or, for a `pricingkit.offerPlanSpec`, an `OfferPlanner` (`planOffers` only), or for `--rules` an `OfferSyncPlanner` (`planOfferSync` only), so it can't reach a write. Google's `convertRegionPrices` is a POST but read-only.
- `apply <plan.json> --confirm <hash>` is the only write: App Store offer plans only, `--confirm` must equal `changeSetHash` (checked before any store request; the error never prints the hash), the run log is saved atomically (temp file + rename) on every update to `--run-out` (default `<plan>.run.json` in the plan file's directory, not the working directory; an existing file is replaced only when resumed in place or with `--force`; `--resume <run.json>` continues it), deletes need `--force-delete`. Exit 0 when complete, 1 otherwise. Don't widen it to base-price plans until the Apple base-price assumptions below are confirmed (the test-app checks so far covered offer writes only); a combined `plan --spec --rules` plan is refused with how to ship it instead (base prices in the web app, then `plan --rules` alone).
- Imports the core and the adapters directly. No Next, React, `@/app`, `@/middleware` or `@/lib/session` (ESLint rule plus the CLI walk in `core-boundary.test.ts`).
- Exit codes (`errors.ts`): 0 OK, 1 error (usage, spec/plan, credentials, store, budget), 2 drift or a plan with ops. `--json` prints the document itself on stdout, or `{ error: { message, code, status } }`. All other output, including the store clients' `console.*` logging, goes to stderr while a command runs.
- Credentials only from env (`credentials.ts`): `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` | `ASC_PRIVATE_KEY_HEX` | `ASC_PRIVATE_KEY_PATH`; `GOOGLE_APPLICATION_CREDENTIALS` | `GOOGLE_SERVICE_ACCOUNT_JSON`. Keys are test-imported with Web Crypto up front (`CliError` naming the variable). Never add credential flags, never write credentials to disk, never quote key files or JSON parse errors in messages (the core parsers say only "not valid JSON"). Every value goes to the `Redactor` (`redact.ts`), which scrubs every stdout/stderr write (secrets, their lines, PEM blocks, bearer tokens, `ya29.` tokens, JWTs). While a command runs, `withTokensRedacted` (main.ts) wraps `fetch` to register minted bearer tokens, Google's assertion and `access_token` too.
- Report the message of anything thrown with `errorMessage()` (handles plain objects). Store clients must throw `ApiError` subclasses, never plain objects.
- One `RequestBudget` per command run (`--budget`, default 1000), passed to the adapter. The request-count line is printed only when requests were sent.
- `plan` never replaces the default `pricingkit-plan.json` (gitignored) without `--force`; an explicit `--out` replaces.
- `drift --territories` (and the API route's `territories`) scopes the check: other offer territories go to `outOfScope`, never `extra`, and don't affect `inSync`.
- Spec format: `src/lib/pricing/spec.ts` (`pricingkit.spec` v1, JSON, zod). Targets `fixed` or `percentOfCurrent`; `specTargets()` is pure. Bump `PRICING_SPEC_SCHEMA_VERSION` on breaking changes.
- CLI tests (`src/cli/__tests__`) run in-process against `fake-apple.ts`, `fake-apple-offers.ts` and a Play fake with `appleApiRequest`/`googlePlayFetch` mocked; the redaction tests use the real clients with a stubbed `fetch` and throwaway keys.
- `examples/github-actions/drift.yml` is documentation only; never copy it into `.github/workflows` here.

### Adding a new pricing strategy
Touchpoints (all required, in order):
1. `/lib/pricing/indexes/<name>.ts` — data + `getXMultiplier()` + `DEFAULT_X_MULTIPLIER`
2. `/lib/pricing/strategies.ts` — add to `PricingStrategy` union, `multiplierSource`, switch case in `calculateRegionalPrice`
3. `/app/api/ppp/route.ts` — surface multiplier in static + dynamic data shapes
4. UI: `/components/products/bulk-pricing-modal.tsx`, `/components/subscriptions/bulk-pricing-modal.tsx`, `/components/subscriptions/apple-subscription-bulk-pricing-modal.tsx`, `/app/index-checker/page.tsx`
5. Tests: data module + new case in `src/lib/pricing/__tests__/strategies.test.ts`

## Testing
- Tests live in `src/**/__tests__/*.test.ts`, the only pattern `vitest.config.ts` includes.
- Never call a live store API or read real credentials. Mock `fetch` with `vi.stubGlobal('fetch', ...)` or mock store modules with `vi.mock`. Tests that need a signing key generate a throwaway one with Web Crypto.
- Reset mocks in a block-bodied `beforeEach(() => { mock.mockReset(); })`. vitest runs a function returned from `beforeEach` as a teardown, so `beforeEach(() => mock.mockReset())` calls the mock again after each test.
- Plan and executor tests use the in-memory `FakeStore` (`src/lib/pricing/__tests__/fixtures`); adapter tests use `src/lib/adapters/__tests__/fake-apple.ts` or a mocked `googlePlayFetch`.
- Offer write tests use `fake-apple-offer-store.ts` (stateful promo/intro/offer code/win-back endpoints, failure injection incl. "took effect, then errored").
- **Confirmed on a real account (read-only, Oct 2026):** free-trial intro offer prices have no price point (read as free); a pay-up-front promotional offer's price is the total for its whole duration; offer list/price reads, strict relationships, pagination and budget work as built. Creating a 175-territory promotional offer in one request (inline `${...}` price IDs) worked outside PricingKit.
- **Confirmed on a test app with PricingKit writes (Oct 2026):**
  1. Inline local price IDs (`${price-<alpha3>}`) work for promotional offer creates.
  2. The promotional offer price PATCH **replaces** the whole price list with the one sent: after the PATCH the offer had 175 prices and no duplicates.
  3. A promotional offer create can answer a transient 500 having created nothing. Resume re-read the offer, didn't find it and created it once (the design: creates retry only 429, and a resume looks the offer up by key before sending).
  4. The confirm gate, idempotent re-apply (`ALREADY_AT_TARGET`), undo of a re-price, and undo of a create all worked. Undoing a create was refused with `REDEMPTIONS_UNCHECKED` without `--force-delete` and deleted the offer with it.
- **Not yet confirmed (check in the write test against a test app):** what `duration` means for pay-as-you-go offers; the 10-active-promotional-offer cap; whether free-trial prices are accepted without a price point on create; the win-back inline price relationships (the spec lists none on `WinBackOfferPriceInlineCreate`); whether Apple accepts an end date in the past or reuse of a deleted offer's key; intro window end dates as exclusive; whether an intro offer created without a start date reads back with one (startDate read-back; the fake can simulate it with `fillIntroStartDate`). `fake-apple-offer-store.ts` encodes the PATCH-replaces and cap assumptions.
- `fake-apple.ts` encodes guesses about App Store Connect that are **not verified against a real account**: that an immediate subscription price create replaces the territory's older active entries, and that a scheduled price can be created while another exists (create-then-delete). Treat tests relying on them as unverified until checked against a test app (planned for Phase 2b).
- See `CONTRIBUTING.md` for the full conventions.

## Environment Variables

```
ENCRYPTION_KEY              # Required outside `next dev`. Encrypts credentials in cookies (openssl rand -base64 32)
OPEN_EXCHANGE_RATES_APP_ID  # Optional operator key for currency conversion; users can also save their own in Settings
TRUSTED_CLIENT_IP_HEADER    # Optional: proxy header with the real client IP (cf-connecting-ip, x-real-ip, x-forwarded-for).
                            # Only set it when every request passes that proxy; never trust client IP headers otherwise.
```

On Cloudflare Workers set these as Worker secrets; for `npm run preview` put them in `.dev.vars`.

## Path Alias

TypeScript path alias: `@/*` maps to `src/*`

## Repo hygiene
- Do not commit planning/implementation/design `.md` files anywhere in the tree (repo root or `docs/`). Plans belong in PR descriptions, not the tree.
- Record user-visible behaviour changes in `CHANGELOG.md` under `Unreleased`.
