/**
 * Public site settings shared by the landing page, the app shell and metadata.
 *
 * NEXT_PUBLIC_SITE_URL is the address this deployment is served from, used for
 * absolute Open Graph and canonical URLs. Set it at build time (for example
 * `NEXT_PUBLIC_SITE_URL=https://pricing.example.com npm run build`). Without it
 * the site falls back to http://localhost:3000, which is right for local runs
 * and harmless elsewhere: only social previews need an absolute URL.
 */
export const SITE_NAME = 'PricingKit';

export const SITE_DESCRIPTION =
  'Free, open-source regional pricing for the App Store and Google Play. Set prices from local purchasing power, snapped to real store price points, and review every change before it is applied.';

export const GITHUB_URL = 'https://github.com/andyshephard/PricingKit';

export const LICENSE_NAME = 'GPL-3.0';

const FALLBACK_SITE_URL = 'http://localhost:3000';

export function getSiteUrl(): URL {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (raw) {
    try {
      return new URL(raw);
    } catch {
      // An invalid value falls through to the default.
    }
  }
  return new URL(FALLBACK_SITE_URL);
}

/** Routes the public pages and the app shell link to. */
export const ROUTES = {
  home: '/',
  setup: '/setup',
  dashboard: '/dashboard',
  docs: '/docs',
  indexChecker: '/index-checker',
  setupGuide: '/setup-guide',
  settings: '/dashboard/settings',
} as const;

export const REPO_LINKS = {
  changelog: `${GITHUB_URL}/blob/main/CHANGELOG.md`,
  security: `${GITHUB_URL}/blob/main/SECURITY.md`,
} as const;
