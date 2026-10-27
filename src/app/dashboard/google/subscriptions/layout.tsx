import type { Metadata } from 'next';

export const metadata: Metadata = { title: { default: 'Subscriptions', template: '%s · Subscriptions · Google Play · PricingKit' } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
