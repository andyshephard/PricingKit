import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Set up Google Play',
  description: 'Create a Google Cloud service account, grant it access in Play Console and connect it to PricingKit.',
  alternates: { canonical: '/setup-guide/google' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
