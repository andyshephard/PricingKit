![PricingKit Banner](public/banner.webp)

# PricingKit

Free, open-source regional pricing tool for the App Store and Google Play. Set PPP-adjusted prices across 175+ territories in one click, snapped to real store price points, and review every change before it is applied. Your store key stays in your browser: PricingKit's server only receives short-lived access tokens &mdash; or self-host for full control.

**Documentation: [pricing-kit.com/docs](https://pricing-kit.com/docs)** (the same pages are built into every deployment at `/docs`; their source is `src/content/docs`).

## Features

- **Both stores** - In-app purchases, App Store subscriptions and Google Play base plans, priced by region or territory
- **Pricing strategies** - PPP (World Bank), Big Mac index, Netflix index, plain currency conversion, or your own per-territory multipliers ([Pricing strategies](https://pricing-kit.com/docs/pricing-strategies))
- **Review before apply** - Every bulk change shows each country before and after; plan files apply only with their hash, idempotently, and can be resumed and undone ([Plans, confirm and undo](https://pricing-kit.com/docs/plans))
- **Existing subscribers** - Every change says what existing subscribers see: a lower price, nothing, a notice, or a request for consent ([Existing subscribers](https://pricing-kit.com/docs/existing-subscribers))
- **Pricing quality** - Target proceeds instead of the customer price; reference data shows its age; stale PPP data is capped or inflated
- **Offers** - App Store promotional offers from a rule in the web app; App Store and Google Play offers in plan files; rules files keep offers in step with base prices ([Apple offers](https://pricing-kit.com/docs/apple-offers), [Google Play offers](https://pricing-kit.com/docs/google-play-offers))
- **Headless** - A `pricingkit` command line (JSON or YAML specs, `--json` output, exit codes for CI) and an MCP server so agents can plan while people apply ([Command line](https://pricing-kit.com/docs/cli-install))
- **Several apps, both stores** - Workspaces plan several apps at once, one plan per app, report cross-store parity, and round-trip prices through CSV ([Workspaces](https://pricing-kit.com/docs/workspaces))
- **Price export** - Download a product's or subscription's current prices as CSV or JSON
- **Public index checker** - Compare regional prices across strategies at `/index-checker` (no sign-in)

## Getting started

You need an App Store Connect API key (`.p8`, Key ID, Issuer ID) or a Google Play service account JSON key. The in-app guides at `/setup-guide` and the docs ([Connect App Store](https://pricing-kit.com/docs/connect-app-store), [Connect Google Play](https://pricing-kit.com/docs/connect-google-play)) walk through creating them.

```bash
npm ci
npm run dev        # http://localhost:3000
```

Neither `npm run dev` nor a production build (`npm run build`, then `npm start`) needs any configuration: there is no secret to set. To run on Cloudflare Workers:

```bash
npm run preview   # build and run locally on the Workers runtime (reads .dev.vars)
npm run deploy    # build and deploy with wrangler
```

[Run it yourself](https://pricing-kit.com/docs/run-it-yourself) covers deploying and every environment variable.

## Environment variables

| Variable | |
| --- | --- |
| `OPEN_EXCHANGE_RATES_APP_ID` | Optional operator key for live exchange rates; users can also save their own in Settings (kept in their browser). |
| `NEXT_PUBLIC_SITE_URL` | Optional, read at build time. The site's address for canonical URLs, social previews, `sitemap.xml` and `robots.txt`. Defaults to `https://pricing-kit.com`; set it when you host on your own domain (or to `http://localhost:3000` in `.env.local`). |

Put them in `.env.local` for `npm run dev` / `npm start`, as Worker secrets on Cloudflare (`npx --no-install wrangler secret put OPEN_EXCHANGE_RATES_APP_ID`), and in `.dev.vars` for `npm run preview`. `NEXT_PUBLIC_SITE_URL` goes in the build environment. `ENCRYPTION_KEY`, `SESSION_VERSION` and `TRUSTED_CLIENT_IP_HEADER` from earlier versions are no longer used and can be deleted.

## Command line

The `pricingkit` CLI runs from a clone (TypeScript through `tsx`, no build step) and is not published to npm:

```bash
cd /path/to/pricingkit && npm ci
alias pricingkit="node /path/to/pricingkit/bin/pricingkit.mjs"
pricingkit --help
```

**Never run `npx pricingkit` outside the clone**: `npx` would download whatever the npm registry has under that name and run it with your store credentials. Inside the clone, `npx --no-install pricingkit` is safe. Only `apply` writes to a store, only with `--confirm <plan hash>`, and at a terminal only after you type the app's ID. See [Install and credentials](https://pricing-kit.com/docs/cli-install), [Commands](https://pricing-kit.com/docs/cli-commands) and [Agents (MCP)](https://pricing-kit.com/docs/agents).

## Checks

```bash
npm test            # Vitest
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
```

CI runs all three on every pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and testing conventions, and [CHANGELOG.md](CHANGELOG.md) (also at [/docs/changelog](https://pricing-kit.com/docs/changelog)) for behaviour changes.

## Tech stack

- **Framework**: Next.js 16 (App Router) with TypeScript, on Node (`npm start`) or Cloudflare Workers via OpenNext
- **UI**: Tailwind CSS 4, shadcn/ui and Radix, with the Atlas theme (light and dark)
- **State**: Zustand + TanStack Query; forms with React Hook Form + Zod
- **Store APIs**: hand-rolled `fetch` clients (Google: service-account JWT signed with Web Crypto; Apple: ES256 JWT), no store SDKs

## Project structure

```
bin/pricingkit.mjs        # CLI launcher (runs src/cli through tsx)
src/
├── app/                  # Pages and API routes (dashboard, docs, setup guides, index checker)
├── cli/                  # pricingkit CLI and MCP server
├── components/           # UI (ui/, layout/, docs/, pricing/, products/, subscriptions/)
├── content/docs/         # The /docs pages
├── lib/
│   ├── pricing/          # Framework-free core: strategies, indexes, Decimal money, plans, executor
│   ├── adapters/         # App Store and Google Play adapters for the executor
│   ├── apple-connect/    # App Store Connect API client
│   ├── google-play/      # Google Play Developer API client
│   └── ...               # exchange rates, World Bank PPP, export, utils
├── hooks/                # React Query hooks
└── store/                # Zustand stores
```

## Security

Your App Store Connect or Google Play private key never leaves your browser: it is imported there as a non-extractable key and used to sign short-lived tokens (App Store Connect up to 20 minutes, Google Play up to 1 hour). The PricingKit server only receives those tokens, forwards them to Apple or Google, and keeps nothing. A dishonest or compromised hosted operator could misuse a token until it expires, but can't keep access or make new ones; self-host to remove even that. The key stays in that browser until you sign out or forget it in Settings. The [Security model](https://pricing-kit.com/docs/security) has the details, and [SECURITY.md](SECURITY.md) the policy and how to report a vulnerability.

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

This means you are free to use, modify, and distribute this software, but any derivative works must also be open-sourced under GPL-3.0.

## Support

PricingKit is free and always will be. If you find it useful, consider buying me a coffee!

<a href="https://www.buymeacoffee.com/andyshephard" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>
