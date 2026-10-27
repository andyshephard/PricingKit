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
- **Offers in step with base prices** - A checked-in rules file says which App Store offers follow "X% of each territory's price"; one command checks them all for drift, and sync plans re-price them against new base prices (see [sync](#keeping-offers-in-step-with-base-prices-sync))
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
├── cli/                  # pricingkit CLI: export, plan, diff, offers, drift, apply (offer plans, --confirm)
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
re-price a drifted one, with the same preview and a confirm step. That is all the web flow does:
promotional offer creates and re-prices only. It keeps nothing and can't resume or undo, so
download the plan (`<plan>.json`) and, after applying, the run log (`<plan>.run.json`) from the
dialog. With them the CLI can:

- resume an incomplete run: `pricingkit apply <plan>.json --confirm <hash> --resume <plan>.run.json`
- undo it: `pricingkit undo <plan>.json <plan>.run.json` writes `<plan>.undo.json`; review it, then
  `pricingkit apply <plan>.undo.json --confirm <its hash> --force-delete`

Use the CLI for every other offer kind too.

Before reading or writing a subscription, PricingKit checks it belongs to the plan's app (its
group must be one of the app's subscription groups). App Store Connect API keys work across a
team's apps, so a subscription ID copied from another app is refused with `APP_MISMATCH`.

### Keeping offers in step with base prices (sync)

Apple offer prices are absolute: when a base price changes, an offer priced at "50% of each
territory's price" no longer is. The stores don't record an offer's rule, so you keep the rules in
a file in your repository and PricingKit uses it to check and re-derive the offers:

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
- `syncWithBase: false` keeps an offer in the drift check but out of sync plans.
- App Store offers only. PricingKit doesn't read Google Play offers yet, so a rules file for a Play
  app is refused. (Play offers priced with a relative discount follow the base price by themselves.)

**Drift.** `pricingkit drift --rules offer-rules.json` checks every offer in the file against its
rule and today's base prices (about 25 requests per subscription whose offers cover 175
territories: price points are read only for the territories of offers a rule can price) and prints
one `pricingkit.rulesDrift` report (each offer's
`pricingkit.offerDrift` report inside). Exit code 2 when any offer drifted or doesn't exist; 1 when
nothing drifted but an offer couldn't be checked (for example a rule on a free trial); 0 when all
are in sync. The text report's first line says `DRIFT`, `NOT CHECKED` or `In sync`, and offers that
couldn't be checked are listed right under it, also when the exit code is 2 for drift. This is what a weekly CI job runs (`examples/github-actions/drift.yml`).

**Sync plans.** `pricingkit plan --rules offer-rules.json` re-derives every `syncWithBase` offer
against the current base prices and plans `updateOfferPrices` for the ones out of step, for
example right after base prices changed. With a base-price spec,
`pricingkit plan --spec pricing.json --rules offer-rules.json` plans both in one file: the
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
  the date (the weekly drift check flags them then). The offer's other territories, with immediate
  base changes, are still re-priced in the same plan, waiting only for those immediate changes. `--scheduled-base now` re-derives them against the scheduled prices anyway,
  with a warning in the plan. A base price already scheduled in the store is warned about too: the
  offer will drift when it takes effect.
- `pricingkit diff` shows base prices and offers in separate groups, in the order they are
  applied, and lists the manual actions.

**Applying.** `pricingkit apply` applies offer plans only: base-price writes through the CLI wait
until the Apple base-price behaviour is confirmed on a test app. So `apply` applies a
`plan --rules` plan, but refuses a plan that also changes base prices. Until that changes, ship a
base price change and its offers like this: change the base prices in the web app (or apply the
base-price plan with the library), then run `pricingkit plan --rules offer-rules.json`, review it
with `pricingkit diff` and apply it. The library (`applyChangeSet`) applies combined plans, in the
order above.

```ts
import { parseOfferRules } from '@/lib/pricing';

const rules = parseOfferRules(await readFile('offer-rules.json', 'utf8'));
const report = await apple.checkRulesDrift(rules);                     // reads only
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
| `export` | Current (and scheduled) prices of an App Store subscription or a Google Play base plan, as a `pricingkit.state` snapshot. `--out <file>` also writes it. |
| `plan --spec <file>` | With an offer plan spec (`pricingkit.offerPlanSpec`), plans creating or re-pricing App Store offers and prints the plan hash. Otherwise: reads a pricing spec, snaps its targets to real store prices and writes the plan (`pricingkit.changeset`). A dry run: it only reads. The default file, `pricingkit-plan.json` (gitignored), is never replaced unless you pass `--force`; `--out <file>` names the file and replaces it. `--state-out <file>` saves the prices it planned against. |
| `diff <plan.json>` | Human-readable summary of a plan: changes per product and territory with before, after and percent change, skipped territories by reason, warnings. No store requests. |
| `offers` | An App Store subscription's introductory, promotional, offer code and win-back offers with each territory's price (`--kind` filters). |
| `apply <plan.json> --confirm <hash>` | Applies an App Store offer plan. `--confirm` must be the plan's hash (shown by `plan` and `diff`). Saves the run log after every step (`--run-out`, default `<plan>.run.json` next to the plan file, never overwritten) and continues one with `--resume <run.json>`. Deleting offers needs `--force-delete`. |
| `undo <plan.json> <run.json>` | Writes the plan that undoes a run (`--out`, default `<plan>.undo.json` next to the plan file, replaced only with `--force`) and prints its summary, hash and anything that can't be reversed. Offline: no credentials, no store requests. Apply it with `apply --confirm`, plus `--force-delete` when it deletes offers. |
| `drift` | Checks an App Store offer against "`--percent` of each territory's current price" (`--basis perPeriod\|totalOverDuration`, `--snap nearest\|floor\|ceil`, `--threshold`) and prints a `pricingkit.offerDrift` report. `--territories GB,US` checks only those territories: the offer's others are listed in `outOfScope` and don't count against it. |
| `drift --rules <rules.json>` | Checks every offer in an offer rules file and prints one `pricingkit.rulesDrift` report. See [sync](#keeping-offers-in-step-with-base-prices-sync). |
| `plan --rules <rules.json> [--spec <spec.json>]` | Plans keeping `syncWithBase` offers in step: against current base prices, or with `--spec`, against the prices that base-price plan sets (one plan, base ops first). `--scheduled-base hold\|now` (default `hold`). Offers the store can't re-price are listed as manual actions. |

```bash
export ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_PRIVATE_KEY_PATH=~/keys/AuthKey_XXXX.p8

npx pricingkit export --bundle-id com.example.app --subscription 1234567890 --out state.json
npx pricingkit plan --spec pricing.json --out plan.json
npx pricingkit diff plan.json
npx pricingkit offers --bundle-id com.example.app --subscription 1234567890
npx pricingkit drift --bundle-id com.example.app --subscription 1234567890 \
  --kind apple.promo --offer example_half --percent 50 --json
npx pricingkit drift --rules offer-rules.json
npx pricingkit plan --spec pricing.json --rules offer-rules.json --out plan.json
```

**Shared options.** `--json` prints machine-readable JSON on stdout: the document itself
(`pricingkit.state`, `pricingkit.changeset`, `pricingkit.planSummary`, `pricingkit.offers` or
`pricingkit.offerDrift`, `pricingkit.rulesDrift`), or `{"error": {"message", "code", "status"}}` on failure. Store client
logs and the request count (when any requests were sent) go to stderr. `--budget <n>` caps the
store requests one run may send (default 1000, leaving room within App Store Connect's 3600 per
hour for anything else using the same key). Every command runs inside a `RequestBudget`, and a
spent budget stops the run with an error rather than a partial result.

**Exit codes**

| Code | Meaning |
| --- | --- |
| `0` | OK. For `plan` and `diff`: no changes. For `drift`: every territory matches. |
| `1` | Error: bad arguments, invalid spec or plan, missing credentials, a store error, or a spent request budget. |
| `2` | Something to act on: `plan`/`diff` found changes (or, for sync plans, manual actions), or `drift` found the offer out of sync (any mismatch, missing, extra, unresolved or unreadable territory among those checked). `drift --rules`: any offer drifted or missing; when none did but one couldn't be checked, the exit code is `1`. |

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
