![PricingKit Banner](public/banner.webp)

# PricingKit

Free, open-source regional pricing tool for the App Store and Google Play. Set PPP-adjusted prices across 175+ territories in one click. Your credentials are sent only to the server you use, kept in an encrypted HttpOnly cookie, and never stored server-side &mdash; or self-host for full control.

## Features

- **Multi-platform support** - Manage pricing for both Google Play and Apple App Store from one interface
- **Regional pricing** - View and edit in-app product pricing by region/territory
- **Subscription management** - Manage subscription base plan pricing
- **Bulk updates** - Update prices across multiple products/regions at once
- **Currency conversion** - Automatic exchange rate lookups
- **Multiple pricing strategies** - PPP (World Bank), Big Mac Index, Netflix Index, or custom multipliers for regional pricing
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

### Tests

```bash
npm test
```

## Tech Stack

- **Framework**: Next.js 16 (App Router) with TypeScript
- **Styling**: Tailwind CSS 4 + shadcn/ui
- **State**: Zustand + TanStack Query
- **Forms**: React Hook Form + Zod
- **Google Play API**: googleapis
- **Apple App Store Connect API**: Custom JWT client

## Project Structure

```
src/
├── app/
│   ├── api/              # API routes (Google & Apple endpoints)
│   ├── dashboard/        # Dashboard pages
│   ├── index-checker/    # Public price index comparison tool
│   └── setup-guide/      # Setup instructions
├── components/
│   ├── ui/               # shadcn/ui components
│   ├── layout/           # Layout components
│   ├── products/         # Product components
│   └── subscriptions/    # Subscription components
├── lib/
│   ├── google-play/      # Google Play API integration
│   ├── apple-connect/    # Apple App Store Connect API integration
│   ├── exchange-rates/   # Currency conversion
│   └── conversion-indexes/ # PPP, Big Mac, Netflix indexes + exchange rate fallbacks
├── hooks/                # React Query hooks
└── store/                # Zustand stores
```

## Environment Variables

Create a `.env.local` file (optional):

```env
# Encrypts credentials in the session cookie. Required everywhere except `next dev`
# (generate with: openssl rand -base64 32)
ENCRYPTION_KEY=your-secure-random-string

# Open Exchange Rates API key (for currency conversion)
OPEN_EXCHANGE_RATES_APP_ID=your-api-key
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
