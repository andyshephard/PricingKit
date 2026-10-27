/**
 * Public site settings shared by the landing page, the app shell and metadata.
 *
 * NEXT_PUBLIC_SITE_URL is the address this deployment is served from, used for
 * canonical and Open Graph URLs, sitemap.xml and robots.txt. Next.js inlines it
 * at build time (for example
 * `NEXT_PUBLIC_SITE_URL=https://pricing.example.com npm run build`). Without it
 * the site uses the live domain, DEFAULT_SITE_URL; a self-hosted copy on
 * another domain should set it, and local runs may set it to
 * http://localhost:3000 in .env.local.
 */
export const SITE_NAME = 'PricingKit';

export const SITE_DESCRIPTION =
  'Free, open-source regional pricing for the App Store and Google Play. Set prices from local purchasing power, snapped to real store price points, and review every change before it is applied.';

export const GITHUB_URL = 'https://github.com/andyshephard/PricingKit';

export const LICENSE_NAME = 'GPL-3.0';

/** The live PricingKit site */
export const DEFAULT_SITE_URL = 'https://pricing-kit.com';

export function getSiteUrl(): URL {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (raw) {
    try {
      return new URL(raw);
    } catch {
      // An invalid value falls through to the default.
    }
  }
  return new URL(DEFAULT_SITE_URL);
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

/** In-site pages for the changelog and the security model (built from the repository's files) */
export const DOC_LINKS = {
  changelog: '/docs/changelog',
  security: '/docs/security',
} as const;
