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
- **Google Play offers** - List, plan, preview, apply, resume and undo Play subscription offers: phases (free, relative or absolute discount, fixed price), eligibility (new customers, upgrades, developer-determined), offer tags and regions (see [Google Play offers](#google-play-subscription-offers))
- **Offers in step with base prices** - A checked-in rules file says which offers follow which rule (App Store: "X% of each territory's price"; Google Play: also Play's own discounts and fixed prices); and sync plans re-price them against new base prices (see [sync](#keeping-offers-in-step-with-base-prices-sync))
- **Headless** - A `pricingkit` CLI (JSON or YAML specs, `--json` output, exit codes for CI) and an MCP server so agents can plan while people apply (see [Command line](#command-line-pricingkit))
- **Currency conversion** - Automatic exchange rate lookups; regions without a rate are flagged and never priced
- **Multiple pricing strategies** - PPP (World Bank), Big Mac Index, Netflix Index or your own per-territory multipliers (Custom) for regional pricing
- **Pricing quality** - Target what you receive (proceeds, net of tax and commission) instead of the customer price; every planned change says what existing subscribers see (decrease, new subscribers only, notified, or needs consent); reference data shows its age and stale PPP data is capped or inflated (see [Pricing quality](#pricing-quality))
- **Several apps, both stores** - A workspace file covers several App Store bundles and Google Play packages: one command plans, diffs, applies and undoes for all of them, one plan per app. Parity mappings tie an App Store subscription to a Play base plan so one target drives both, and `pricingkit parity` reports where their prices differ (see [Workspaces](#workspaces-several-apps-and-both-stores))
- **CSV prices** - Export base prices and offers per territory as a versioned CSV, edit them in a spreadsheet, and plan them back as fixed targets, checked against real price points (see [Prices CSV](#prices-csv))
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
src/
├── cli/                  # pricingkit CLI: export, plan, diff, offers, offer, parity, apply (--confirm), undo, mcp
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

### Apple subscription offers

Offers use the same plan files. An offer op (`createOffer`, `updateOfferPrices`,
`deactivateOffer`, `activateOffer`, `deleteOffer`) names the offer by its key (promotional offer
code, offer code name, win-back offer ID) and carries the offer's terms and price in every
territory before and after. Plan them from an offer spec; several products go in one spec, each
with its own key (Apple needs promotional offer codes to be unique across a subscription group):

```json
{
  "kind": "pricingkit.offerPlanSpec", "schemaVersion": 1, "app": { "bundleId": "com.example.app" },
  "offers": [{
    "id": "example_annual_50", "name": "Half off a year", "kind": "apple.promo",
    "productRef": { "platform": "apple", "type": "subscription", "id": "1234567890" },
    "mode": "PAY_UP_FRONT", "duration": "P1Y", "territories": "all", "syncWithBase": true,
    "pricing": { "type": "percentOfCurrent", "percent": "50", "basis": "totalOverDuration", "snap": "nearest" }
  }]
}
```

```ts
const plan = await apple.planOffers({ app, offers: spec.offers });   // reads only
// plan.entries: per-territory preview, refusals; plan.hash: what an apply must confirm
const run = await applyChangeSet(plan.changeSet, { adapter: apple, budget, confirm: plan.hash });
```

- Each territory's price is that territory's own current price times the rule, snapped to its own
  price points. A pay-up-front offer's price covers its whole duration.
- Applying needs `confirm` set to the plan's hash; nothing is read or sent otherwise.
- Offers are found by key, so a create that errored but took effect is recognised on resume and
  never sent twice. Introductory offers (one store resource per territory) resume territory by
  territory, and territories with an overlapping introductory offer are left out.
- The planner refuses what App Store Connect would refuse: an 11th promotional offer, changing an
  existing offer's duration, mode or periods, re-pricing an offer code or win-back offer.
- Deleting an offer needs `force: { deleteOffers: true }`: App Store Connect's API doesn't report
  redemptions. Offer codes can't be deleted at all; undo deactivates them, and codes already
  redeemed stay redeemed.

On an Apple subscription page, the Offers card can create a promotional offer from a rule and
re-price an existing one to a rule, with the same preview and a confirm step. That is all the web flow does:
promotional offer creates and re-prices only. It keeps nothing and can't resume or undo, so
download the plan (`<plan>.json`) and, after applying, the run log (`<plan>.run.json`) from the
dialog. With them the CLI can:

- resume an incomplete run: `pricingkit apply <plan>.json --confirm <hash> --resume <plan>.run.json`
- undo it: `pricingkit undo <plan>.json <plan>.run.json` writes `<plan>.undo.json`; review it, then
  `pricingkit apply <plan>.undo.json --confirm <its hash> --force-delete`

Use the CLI for every other offer kind too.

### Google Play subscription offers

A Play offer belongs to one base plan and is found by its offer ID. It has one or two phases, each
priced per region with one of: Play's relative discount (`"0.5"` = 50% off, follows the base price
by itself), an absolute discount, a fixed price, or free. Its eligibility is a new-customer rule
("never had any subscription in the app" / "never had this subscription"), an upgrade rule, or
none (developer-determined: the app decides who sees it). Tags (`offerTags`) are passed to the app
by the billing library, for example for RevenueCat (`rc-customer-center`, `rc-ignore-offer`).

Plan Play offers with the same offer plan spec, for a `packageName` app. Eligibility is always
spelled out: PricingKit never assumes one.

```json
{
  "kind": "pricingkit.offerPlanSpec", "schemaVersion": 1, "app": { "packageName": "com.example.app" },
  "offers": [
    {
      "id": "annual-half-off", "kind": "play.offer",
      "productRef": { "platform": "google", "type": "subscription", "productId": "com.example.pro", "basePlanId": "annual" },
      "mode": "PAY_UP_FRONT", "duration": "P1Y", "territories": "all", "syncWithBase": false,
      "pricing": { "type": "play.relativeDiscount", "fraction": "0.5" },
      "eligibility": { "type": "play.targeting", "rule": { "type": "developerDetermined" } },
      "tags": ["rc-customer-center", "rc-ignore-offer"]
    },
    {
      "id": "new-customer-trial", "kind": "play.offer",
      "productRef": { "platform": "google", "type": "subscription", "productId": "com.example.pro", "basePlanId": "annual" },
      "mode": "FREE_TRIAL", "duration": "P1W", "territories": "all", "syncWithBase": false,
      "pricing": { "type": "free" },
      "eligibility": { "type": "play.targeting", "rule": { "type": "acquisition", "scope": "anySubscriptionInApp" } }
    }
  ]
}
```

- **One phase per spec offer.** `PAY_UP_FRONT` is one recurrence of `duration`, `PAY_AS_YOU_GO`
  is `periods` recurrences of `duration`, `FREE_TRIAL` is free. Existing two-phase offers are read,
  listed and kept in step, but a spec creates single-phase offers only.
- **Pricing:** `play.relativeDiscount` (native: follows the base price), `play.absoluteDiscount`
  (`amounts` per region, in the region's currency), `fixed` (`prices` per region) or
  `percentOfCurrent` (each region's own base price times the percent, prorated over the phase,
  made a valid price by Play's own price conversion and written as a fixed price). `snap` doesn't
  apply on Play.
- **Eligibility:** `{ "type": "developerDetermined" }`, `{ "type": "acquisition", "scope":
  "anySubscriptionInApp" | "thisSubscription" }` or `{ "type": "upgrade", "scope": "thisSubscription" |
  { "specificSubscriptionInApp": "<product id>" }, "billingPeriodDuration"?, "oncePerUser"? }`.
- **Regions:** `"all"` is every region of the base plan. The offer is open to new subscribers
  where the base plan is, and not in locations Play launches later (no `otherRegionsConfig`).
- **State:** a created offer is activated (`play.state: "DRAFT"` leaves it a draft). A planned
  offer that already matches and is a draft or inactive is activated.
- **Preview:** `pricingkit plan` prints each offer's eligibility, phases and tags, and per region the
  base price, the base price over the phase, the offer price (an estimate for discounts: Play works
  those out itself) and the discount. Regions it can't price are listed and left out.
- **Changes:** an existing offer is patched (prices, eligibility, tags); regions the spec leaves
  out keep their price. Changing its phase durations or recurrences is refused: create a new offer ID.
  The preview and `pricingkit diff` show the state, eligibility and tags before and after, and the
  plan warns by name ("removes tag rc-ignore-offer", "eligibility A → B"). A spec that leaves out
  a tag the offer has is refused (`TAG_REMOVAL`) unless it sets `"play": { "allowTagRemoval": true }`.
- **Relative discounts** are the share taken off, as the Android Publisher reference describes
  `relativeDiscount` ("a value of 0.8 represents an 80% discount"). Until that is confirmed on a test
  app, the plan warns for any fraction other than 0.5.
- **Percent of current** regions where Play's price is further from the target than
  `play.deviationThreshold` (default `"0.05"`; `deviationThreshold` in a rules file) are left out,
  and `pricingkit plan` exits 1. Fixed prices and amounts off may not have more decimals than the
  region's currency.
- **Lifecycle (library):** `PlayAdapter.planOfferLifecycle` plans activating, deactivating or
  deleting one offer. Play deletes draft offers only, and deleting needs `force.deleteOffers`
  (CLI `--force-delete`): it is irreversible.
- **Undo:** a created (active) offer is deactivated, never deleted (Play deletes drafts only); a
  draft the run created but couldn't activate is deleted; patches are reversed; a deactivation is
  re-activated.
- **Safety:** the same as for App Store offers: `confirm` must be the plan's hash, ops are found by
  offer ID so a create that took effect is never sent twice (creates and activations are retried on
  429 only, never after a 5xx or a timeout; a failed create counts as "may have applied" and the next
  read or a resume decides; a create answered with 409 counts only if the existing offer is exactly
  the planned one; one whose activation failed resumes with the activation alone; undo deletes the
  draft a failed create may have left, and lists an activation that got no answer as not
  reversible), runs resume and undo, and every request is charged to the budget. A plan for
  another package is refused with `APP_MISMATCH` before anything is read, and every base plan is
  checked to be one of the app's.
- **Strict reads:** anything Play returns that PricingKit can't hold exactly (an unknown field, a
  region priced two ways, a phase that misses a region) is shown as a problem, and such an offer is
  never written to.

```bash
export GOOGLE_APPLICATION_CREDENTIALS=~/keys/service-account.json
npx pricingkit offers --package-name com.example.app --subscription com.example.pro [--base-plan annual]
npx pricingkit plan --spec play-offers.json --out play-plan.json
npx pricingkit apply play-plan.json --confirm <hash>
```

The web app lists a subscription's Play offers (read-only) on its page under the base plans.

Before reading or writing a subscription, PricingKit checks it belongs to the plan's app (its
group must be one of the app's subscription groups). App Store Connect API keys work across a
team's apps, so a subscription ID copied from another app is refused with `APP_MISMATCH`.

### Keeping offers in step with base prices (sync)

Apple offer prices are absolute: when a base price changes, an offer priced at "50% of each
territory's price" no longer is. The stores don't record an offer's rule, so you keep the rules in
a file in your repository and PricingKit uses it to re-derive the offers:

```json
{
  "kind": "pricingkit.offerRules", "schemaVersion": 1, "app": { "bundleId": "com.example.app" },
  "offers": [{
    "product": { "platform": "apple", "type": "subscription", "id": "1234567890" },
    "kind": "apple.promo", "key": "example_annual_50",
    "pricing": { "type": "percentOfCurrent", "percent": "50", "basis": "totalOverDuration", "snap": "nearest" },
    "syncWithBase": true
  }]
}
```

- `key` is the offer's key as `pricingkit offers` lists it (promotional offer code, offer code
  name, win-back offer ID, or an introductory offer's key) or its store ID. `basis` may be left out:
  pay-up-front offers then use `totalOverDuration`, others `perPeriod`. Optional: `territories`
  (default: all of the offer's), `deviationThreshold` (default `"0.05"`).
- `syncWithBase: false` keeps an offer out of sync plans.
- **Google Play** (a rules file for a `packageName` app, `kind: "play.offer"`, `product` the base
  plan, `key` the offer ID). `pricing` may also be `play.relativeDiscount` (`fraction`),
  `play.absoluteDiscount` (`amounts`) or `fixed` (`prices`); `phase` (1 or 2) says which phase of a
  two-phase offer the rule prices (default: the only one that isn't free).
  - `play.relativeDiscount` follows the base price by itself: sync lists the offer as "follows
    base automatically" (it plans a patch only if the store's fraction differs from the rule).
  - `percentOfCurrent` offers have fixed prices, so they go out of step when a base price changes;
    sync re-derives them against the new base prices (Play's price for each region's target: about one
    request per region) and patches the phase prices.
  - `fixed` and `play.absoluteDiscount`: sync patches the prices or amounts back to the rule and
    leaves (and lists) a region where they are no longer below the base price. An absolute
    discount keeps the same amount off a new base price.
  - Play has no scheduled base prices, so `--scheduled-base` doesn't apply.

**Sync plans.** `pricingkit plan --rules offer-rules.json` re-derives every `syncWithBase` offer
against the current base prices and plans `updateOfferPrices` for the ones out of step, for
example right after base prices changed. A plan with no ops means every synced offer is in step.
With a base-price spec, `pricingkit plan --spec pricing.json --rules offer-rules.json` plans both in one file: the
base-price ops, then offer ops re-derived against the prices that plan sets (not today's). Each
offer op lists the base ops of its product it depends on (`dependsOn`):

- The executor applies every base-price op before any offer op. If a base op an offer op depends
  on fails (or the price moved since planning), the offer op fails with `BASE_NOT_APPLIED` and
  nothing is sent for it; a resume applies it once the base ops are done.
- Undo goes the other way round: the undo plan of a sync run reverts the offer first, and its
  base-price reverts depend on that (`OFFER_NOT_APPLIED` and nothing sent if the offer revert
  fails), so a base price is never reverted under an offer still priced from the new one.
- Sync only changes prices of territories the offer already has. A territory the rule can't price
  keeps its offer price and is listed as skipped.
- Only promotional offers can be re-priced. Offer codes, win-back offers and introductory offers
  whose prices no longer match are listed under "Needs manual action" (`manualActions` in the plan)
  with what to do, such as "create a new offer code at the new prices and deactivate this one".
  PricingKit never deletes or re-creates an offer by itself. Missing offers, unreadable ones and
  rules on free trials are listed there too.
- **Scheduled base prices** (a spec `startDate`): an offer's new prices apply as soon as the plan
  is applied, so re-deriving an offer against a base price that starts in June would charge the
  June-based offer price from today. By default sync **holds** those territories: they keep their
  offer price and are named in a `BASE_SCHEDULED` manual action saying to sync again on or after
  the date. The offer's other territories, with immediate
  base changes, are still re-priced in the same plan, waiting only for those immediate changes. `--scheduled-base now` re-derives them against the scheduled prices anyway,
  with a warning in the plan. A base price already scheduled in the store is warned about too: the
  offer will be out of step when it takes effect.
- `pricingkit diff` shows base prices and offers in separate groups, in the order they are
  applied, and lists the manual actions.

**Applying.** `pricingkit apply` applies a `plan --rules` plan like any offer plan. A combined
plan (`--spec` with `--rules`) also changes base prices, so it needs `--allow-base-prices` as well
(see [base prices from the CLI](#base-prices-from-the-cli)); it is applied in the order above. The
library (`applyChangeSet`) applies combined plans the same way.

```ts
import { parseOfferRules } from '@/lib/pricing';

const rules = parseOfferRules(await readFile('offer-rules.json', 'utf8'));
const sync = await apple.planOfferSync({ rules, base: basePlan, states }); // reads only
// sync.changeSet: base ops, then offer ops; sync.manualActions: what needs a person
```

## Command line: `pricingkit`

A CLI over the same core and adapters, for scripts, CI and agents. It runs from a
clone of this repo (TypeScript runs through `tsx`; there is no build step):

```bash
npm ci
npx pricingkit --help
```

Only `apply` writes to a store, and only with `--confirm <plan hash>`.

| Command | What it does |
| --- | --- |
| `export` | Current (and scheduled) prices of an App Store subscription or a Google Play base plan, as a `pricingkit.state` snapshot. `--in-app <product id>` exports an App Store in-app purchase (manual and automatic prices, scheduled ones and the price schedule's base territory) or a Google Play one-time product (its first purchase option) instead. `--out <file>` also writes it. |
| `plan --spec <file>` | With an offer plan spec (`pricingkit.offerPlanSpec`), plans creating or re-pricing App Store offers and prints the plan hash. Otherwise: reads a pricing spec, snaps its targets to real store prices and writes the plan (`pricingkit.changeset`). A dry run: it only reads. The default file, `pricingkit-plan.json` (gitignored), is never replaced unless you pass `--force`; `--out <file>` names the file and replaces it. `--state-out <file>` saves the prices it planned against. |
| `diff <plan.json>` | Human-readable summary of a plan: changes per product and territory with before, after and percent change, skipped territories by reason, warnings. No store requests. |
| `offers` | An App Store subscription's introductory, promotional, offer code and win-back offers with each territory's price (`--kind` filters); or a Google Play subscription's offers (`--package-name`, `--base-plan` for one base plan) with state, eligibility, tags and each phase's price per region. |
| `offer deactivate\|activate\|delete` | Plans one lifecycle change of an existing offer and writes it as a plan file (default `pricingkit-plan.json`, never replaced without `--force`; or `--out`). App Store: `--bundle-id --subscription --kind --offer <key>`; deactivating an introductory or win-back offer sets its end date (`--end-date`). Google Play: `--package-name --subscription --base-plan --offer <offer id>`. What the store doesn't allow (deactivating a promotional offer, deleting an offer code or an active Play offer) is refused with the reason. Reads only; prints the `apply` command. |
| `apply <plan.json> --confirm <hash>` | Applies a plan, App Store or Google Play (the app named in the plan). `--confirm` must be the plan's hash (shown by `plan` and `diff`). Saves the run log before and after every write (`--run-out`, default `<plan>.run.json` next to the plan file, never overwritten) and continues one with `--resume <run.json>`. Deleting offers needs `--force-delete`; a plan that changes base prices needs `--allow-base-prices` (see [base prices from the CLI](#base-prices-from-the-cli)). |
| `undo <plan.json> <run.json>` | Writes the plan that undoes a run (`--out`, default `<plan>.undo.json` next to the plan file, replaced only with `--force`) and prints its summary, hash and anything that can't be reversed. Offline: no credentials, no store requests. Apply it with `apply --confirm`, plus `--force-delete` when it deletes offers. |
| `plan --rules <rules.json> [--spec <spec.json>]` | Plans keeping `syncWithBase` offers in step: against current base prices, or with `--spec`, against the prices that base-price plan sets (one plan, base ops first). `--scheduled-base hold\|now` (default `hold`). Offers the store can't re-price are listed as manual actions. |
| `plan --workspace <file>` | Plans every app of a [workspace](#workspaces-several-apps-and-both-stores): one plan file per app (and per offer plan spec) plus a `workspace-plan.json` index with one hash, in `--out-dir` (default `pricingkit-plans`). |
| `diff/apply/undo --workspace-plan <index>` | The same commands across a workspace plan: every plan under its app, applied in order (each with its own adapter and run log; `--resume-runs` continues), undone newest first. |
| `parity --workspace <file>` | Compares the App Store and Google Play prices of every mapped subscription per territory (read-only); exit 2 on a gap above the threshold. |
| `export ... --format csv [--offers]` | Current prices (and with `--offers`, offer prices) as a [prices CSV](#prices-csv); `--workspace <file>` exports every product a workspace names. |
| `mcp` | Runs an [MCP server](#agents-pricingkit-mcp) over stdio for agents: read and plan tools, and a tool that returns the `apply` command for a person to run. |

Spec and rules files may be JSON or YAML (a `.yaml` / `.yml` name); plans, run logs and state
files are always JSON.

```bash
export ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_PRIVATE_KEY_PATH=~/keys/AuthKey_XXXX.p8

npx pricingkit export --bundle-id com.example.app --subscription 1234567890 --out state.json
npx pricingkit plan --spec pricing.json --out plan.json
npx pricingkit diff plan.json
npx pricingkit offers --bundle-id com.example.app --subscription 1234567890
npx pricingkit plan --spec pricing.yaml --rules offer-rules.yaml --out plan.json
npx pricingkit apply plan.json --confirm <hash from diff> --allow-base-prices
npx pricingkit export --bundle-id com.example.app --in-app com.example.app.coins
npx pricingkit offer deactivate --bundle-id com.example.app --subscription 1234567890 \
  --kind apple.offerCode --offer SPRING50 --out end-spring.json
```

### Workspaces: several apps and both stores

A workspace (`pricingkit.workspace` v1, JSON or YAML) lists apps on both stores. Each app names
its own spec, rules file and offer plan spec (paths relative to the workspace file, inside the
working directory), or gives its spec products inline. Parity mappings tie an App Store
subscription to a Google Play base plan:

```yaml
kind: pricingkit.workspace
schemaVersion: 1
apps:
  - id: ios
    app: { bundleId: com.example.app }
    spec: pricing/ios.yaml          # a pricingkit.spec
    rules: pricing/ios-rules.yaml   # a pricingkit.offerRules (optional)
    offers: pricing/ios-offers.yaml # a pricingkit.offerPlanSpec (optional)
  - id: android
    app: { packageName: com.example.app }
    products:                       # or the spec's products inline
      - product: { platform: google, type: subscription, productId: pro, basePlanId: monthly }
        targets: { type: percentOfCurrent, percent: "105" }
parity:
  - id: annual
    apple: { bundleId: com.example.app, subscription: "1234567890" }
    play: { packageName: com.example.app, subscription: pro, basePlan: annual }
    target: { type: strategy, strategy: ppp, base: { amount: "49.99" } }
    baseTerritory: US               # per product, never app-wide
    threshold: "0.05"               # parity gap allowed, a fraction of the lower price
```

**One plan per app, not one combined plan.** `plan --workspace` writes an ordinary plan file per
app (`<id>.json`: its spec and rules, like `plan --spec --rules`) and one per offer plan spec
(`<id>.offers.json`), plus `workspace-plan.json`, an index listing them in apply order with each
plan's app and hash and one workspace hash over them all. We chose this over one plan whose ops
each carry their app because every safety check PricingKit has is per plan and per app: a plan's
hash covers its app, `apply` builds the adapter for that app only and the executor refuses
another app's plan (`verifyApp`) or product (`verifyProduct`), run logs, resume and undo work per
plan, and the plan format stays the one older PricingKit versions read. A plan never holds ops for
two apps, so no op can run with another app's credentials, and `diff --workspace-plan` lists
every app the run will touch before the per-app details.

- `apply --workspace-plan <index> --confirm <workspace hash>` checks, before anything is read,
  that every plan file still has the hash the index records and is for the app it lists, and that
  every app passes the `PRICINGKIT_EXPECT_*` pins. It then applies the plans one by one (each with
  its own run log next to it) and stops at the first that doesn't complete. `--resume-runs`
  continues from the logs, after checking each log belongs to the plan next to it (a log of an
  earlier plan with the same file name is refused with `INVALID_RUN` before anything is read);
  `--force` replaces them, and with them the record `undo` needs. One request budget covers all
  the plans of a run.
- Planning a workspace again into the same `--out-dir` needs `--force`; the earlier plans' run
  logs and undo plans are then moved aside to `<file>.stale-<timestamp>`, never deleted.
- `undo --workspace-plan <index>` writes an undo plan per applied plan, newest first, and
  `<index>.undo.json` next to the input to apply the same way.
- The pins take lists: `PRICINGKIT_EXPECT_BUNDLE_ID=com.example.app,com.example.other`.
- Credentials stay per store: one App Store Connect key (`ASC_*`) for every bundle and one
  service account (`GOOGLE_*`) for every package. Products are checked to belong to their app
  before their prices are read (App Store Connect keys reach every app of a team).
- **Parity.** Each mapping with a `target` adds that target to both apps' specs; each store snaps
  it separately (App Store price points, Play's price conversion). The plan output ends with the
  parity report on the planned prices; `pricingkit parity --workspace` reports the current ones,
  read-only. Per territory: `same`, `withinThreshold`, `gap` (exactly: the difference is more
  than the threshold times the lower price), `notComparable` (the stores bill different
  currencies; never converted), `appleOnly`, `playOnly` or `unreadable`. A mapping is in parity,
  has GAPS (exit 2), or is NOT CHECKED (exit 1) when a territory couldn't be compared or none is
  priced on both stores; territories priced on one store only are listed in the headline. Prices are
  compared as each store lists them (both stores show tax-inclusive prices in most territories
  and tax-exclusive ones in a few, such as the United States).

### Prices CSV

`pricingkit export ... --format csv [--offers]` (or `--workspace <file> --format csv`) writes a
`pricingkit.prices` CSV. The web app's "Export prices" menu offers the same file ("CSV for import").

```csv
# pricingkit.prices v1
app,platform,product_type,product,base_plan,offer_kind,offer_key,territory,currency,price,proceeds
com.example.app,apple,subscription,1234567890,,,,GB,GBP,44.99,36.62
com.example.app,apple,subscription,1234567890,,apple.promo,retention_half,GB,GBP,22.99,18.71
com.example.app,google,basePlan,pro,annual,,,GB,GBP,49.99,
```

| Column | Meaning |
| --- | --- |
| `app` | Bundle ID or package name |
| `platform` | `apple` or `google` |
| `product_type` | `subscription` or `inAppPurchase` (App Store), `basePlan` or `oneTime` (Google Play). Optional on import (inferred); in-app purchase rows are refused on import, since plans don't cover App Store in-app purchases |
| `product` | App Store: numeric subscription (or in-app purchase) ID. Google Play: product ID |
| `base_plan` | Google Play base plan ID (empty on the App Store and for one-time products) |
| `offer_kind`, `offer_key` | Empty for a base price; otherwise the offer's kind and key (promo offer code, offer code name, win-back offer ID, Play offer ID) |
| `territory`, `currency`, `price` | ISO alpha-2, ISO 4217 and the customer price as a plain decimal |
| `proceeds` | Information only (App Store proceeds); ignored on import |

The first line names the format and version; columns may come in any order. Exported offers are
every App Store offer and Google Play offers with a single phase priced per region.

Import by naming the file in a spec: `targets: { type: fixed, pricesFile: prices.csv }` in a
`pricingkit.spec` product, or `pricing: { type: fixed, pricesFile: offers.csv }` in an offer plan
spec offer (not introductory offers, which have no key). The rows for that app, product (and
offer) become the fixed prices; the plan then snaps them like any target and lists every row that
wasn't planned exactly as written: snapped to another valid price, or not imported and why (also
as plan warnings, so `diff` shows them). An offer row whose currency isn't the territory's is
refused. The file gets the same checks as `multipliersFile` (relative to the spec, inside the
working directory, a regular file) and a 5 MB cap. Errors give the line and column, never a
cell's contents. The export's spreadsheet formula guard (a leading `'`) is removed on import.
Exporting and importing an unchanged file plans no changes.

### Base prices from the CLI

`pricingkit apply --allow-base-prices` applies plans that change base prices (from a
`pricingkit.spec`, a combined `plan --spec --rules`, or the undo plan of such a run), with the
same safety model as offers: `--confirm` with the plan hash, checked before anything is read; the
run log saved before and after every write; `--resume`; `undo` (whose plan needs the same flag);
the subscription checked to belong to the plan's app (`APP_MISMATCH`); the
`PRICINGKIT_EXPECT_*` pins; and, in a combined plan, offers applied only once the base prices they
were derived from are in place. Without the flag, a plan with base-price ops is refused before any
store request.

**Before relying on it for the App Store, try it on a test app.** Two App Store Connect behaviours
it relies on are not yet confirmed against a real account: that an immediate price change replaces
the territory's older price entries, and that a second scheduled price can be created before the
old one is deleted (PricingKit creates the new scheduled price first and deletes the old one only
once it exists). The executor re-reads every territory before writing and refuses anything
ambiguous (for example two future prices), so the failure mode is a refused or unverified op,
not a silent wrong price; but run a small plan on a test app first. Google Play base plans and
one-time products don't have this caveat.

## Pricing quality

These options go on a product entry of a `pricingkit.spec` (`plan --spec`), unless noted.

**Proceeds targets.** `"measure": "proceeds"` makes `fixed` and `strategy` targets mean what you
receive, net of VAT/tax and the store's commission, instead of the customer price
(`percentOfCurrent` keeps meaning the customer price).
- App Store: each territory snaps to the price point whose `proceeds` (as App Store Connect reports
  it for the subscription's price points) is nearest the target; `snap` applies to proceeds.
  **Unconfirmed:** that figure is Apple's per-price-point proceeds, which may not reflect your
  rate. It may not include the App Small Business Program's 15%, or the lower rate on a
  subscription's second year (price points also report `proceedsYear2`, which PricingKit doesn't
  use). Check a few territories against App Store Connect before relying on proceeds targets.
- Google Play: Play reports tax but not its fee, so PricingKit asks Play's price conversion for
  `target / (1 - commission)` as the tax-exclusive price. `"commission"` defaults to `"0.15"` (Play's
  rate for subscriptions, and for the first US$1M a year of one-time products in the 15% tier); set
  `"0.30"` if that is your rate. Play proceeds are estimates: (price - tax) x (1 - commission).

Plans record per op the proceeds before and after (Apple) or the estimated proceeds and Play's tax
(`priceChanges` in the plan file), and `pricingkit diff` shows Proceeds and Tax columns.

These are **planner notes, not covered by the plan hash**: anyone can edit them without changing
the hash you confirm. `pricingkit diff` marks them as such. It recomputes the existing-subscriber
class of every immediate price change from the op itself (before, after, `preserveCurrentPrice`),
shows that value, and prints a WARNING where the stored note disagrees. Scheduled changes show the
stored class marked "(unverified)", because the op doesn't hold the current price. Plans that
carry notes are schema version 2; PricingKit reads versions 1 and 2, with the same hash for both.

```json
{ "product": { "platform": "google", "type": "subscription", "productId": "pro", "basePlanId": "annual" },
  "targets": { "type": "strategy", "strategy": "ppp", "base": { "territory": "US", "amount": "25.00" } },
  "measure": "proceeds", "commission": "0.15" }
```

**Existing subscribers.** Every base-price change in a plan is classified per territory, and
`pricingkit diff` shows it in an "Existing subscribers" column:

| Class | Meaning |
|---|---|
| `decrease` | App Store: existing subscribers renew at the lower price. Google Play: new purchases only, see below |
| `increase-to-new-subscribers-only` | App Store with `preserveCurrentPrice` (the default), or any Google Play base plan change |
| `increase-within-no-consent-threshold` | App Store: subscribers are notified; no consent needed |
| `increase-needs-consent` | App Store: subscribers must agree before renewal, or the subscription expires |
| `new-price` / `unchanged` | No current price / same amount |

Rules (from App Store Connect Help and Play Console Help, read 2026-10-27; the sources and what isn't
encoded are listed in `src/lib/pricing/price-increase.ts`):
- App Store: consent is needed if the storefront always requires it (Austria, Germany, Poland,
  Republic of Korea), or the subscriber had an increase in the last 12 months, or the increase is
  both more than 50% and above the storefront's threshold (e.g. US$5 per period, US$50 a year for
  annual subscriptions; local amounts per storefront from Apple's table). PricingKit can't read
  the price history: give `"consent": { "lastIncreaseAt": "2026-03-01" }` (or per territory),
  otherwise no recent increase is assumed and the plan says so. Give `"billingPeriod": "P1Y"` for
  annual subscriptions, otherwise the lower non-annual threshold is used. A `lastIncreaseAt`
  PricingKit can't use (spec dates must be real days), or one after the change takes effect,
  counts as needing consent (Play: opt-in).
- Google Play: a base plan price change applies to new purchases; existing subscribers stay on
  their price in a legacy cohort until it is migrated (PricingKit doesn't migrate cohorts yet).
  `ifMigrated` says what a migration would need: decreases need no approval; an increase can be an
  opt-out (notice only) increase if it is at most the greater of 50% and 17 US cents a day, at most
  once a year, in a country that allows it (not checked), otherwise subscribers must opt in.

`"consent": { "maxIncreaseWithoutConsent": true }` refuses the whole plan (`CONSENT_REQUIRED`,
nothing written) if any territory would need consent. The web app's Apple subscription preview
shows the same column.

**Custom multipliers.** The `custom` strategy prices each territory as the base price converted to
its currency times `multipliers[territory] / multipliers[base territory]` (the base's own
defaults to 1). Without `territories` it prices the territories in its table; with `"all"` or a
list, territories without a multiplier are skipped. Multipliers must be 0.01 to 10.
`"multipliersFile": "multipliers.csv"` reads the table from a CSV next to the spec (inside the
working directory) with `territory` and `multiplier` columns, so a price export with a
`multiplier` column added works; rows with an empty multiplier are skipped. The web app's bulk
pricing modals take the same table (one `GB=0.9` per line, or the CSV).

```json
{ "type": "strategy", "strategy": "custom", "base": { "territory": "US", "amount": "9.99" },
  "multipliers": { "GB": "0.95", "IN": "0.35", "BR": "0.5" } }
```

**Reference data freshness.** Plans record the data their strategy targets came from and its age
(`dataFreshness`; `pricingkit diff` lists it, stale data is a warning). Built-in dates: PPP
snapshot synced 2026-02-01 (2024 data assumed; per-country years weren't recorded), Big Mac 2025
(month not recorded), Netflix index 2026-04-09, fallback exchange rates 2026-02-01, Apple tier ladder
(web previews) 2026-02-02. Spec exchange rates can carry `"exchangeRatesAsOf"`. Top-level
`"freshness": { "maxAgeDays": { "ppp": 900, "fallbackExchangeRates": 30 }, "refuseStale": true }`
changes the limits and refuses a plan built on stale data. The web app shows the same as badges
(index checker, bulk pricing modals), with live exchange-rate timestamps.

**Stale PPP factors.** PPP conversion factors are annual and lag; for high-inflation currencies an
old factor against today's exchange rate prices badly. With the `ppp` strategy,
`"pppStaleness": { "mode": "cap", "maxAgeYears": 3 }` (the default) skips territories whose PPP
data is older (`STALE_REFERENCE_DATA`), and `"mode": "inflate"` carries the factor forward with
`"cpi"`: each territory's CPI now / CPI in the data year (the base territory's is required), so the
multiplier becomes multiplier x cpi[t] / cpi[base]; territories without a ratio are skipped. The
web app's `/api/ppp` applies the same policy per country with live World Bank years
(`?pppStale=cap|inflate&pppMaxAge=3`): capped countries use the static index; inflate uses World
Bank CPI (FP.CPI.TOTL) relative to the US.

**Apple tier table.** The web app's Apple previews use a static price tier table. Regenerate it with
`npx tsx scripts/fetch-apple-price-tiers.ts --iap <in-app purchase ID>` (needs App Store Connect
credentials in the CLI's `ASC_*` variables; read-only; `--dry-run` to check without writing), then
review the diff.

### Agents: `pricingkit mcp`

`pricingkit mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio,
for agents that should read prices and plan changes but never apply them. Add it to your MCP
client's configuration as a command (`npx pricingkit mcp`, started in the folder holding your
spec and rules files, with the credentials in its environment). Tools:

| Tool | What it does |
| --- | --- |
| `offers` | Lists a subscription's offers (as `pricingkit offers --json`). |
| `plan` | Makes a plan from a spec and/or rules file and writes it to `out` (a dry run). |
| `diff` | Summarises a plan file, with its hash. Offline. |
| `apply_command` | Returns the exact `pricingkit apply <plan> --confirm <hash>` command (with `--allow-base-prices` / `--force-delete` when needed) for a person to review and run. It applies nothing. |

There is no apply tool. Arguments are typed and can't start with `-`. File paths are relative,
use only letters, digits, `.`, `_`, `-` and `/`, have no `..` segments, nothing under `.git/`, and
must resolve (following links) inside the server's working directory; `plan` writes only `.json`
files and never replaces a file that isn't already a plan (or state) file. The command
`apply_command` returns is shell-quoted, and a `resume` log must belong to the plan.

**Shared options.** `--json` prints machine-readable JSON on stdout: the document itself
(`pricingkit.state`, `pricingkit.changeset`, `pricingkit.planSummary`, `pricingkit.offers`,
`pricingkit.parity`), or `{"error": {"message", "code", "status"}}` on failure. Store client
logs and the request count (when any requests were sent) go to stderr. `--budget <n>` caps the
store requests one run may send (default 1000, leaving room within App Store Connect's 3600 per
hour for anything else using the same key). Every command runs inside a `RequestBudget`, and a
spent budget stops the run with an error rather than a partial result.

**Exit codes**

| Code | Meaning |
| --- | --- |
| `0` | OK. For `plan` and `diff`: no changes. For `parity`: every compared territory is in parity. |
| `1` | Error: bad arguments, invalid spec or plan, missing credentials, a store error, or a spent request budget. |
| `2` | Something to act on: `plan`/`diff` found changes (or, for sync plans, manual actions), or `parity` found a gap above the threshold. |

**App pins.** Set `PRICINGKIT_EXPECT_BUNDLE_ID` and/or `PRICINGKIT_EXPECT_PACKAGE` and the CLI
refuses any other App Store or Google Play app (from a flag, a spec, a rules file or a plan) with
`APP_NOT_EXPECTED`, before loading credentials or sending anything. Useful in CI jobs made for one app.

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

**Pricing spec** (`pricingkit.spec`, version 1, JSON or YAML). `plan` reads the products' current prices,
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
- `targets.type: "strategy"`: one base price spread to every territory by a price-parity
  strategy, with the same maths as the web app's bulk pricing:
  `{ "type": "strategy", "strategy": "ppp", "base": { "territory": "US", "amount": "9.99" }, "rounding": "nearest-99" }`.
  `strategy` is `ppp` (World Bank PPP), `bigmac`, `netflix` or `direct` (plain currency
  conversion); `base.territory` may be left out when the product gives its own `"baseTerritory"`
  (the base territory is per product: two products of one app may use different ones, and there
  is no app-wide default); `base.currency` defaults to the base territory's current currency; `rounding` is
  `none` (App Store default: snapping picks the price point), `nearest-99` (Google Play default)
  or `round-up`; `territories` defaults to every priced territory. The built-in indexes and
  fallback exchange rates make the plan reproducible offline; `exchangeRates`
  (`{ "EUR": "0.92" }`, units per US dollar) overrides rates. Each territory is priced in the
  currency it uses now; one with no price yet, or no exchange rate, is skipped with the reason.
- Optional per product: `snap` (App Store), `startDate` (App Store: schedule instead of changing
  now), `allowNewTerritories` (default `false`: never price a territory that has no price),
  `preserveCurrentPrice` (App Store, default `true`).
- Products: App Store subscriptions (numeric App Store Connect ID), Google Play base plans
  (`{ "platform": "google", "type": "subscription", "productId", "basePlanId" }`) and one-time
  products (`{ "platform": "google", "type": "inapp", "productId" }`). All products must belong to
  the spec's `app`.

The same spec in YAML (`pricing.yaml`); numbers keep the digits you write, so `4.10` stays
`4.10` and an ID with a leading zero keeps it:

```yaml
kind: pricingkit.spec
schemaVersion: 1
app: { bundleId: com.example.app }
products:
  - product: { platform: apple, type: subscription, id: "1234567890" }
    targets: { type: strategy, strategy: ppp, base: { territory: US, amount: 9.99 } }
```

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
