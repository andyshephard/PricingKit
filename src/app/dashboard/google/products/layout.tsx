import type { Metadata } from 'next';

export const metadata: Metadata = { title: { default: 'In-app purchases', template: '%s · In-app purchases · Google Play · PricingKit' } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
