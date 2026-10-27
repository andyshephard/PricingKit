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
npx pricingkit --help  # Read-only CLI (src/cli, launched by bin/pricingkit.mjs through tsx)
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

/src/cli/               # pricingkit CLI (read-only): args, commands/, credentials (env only), redact
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
- **Plans** (`changeset.ts`): `ChangeSet` (`kind: pricingkit.changeset`, `schemaVersion: 1`) of `BasePriceOp`s (`setPrice`, `schedulePrice`, `deleteScheduled`, `removePrice`), each with `before`, `after` and `idempotencyKey` (`computeIdempotencyKey`). `parseChangeSet` enforces one op per product/territory/slot, Apple ops naming a price point, and matching keys. Offer, availability and cohort kinds are reserved and refused until their phase. Bump `CHANGESET_SCHEMA_VERSION` on breaking changes.
- **Executor** (`executor.ts`): reads each product once, then skips ops already at `after`, applies ops at `before`, and fails anything else with `STATE_CHANGED` without sending. Resume by passing the saved `ApplyRun`; undo with `buildUndoChangeSet`. The run is published to `onUpdate` before every write (attempt recorded) and after; a failed save stops the run (`PERSIST_FAILED`). A unit starts only if the budget covers `adapter.requestsNeeded()` plus in-flight reservations. A slot the adapter flags in `TerritoryPriceState.problems` is never planned or applied against. Adapters (`adapter.ts`) implement `fetchState`, `resolvePricePoints`, `apply`, optional `applyMany`/`batchKey`, and `inverse`.
- **Apple adapter**: subscriptions only in Phase 1. Reads prices with `listSubscriptionPriceEntries` (relationships only, no fallbacks; two future prices in a territory become a problem, never a pick). Snaps to each territory's live price points (`listSubscriptionPricePointsByTerritory`, limit 8000, territory from the relationship). A scheduled price is replaced create-first, delete-after; a budget refusal on the delete fails the op. `startDate` is always `YYYY-MM-DD`.
- **Offers (Phase 2a, read-only)** (`offers.ts`, `offer-derivation.ts`): `OfferSpec` (kinds `apple.intro|promo|offerCode|winBack`, `play.offer` reserved), ISO durations (`P1Y`; Apple enums map via `appleDurationToIso`), and the `StoreOffer` read model. `deriveOfferPrices` applies `percentOfCurrent` per territory: `current x percent` (`perPeriod`) or `x offerDuration/billingPeriod` (`totalOverDuration`; weeks vs months is refused), snapped to that territory's own ladder (ties lower) against the exact fraction (percent has at most 4 decimals), with flags (`NOT_BELOW_CURRENT`, `NO_PRICE_POINT`, deviation above 5% as a warning; weeks vs months skip the below-current check with `SPAN_NOT_COMPARABLE`). Without a basis, pay-up-front offers use `totalOverDuration` (`defaultOfferBasis`). `AppleAdapter.checkOfferDrift`/`previewOffer` refuse a free trial, unknown mode/duration or an impossible ratio before reading base prices or ladders. `checkOfferDrift` returns a JSON `pricingkit.offerDrift` report (match/mismatch/missing/extra/unresolved/unreadable). No plan op creates or edits offers yet; the ChangeSet offer kinds stay reserved.
- **Apple offer reads** (`lib/apple-connect/offers.ts`, `AppleAdapter.fetchOffers/fetchOffer/previewOffer/checkOfferDrift`): offer lists without `include=prices` (capped at 50), then each offer's `/prices` list (limit 200, paginated) with `include=territory,subscriptionPricePoint`. Territory, price point and currency come only from relationships and included resources; anything missing is a `territoryProblems`/`problems` entry. Intro offers (one resource per territory) are grouped by their terms. Routes: `GET /api/apple/subscriptions/[id]/offers` and `.../offers/drift` (numeric subscription ID, one `RequestBudget` per request).
- **Apple IAP schedules**: `POST /inAppPurchasePriceSchedules` replaces the whole schedule. Change prices with `replaceInAppPurchaseManualPrices` (one schedule, other territories kept), never one POST per territory. **Play adapter**: base plans and one-time products; snapping via `convertRegionPrices`; one PATCH per product.

### CLI (`src/cli`, Phase 5a, read-only)
- `bin/pricingkit.mjs` registers `tsx` (CJS and ESM hooks, the repo's tsconfig for `@/`) and runs `src/cli/main.ts`; `npx pricingkit` works from the repo. No build step. `runCli(argv, io)` is the testable entry and never throws.
- Commands: `export`, `plan --spec`, `diff`, `offers`, `drift`. **There is no `apply`**; don't add one without the approval flow planned for it. `plan` receives only a `PriceReader` (`fetchState` + `resolvePricePoints`, see `readOnly()` in `context.ts`), so it can't reach `apply`. Google's `convertRegionPrices` is a POST but read-only.
- Imports the core and the adapters directly. No Next, React, `@/app`, `@/middleware` or `@/lib/session` (ESLint rule plus the CLI walk in `core-boundary.test.ts`).
- Exit codes (`errors.ts`): 0 OK, 1 error (usage, spec/plan, credentials, store, budget), 2 drift or a plan with ops. `--json` prints the document itself on stdout, or `{ error: { message, code, status } }`. All other output, including the store clients' `console.*` logging, goes to stderr while a command runs.
- Credentials only from env (`credentials.ts`): `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` | `ASC_PRIVATE_KEY_PATH`; `GOOGLE_APPLICATION_CREDENTIALS` | `GOOGLE_SERVICE_ACCOUNT_JSON`. Never add credential flags, never write credentials to disk, never quote key files or JSON parse errors in messages. Every value goes to the `Redactor` (`redact.ts`), which scrubs every stdout/stderr write (secrets, their lines, PEM blocks, bearer tokens, JWTs).
- One `RequestBudget` per command run (`--budget`, default 3600), passed to the adapter.
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
