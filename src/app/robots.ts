import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/config/site';
import { PRIVATE_PATH_PREFIXES } from '@/config/public-pages';

/** robots.txt: crawl the public site, skip the app and the API, point at the sitemap */
export default function robots(): MetadataRoute.Robots {
  const base = getSiteUrl();
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...PRIVATE_PATH_PREFIXES] }],
    sitemap: new URL('/sitemap.xml', base).toString(),
  };
}
