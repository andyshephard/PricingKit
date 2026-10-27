import type { Metadata } from 'next';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  let title = id;
  try {
    title = decodeURIComponent(id);
  } catch {
    // Keep the raw segment.
  }
  return { title };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
