import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'App price' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
