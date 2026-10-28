import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Connect a store',
  description: 'Connect PricingKit to App Store Connect or Google Play. Your key stays in your browser; the server only receives short-lived access tokens.',
  // The connect screen is part of the app, not a page to find in search: kept
  // out of the index and the sitemap (its links to the guides may be followed)
  robots: { index: false, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
