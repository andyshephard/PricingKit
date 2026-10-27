import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Index checker',
  description: 'Compare equivalent prices across countries using purchasing power parity, the Big Mac index or the Netflix index.',
  alternates: { canonical: '/index-checker' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
