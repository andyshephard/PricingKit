import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Connect a store',
  description: 'Connect PricingKit to App Store Connect or Google Play. Keys are encrypted into a short-lived session and never stored.',
  alternates: { canonical: '/setup' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
