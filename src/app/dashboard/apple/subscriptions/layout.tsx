import type { Metadata } from 'next';

export const metadata: Metadata = { title: { default: 'Subscriptions', template: '%s · Subscriptions · App Store · PricingKit' } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
