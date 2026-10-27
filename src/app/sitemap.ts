import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/config/site';
import { PUBLIC_PAGES } from '@/config/public-pages';
import { DOC_PAGES, docHref } from '@/content/docs';

/** sitemap.xml: the public pages and every docs page, absolute on NEXT_PUBLIC_SITE_URL */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = getSiteUrl();
  const paths = [...PUBLIC_PAGES, ...DOC_PAGES.map((p) => docHref(p.slug))];
  return paths.map((path) => ({ url: new URL(path, base).toString() }));
}
