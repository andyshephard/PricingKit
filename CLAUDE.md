# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PricingKit is a Next.js application for managing in-app product and subscription pricing across Google Play Store and Apple App Store. It enables developers to view, edit, and bulk-update pricing by region with currency conversion and PPP (Purchasing Power Parity) adjustment support.

## Commands

```bash
npm run dev          # Start development server (http://localhost:3000)
npm run build        # Production build
npm start            # Start production server
npm run lint         # Run ESLint
```

## Architecture

### Tech Stack
- **Framework:** Next.js 16 (App Router) with TypeScript
- **UI:** Tailwind CSS 4 + shadcn/ui (New York style) + Radix UI
- **State:** Zustand (client state with localStorage persistence) + TanStack React Query (server state)
- **Forms:** React Hook Form + Zod validation
- **APIs:** googleapis (Google Play), custom JWT client (Apple App Store Connect)

### Key Directories

```
/src/app/api/           # API routes - Google Play and Apple endpoints
  /products             # Google Play products CRUD
  /subscriptions        # Google Play subscriptions
  /apple/               # Apple App Store routes (parallel structure)
  /bulk                 # Bulk price update operations
  /exchange-rates       # Currency conversion endpoint
  /ppp                  # PPP calculation endpoint

/src/lib/
  /google-play/         # Google Play Developer API integration
  /apple-connect/       # Apple App Store Connect API (JWT auth, price tiers)
  /exchange-rates/      # Open Exchange Rates API client with disk cache
  /conversion-indexes/  # PPP multipliers, Big Mac Index data

/src/hooks/             # React Query hooks for products/subscriptions
/src/store/             # Zustand stores (auth-store, selection-store)
/src/components/ui/     # shadcn/ui components
```

### Data Flow & State Management

**No database** - stateless architecture:
- Session credentials stored encrypted in HTTP-only cookies (24-hour expiry)
- Exchange rates cached to disk (`.exchange-rates.json`, 6-hour TTL)
- Dev sessions persisted to `.sessions.json`
- Client auth state persisted to localStorage via Zustand

**API Authentication:**
- Google Play: Service account JSON credentials
- Apple: JWT with private key (.p8 file), issuer ID, and key ID

### API Route Patterns
- RESTful: `GET/PATCH/DELETE /api/products/[sku]`
- Platform-specific: `/api/products` (Google) vs `/api/apple/products` (Apple)
- Error codes: 401 (auth), 403 (permission), 404 (not found), 429 (rate limit)

### Currency & Pricing
- **Exchange rates:** Open Exchange Rates API with caching
- **PPP multipliers:** Static `PRICING_INDEX` in `/lib/conversion-indexes/ppp.ts`
- **Apple price tiers:** Large mapping file (`price-tier-data.ts`, 400K+ lines)

## Environment Variables

```
ENCRYPTION_KEY           # For encrypting credentials in cookies (recommended)
OPEN_EXCHANGE_RATES_APP_ID  # API key for currency conversion
```

## Path Alias

TypeScript path alias: `@/*` maps to `src/*`
