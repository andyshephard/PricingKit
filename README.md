![PricingKit Banner](public/banner.webp)

# PricingKit

Free, open-source regional pricing tool for the App Store and Google Play. Set PPP-adjusted prices across 175+ territories in one click. Your credentials are sent only to the server you use, kept in an encrypted HttpOnly cookie, and never stored server-side &mdash; or self-host for full control.

## Features

- **Multi-platform support** - Manage pricing for both Google Play and Apple App Store from one interface
- **Regional pricing** - View and edit in-app product pricing by region/territory
- **Subscription management** - Manage subscription base plan pricing
- **Bulk updates** - Update prices across multiple products/regions at once, with skipped items and regions reported
- **Price export** - Download a product's or subscription's current prices as CSV or JSON before you change them
- **Plan, diff, apply (library)** - Build a reviewable JSON plan of price changes, apply it idempotently within a request budget, resume a partial run and undo it from its log (see [Plans](#plans-plan-diff-apply))
- **Currency conversion** - Automatic exchange rate lookups; regions without a rate are flagged and never priced
- **Multiple pricing strategies** - PPP (World Bank), Big Mac Index or Netflix Index for regional pricing
- **Public Index Checker** - Compare regional prices across strategies at `/index-checker` (no auth required)
- **Search & filter** - Find products by SKU/product ID or name

## Getting Started

### Prerequisites

**For Google Play:**
- A Google Cloud project with a service account configured
- Service account JSON credentials with Google Play Developer API access

**For Apple App Store:**
- An App Store Connect API key (.p8 file)
- Your Issuer ID and Key ID from App Store Connect

**See the in-app setup guide** at `/setup-guide` for detailed instructions for both platforms.

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to get started.

### Production Build

```bash
npm run build
npm start
```

A production server refuses sign-in until `ENCRYPTION_KEY` is set (see [Environment Variables](#environment-variables)). Only `npm run dev` works without it.

### Deploying to Cloudflare Workers

The app is built for Cloudflare Workers with [OpenNext](https://opennext.js.org/cloudflare):

```bash
npm run preview   # build and run locally on the Workers runtime (reads .dev.vars)
npm run deploy    # build and deploy with wrangler
```

Set `ENCRYPTION_KEY` (and optionally `OPEN_EXCHANGE_RATES_APP_ID`) as Worker secrets, e.g. `npx wrangler secret put ENCRYPTION_KEY`. Workers have no filesystem, so exchange rates are cached in memory only; on Node they are also cached in `.exchange-rates.json`.

### Checks

```bash
npm test            # Vitest
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
```

CI runs all three on every pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and testing conventions, and [CHANGELOG.md](CHANGELOG.md) for behaviour changes.

## Tech Stack

- **Framework**: Next.js 16 (App Router) with TypeScript
- **Styling**: Tailwind CSS 4 + shadcn/ui
- **State**: Zustand + TanStack Query
- **Forms**: React Hook Form + Zod
- **Google Play API**: Custom `fetch` client (service-account JWT signed with Web Crypto)
- **Apple App Store Connect API**: Custom `fetch` client (ES256 JWT)
- **Hosting**: Node (`npm start`) or Cloudflare Workers via OpenNext

## Project Structure

```
bin/pricingkit.mjs        # CLI launcher (runs src/cli through tsx)
examples/github-actions/  # Example workflows to copy (not run in this repo)
src/
├── cli/                  # pricingkit CLI: export, plan, diff, offers, drift (read-only)
├── app/
│   ├── api/              # API routes (Google & Apple endpoints)
│   ├── dashboard/        # Dashboard pages
│   ├── index-checker/    # Public price index comparison tool
│   └── setup-guide/      # Setup instructions
├── components/
│   ├── ui/               # shadcn/ui components
│   ├── layout/           # Layout components
│   ├── pricing/          # Shared pricing components (bulk update, export)
│   ├── products/         # Product components
│   └── subscriptions/    # Subscription components
├── lib/
│   ├── google-play/      # Google Play API integration
│   ├── apple-connect/    # Apple App Store Connect API integration
│   ├── exchange-rates/   # Currency conversion
│   ├── world-bank/       # Live World Bank PPP data
│   ├── pricing/          # Framework-free core: strategies, indexes, Decimal money, snapping, plans, executor
│   ├── adapters/         # Apple and Google Play adapters for the plan executor
│   ├── export/           # Price export (JSON/CSV) transforms
│   └── utils/            # ApiError, retry/backoff, request budget, rate limiting
├── hooks/                # React Query hooks
└── store/                # Zustand stores
```

## Plans: plan, diff, apply

`src/lib/pricing` is a framework-free TypeScript core (no Next.js or React; a test checks the
whole import graph) that the web app and the `pricingkit` CLI share. It turns price changes into files
you can review and commit:

| File | `kind` | What it holds |
| --- | --- | --- |
| Plan | `pricingkit.changeset` | Every change a run will make. Each op names a product and territory, the price it expects to find (`before`), the price it sets (`after`) and an idempotency key. Amounts are decimal strings, never floats. |
| Run log | `pricingkit.applyRun` | Per-op status (`pending`, `ok`, `skipped`, `failed`), attempts, the store's response and the price observed before writing. |
| State | `pricingkit.state` | Current prices of one or more products. Phase 0 price exports (`schemaVersion: 1`) import as state. |

```ts
import { buildChangeSet, applyChangeSet, buildUndoChangeSet, serializeChangeSet } from '@/lib/pricing';
import { AppleAdapter } from '@/lib/adapters';
import { RequestBudget } from '@/lib/utils/request-budget';

const budget = new RequestBudget();                       // 3600 requests/hour by default
const apple = new AppleAdapter({ credentials, budget });
const product = { platform: 'apple', type: 'subscription', id: '1234567890' } as const;

const state = await apple.fetchState(product);
const { resolved } = await apple.resolvePricePoints(product, {
  GB: { currency: 'GBP', amount: '26.10' },               // snapped to a live price point
});
const plan = buildChangeSet({ app: { bundleId: 'com.example.app' }, products: [{ state, targets: resolved }] });
await writeFile('plan.json', serializeChangeSet(plan));   // review, commit

const run = await applyChangeSet(plan, { adapter: apple, budget, onUpdate: saveRunLog });
const undo = buildUndoChangeSet(plan, run);               // itself a plan to review and apply
```

- **Idempotent.** Before writing, the executor reads each product and compares every territory
  with its op: already at `after` is skipped, at `before` is applied, anything else fails with
  `STATE_CHANGED` and nothing is sent. Applying a plan twice changes nothing the second time.
- **Resumable.** Pass a saved run back as `run` and only pending or failed ops are retried. The
  run is handed to `onUpdate` before every write (marking the op as attempted) and after it, so
  a log saved before a crash still shows a write that was in flight. An attempted op found at
  its target on resume counts as done by this run (and is undone with it) instead of being sent
  again. If `onUpdate` throws, the run stops before any further write (`stoppedReason:
  PERSIST_FAILED`).
- **Budgeted.** Every request is charged to the `RequestBudget` (Apple's `X-Rate-Limit` feeds it
  too). An op starts only if the budget covers all its requests (an Apple scheduled-price
  replacement needs two); otherwise the run stops and leaves the rest pending.
- **Never guesses.** If a territory's price can't be read unambiguously (for example two future
  Apple prices), the planner skips it and the executor refuses ops on it (`STATE_CHANGED`).
- **Undoable.** The undo plan reverses every op the run applied, newest first, from the `before`
  snapshots. Apple can't remove a territory's current price, so an op that added one is listed as
  not reversible.
- **Safe with scheduled prices.** An Apple scheduled price is only deleted after its replacement
  exists.

Phase 1 covers base prices: Apple subscriptions, Google Play base plans and one-time products.
Apple in-app purchases and offers come later; their op kinds are reserved in the format.

## Command line: `pricingkit`

A read-only CLI over the same core and adapters, for scripts, CI and agents. It runs from a
clone of this repo (TypeScript runs through `tsx`; there is no build step):

```bash
npm ci
npx pricingkit --help
```

No command writes to a store. There is no `apply` command yet.

| Command | What it does |
| --- | --- |
| `export` | Current (and scheduled) prices of an App Store subscription or a Google Play base plan, as a `pricingkit.state` snapshot. `--out <file>` also writes it. |
| `plan --spec <file>` | Reads a pricing spec, snaps its targets to real store prices and writes the plan (`pricingkit.changeset`). A dry run: it only reads. The default file, `pricingkit-plan.json` (gitignored), is never replaced unless you pass `--force`; `--out <file>` names the file and replaces it. `--state-out <file>` saves the prices it planned against. |
| `diff <plan.json>` | Human-readable summary of a plan: changes per product and territory with before, after and percent change, skipped territories by reason, warnings. No store requests. |
| `offers` | An App Store subscription's introductory, promotional, offer code and win-back offers with each territory's price (`--kind` filters). |
| `drift` | Checks an App Store offer against "`--percent` of each territory's current price" (`--basis perPeriod\|totalOverDuration`, `--snap nearest\|floor\|ceil`, `--threshold`) and prints a `pricingkit.offerDrift` report. `--territories GB,US` checks only those territories: the offer's others are listed in `outOfScope` and don't count against it. |

```bash
export ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_PRIVATE_KEY_PATH=~/keys/AuthKey_XXXX.p8

npx pricingkit export --bundle-id com.example.app --subscription 1234567890 --out state.json
npx pricingkit plan --spec pricing.json --out plan.json
npx pricingkit diff plan.json
npx pricingkit offers --bundle-id com.example.app --subscription 1234567890
npx pricingkit drift --bundle-id com.example.app --subscription 1234567890 \
  --kind apple.promo --offer example_half --percent 50 --json
```

**Shared options.** `--json` prints machine-readable JSON on stdout: the document itself
(`pricingkit.state`, `pricingkit.changeset`, `pricingkit.planSummary`, `pricingkit.offers` or
`pricingkit.offerDrift`), or `{"error": {"message", "code", "status"}}` on failure. Store client
logs and the request count (when any requests were sent) go to stderr. `--budget <n>` caps the
store requests one run may send (default 1000, leaving room within App Store Connect's 3600 per
hour for anything else using the same key). Every command runs inside a `RequestBudget`, and a
spent budget stops the run with an error rather than a partial result.

**Exit codes**

| Code | Meaning |
| --- | --- |
| `0` | OK. For `plan` and `diff`: no changes. For `drift`: every territory matches. |
| `1` | Error: bad arguments, invalid spec or plan, missing credentials, a store error, or a spent request budget. |
| `2` | Something to act on: `plan`/`diff` found changes, or `drift` found the offer out of sync (any mismatch, missing, extra, unresolved or unreadable territory among those checked). |

**Credentials** come only from environment variables, never from flags or files in the repo:

| Store | Variables |
| --- | --- |
| App Store Connect | `ASC_KEY_ID`, `ASC_ISSUER_ID`, and one of `ASC_PRIVATE_KEY` (the key's PEM text; literal `\n` is accepted), `ASC_PRIVATE_KEY_HEX` (the same text hex-encoded) or `ASC_PRIVATE_KEY_PATH` (path to the key file). Select the app with `--bundle-id`. |
| Google Play | `GOOGLE_APPLICATION_CREDENTIALS` (path to a service account key file) or `GOOGLE_SERVICE_ACCOUNT_JSON` (the key JSON itself). Select the app with `--package-name`. |

A key that can't be imported is refused up front with the variable's name. The CLI holds
credentials in memory only: it never prints them, writes them to disk or logs request headers.
As a backstop, everything it prints is scrubbed of the key material it loaded, the tokens it
minted, PEM blocks, bearer tokens, Google access tokens and JWTs.

**macOS Keychain.** Keep the App Store Connect key in the login Keychain instead of a file:

```bash
# Once: store the key file's text (multi-line) as a generic password
security add-generic-password -s pricingkit-asc -a "$USER" -w "$(cat ~/Downloads/AuthKey_XXXX.p8)"
# then delete the downloaded key file

# Each session (or in a wrapper script)
export ASC_KEY_ID=... ASC_ISSUER_ID=...
export ASC_PRIVATE_KEY_HEX="$(security find-generic-password -s pricingkit-asc -a "$USER" -w)"
npx pricingkit offers --bundle-id com.example.app --subscription 1234567890
```

`security find-generic-password -w` prints a secret that contains newlines (like a PEM key) as
hex, which is why the recipe uses `ASC_PRIVATE_KEY_HEX`. If you stored the key on one line, it
prints as text: use `ASC_PRIVATE_KEY` instead. To turn the hex back into text yourself, pipe it
through `xxd -r -p`. Note that `add-generic-password -w <value>` puts the key on that command's
argument list for a moment; run it on a machine you trust.

**Pricing spec** (`pricingkit.spec`, version 1, JSON). `plan` reads the products' current prices,
turns the targets into per-territory amounts and snaps them: on the App Store to each territory's
own price points (`snap`, default `nearest`), on Google Play through Play's price conversion (a
read-only call). The spec never names price point IDs.

```json
{
  "kind": "pricingkit.spec",
  "schemaVersion": 1,
  "app": { "bundleId": "com.example.app" },
  "description": "Spring price review",
  "products": [
    {
      "product": { "platform": "apple", "type": "subscription", "id": "1234567890" },
      "targets": { "type": "fixed", "prices": { "GB": "4.99", "US": "5.99", "CA": { "amount": "7.99", "currency": "CAD" } } },
      "snap": "nearest"
    },
    {
      "product": { "platform": "apple", "type": "subscription", "id": "1234567891" },
      "targets": { "type": "percentOfCurrent", "percent": "110", "territories": "all" },
      "startDate": "2030-06-01"
    }
  ]
}
```

- `targets.type: "fixed"`: these territories get these prices (alpha-2 keys). A bare amount is
  in the territory's current currency; give `{ "amount", "currency" }` for a territory without one.
- `targets.type: "percentOfCurrent"`: each territory's current price times `percent` / 100
  (`"110"` is a 10% rise; above 0, at most 1000, up to 4 decimals), for `"all"` priced
  territories or a list.
- Optional per product: `snap` (App Store), `startDate` (App Store: schedule instead of changing
  now), `allowNewTerritories` (default `false`: never price a territory that has no price),
  `preserveCurrentPrice` (App Store, default `true`).
- Products: App Store subscriptions (numeric App Store Connect ID), Google Play base plans
  (`{ "platform": "google", "type": "subscription", "productId", "basePlanId" }`) and one-time
  products (`{ "platform": "google", "type": "inapp", "productId" }`). All products must belong to
  the spec's `app`.

**In CI.** [`examples/github-actions/drift.yml`](examples/github-actions/drift.yml) is a weekly
scheduled drift check using repository secrets: it opens (or comments on) an issue and fails the
job when an offer drifts. It is an example to copy into your own repository; it does not run here.

## Environment Variables

Create a `.env.local` file (optional):

```env
# Encrypts credentials in the session cookie. Required everywhere except `next dev`
# (generate with: openssl rand -base64 32)
ENCRYPTION_KEY=your-secure-random-string

# Open Exchange Rates API key (for currency conversion)
OPEN_EXCHANGE_RATES_APP_ID=your-api-key

# Optional: header your proxy sets to the real client IP, used to rate-limit
# anonymous Open Exchange Rates key tests per client. Leave unset unless every
# request passes through that proxy (clients can forge these headers):
#   cf-connecting-ip (Cloudflare, incl. Workers), x-real-ip, or x-forwarded-for (last entry used)
# Unset, anonymous key tests share a per-instance cap instead.
# TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip
```

## Security

- Credentials are sent to the PricingKit server you are using (the hosted instance or your own), encrypted with `ENCRYPTION_KEY` (AES-256-GCM), and stored only in an HttpOnly cookie
- The server does not persist credentials; it decrypts them in memory per request to call the Apple/Google APIs
- Short-lived API tokens (Apple JWTs, Google access tokens) are cached in memory, keyed by a hash of the full credential
- Without `ENCRYPTION_KEY`, sign-in is refused (except under `next dev`)
- Sessions expire after 24 hours
- Using a hosted instance means trusting its operator with your credentials; self-host for full control

See [SECURITY.md](SECURITY.md) for the full credential-handling model and how to report a vulnerability.

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

This means you are free to use, modify, and distribute this software, but any derivative works must also be open-sourced under GPL-3.0.

## Support

PricingKit is free and always will be. If you find it useful, consider buying me a coffee!

<a href="https://www.buymeacoffee.com/andyshephard" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>
