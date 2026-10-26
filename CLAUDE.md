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
  /exchange-rates/      # Open Exchange Rates API client (memory cache + best-effort disk cache)
  /world-bank/          # Live World Bank PPP data (in-memory cache)
  /conversion-indexes/  # PPP, Big Mac, Netflix indexes + FALLBACK_EXCHANGE_RATES
  /export/              # Pure transforms: store state -> versioned PriceExport, CSV
  /utils/api-error.ts   # ApiError + toApiError / getErrorStatus / isRetryableStatus
  /utils/retry.ts       # Backoff and Retry-After helpers shared by both store clients
  /utils/request-budget.ts  # RequestBudget: per-run request cap (default 3600/hour)
  /utils/rate-limit.ts  # executeWithRateLimit for bulk/batch loops
  encryption.ts         # AES-256-GCM cookie encryption, MissingEncryptionKeyError
  session.ts            # Session cookie names, hasAuthenticatedSession()
  token-cache.ts        # LRU cache for Apple JWTs / Google access tokens

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
- `appleApiRequest` and `googlePlayFetch` retry 429, 5xx and network errors with jittered exponential backoff (default 4 attempts) and honour `Retry-After` up to 60s, failing fast above that. Apple's `X-Rate-Limit` header is tracked: a 429 is not retried when it reports 0 requests remaining. Later requests are only stopped when the caller passes a `RequestBudget` (no route does yet).
- For long loops, pass a `RequestBudget` via the `budget` option. Once spent it throws `ApiError(429, 'BUDGET_EXCEEDED')` before sending. Budgets hold no module-level state, so create one per run or user.
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
- Public, no auth: Index Checker page at `/index-checker`, `GET /api/ppp` and `GET /api/exchange-rates`. Their `?refresh=true` (bypasses caches, spends upstream quota) needs a valid Google or Apple session and returns 401 otherwise.

### Currency & Pricing
- **Pricing strategies:** `'direct' | 'ppp' | 'bigmac' | 'netflix' | 'custom'` — defined in `/lib/google-play/currency.ts` (`PricingStrategy` type + `calculateRegionalPrice` switch). `custom` is kept for API compatibility but hidden in the bulk modals until per-territory multipliers exist.
- **Multiplier convention:** all indexes clamp to `[0.1, 2.0]` (live World Bank PPP included), normalized to base region (not US directly)
- **Missing exchange rates:** `getExchangeRate` never falls back to 1.0. A region without a rate gets `error: 'MISSING_EXCHANGE_RATE'` and a zero price; `filterApplicablePrices()` drops it and the UI shows "No exchange rate". Never apply a flagged price.
- **Rounding:** `calculateNewPrice` `round` rounds down to the nearest price ending at or below the current price; zero-decimal currencies (JPY, KRW, ...) get whole-number results.
- **Canonical territories:** `getSupportedAppleTerritories()` in `/lib/apple-connect/territories.ts` — use for coverage checks when adding new indexes
- **Exchange rates:** Open Exchange Rates API with caching (see above)
- **PPP multipliers:** Static `PRICING_INDEX` in `/lib/conversion-indexes/ppp.ts`; partial fallback to `FALLBACK_EXCHANGE_RATES` with UI banner when API fails
- **Apple price tiers:** Large mapping file (`price-tier-data.ts`, 400K+ lines)

### Price export
- `/lib/export` turns fetched store state into a `PriceExport` (`schemaVersion: 1`, see `types.ts`). Amounts are canonical decimal strings built without floating point; CSV is RFC 4180 with formula-injection guarding. Bump `PRICE_EXPORT_SCHEMA_VERSION` on any breaking change.
- `GET /api/export?platform=google|apple&type=inapp|subscription&id=...&basePlanId=...&format=json|csv` (`basePlanId` required for Google subscriptions). UI: `ExportPricesButton` on product and subscription detail pages.

### Adding a new pricing strategy
Touchpoints (all required, in order):
1. `/lib/conversion-indexes/<name>.ts` — data + `getXMultiplier()` + `DEFAULT_X_MULTIPLIER`
2. `/lib/google-play/currency.ts` — add to `PricingStrategy` union, `multiplierSource`, switch case in `calculateRegionalPrice`
3. `/app/api/ppp/route.ts` — surface multiplier in static + dynamic data shapes
4. UI: `/components/products/bulk-pricing-modal.tsx`, `/components/subscriptions/bulk-pricing-modal.tsx`, `/components/subscriptions/apple-subscription-bulk-pricing-modal.tsx`, `/app/index-checker/page.tsx`
5. Tests: data module + new case in `currency.test.ts`

## Testing
- Tests live in `src/**/__tests__/*.test.ts`, the only pattern `vitest.config.ts` includes.
- Never call a live store API or read real credentials. Mock `fetch` with `vi.stubGlobal('fetch', ...)` or mock store modules with `vi.mock`. Tests that need a signing key generate a throwaway one with Web Crypto.
- See `CONTRIBUTING.md` for the full conventions.

## Environment Variables

```
ENCRYPTION_KEY              # Required outside `next dev`. Encrypts credentials in cookies (openssl rand -base64 32)
OPEN_EXCHANGE_RATES_APP_ID  # Optional operator key for currency conversion; users can also save their own in Settings
```

On Cloudflare Workers set these as Worker secrets; for `npm run preview` put them in `.dev.vars`.

## Path Alias

TypeScript path alias: `@/*` maps to `src/*`

## Repo hygiene
- Do not commit planning/implementation/design `.md` files anywhere in the tree (repo root or `docs/`). Plans belong in PR descriptions, not the tree.
- Record user-visible behaviour changes in `CHANGELOG.md` under `Unreleased`.
