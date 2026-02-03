# Pricing.io - Google Play Store Pricing Manager

A Next.js webapp for managing Google Play Store in-app product and subscription pricing.

## Features

- View and edit in-app product pricing by region
- Manage subscription base plan pricing
- Bulk update prices across multiple products/regions
- Search and filter products by SKU or name

## Getting Started

### Prerequisites

You'll need a Google Cloud project with a service account configured. **See the in-app setup guide** at `/setup-guide` for detailed instructions.

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click "View Setup Guide" for instructions on configuring your Google Cloud project and service account.

### Production Build

```bash
npm run build
npm start
```

## Tech Stack

- **Framework**: Next.js 14+ (App Router) with TypeScript
- **Styling**: Tailwind CSS + shadcn/ui
- **State**: Zustand + TanStack Query
- **Forms**: React Hook Form + Zod
- **Google API**: googleapis

## Project Structure

```
src/
├── app/
│   ├── api/           # API routes
│   ├── dashboard/     # Dashboard pages
│   └── setup-guide/   # Setup instructions
├── components/
│   ├── ui/            # shadcn/ui components
│   ├── layout/        # Layout components
│   ├── products/      # Product components
│   └── subscriptions/ # Subscription components
├── lib/google-play/   # Google Play API integration
├── hooks/             # React Query hooks
└── store/             # Zustand stores
```

## Environment Variables

Create a `.env.local` file (optional):

```env
# Custom encryption key for credential storage (recommended for production)
ENCRYPTION_KEY=your-secure-random-string
```

## Security

- Service account credentials are encrypted and stored in HTTP-only cookies
- Credentials are never stored on the server
- Sessions expire after 24 hours

## License

MIT
