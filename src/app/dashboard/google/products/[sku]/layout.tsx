import type { Metadata } from 'next';

export async function generateMetadata({ params }: { params: Promise<{ sku: string }> }): Promise<Metadata> {
  const { sku } = await params;
  let title = sku;
  try {
    title = decodeURIComponent(sku);
  } catch {
    // Keep the raw segment.
  }
  return { title };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
