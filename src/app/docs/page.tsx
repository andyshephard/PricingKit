import type { Metadata } from 'next';
import { DocArticle } from '@/components/docs/doc-article';
import { findDoc } from '@/content/docs';

const doc = findDoc('')!;

export const metadata: Metadata = {
  title: { absolute: 'Docs · PricingKit' },
  description: doc.page.description,
  alternates: { canonical: '/docs' },
};

export default function DocsHome() {
  return <DocArticle page={doc.page} group={doc.group} prev={doc.prev} next={doc.next} />;
}
