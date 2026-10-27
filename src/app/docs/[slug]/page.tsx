import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocArticle } from '@/components/docs/doc-article';
import { DOC_PAGES, findDoc } from '@/content/docs';

// Every docs page is built ahead of time; anything else is a 404
export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_PAGES.filter((p) => p.slug).map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = findDoc(slug);
  if (!doc) return {};
  return { title: doc.page.title, description: doc.page.description, alternates: { canonical: `/docs/${slug}` } };
}

export default async function DocsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = slug ? findDoc(slug) : undefined;
  if (!doc) notFound();
  return <DocArticle page={doc.page} group={doc.group} prev={doc.prev} next={doc.next} />;
}
