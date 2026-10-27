import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Set up App Store Connect',
  description: 'Create an App Store Connect API key with the right role and connect it to PricingKit.',
  alternates: { canonical: '/setup-guide/apple' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
