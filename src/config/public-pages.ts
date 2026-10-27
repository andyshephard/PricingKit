/**
 * The public pages a search engine may list: the landing page, the setup
 * guides, the index checker and every docs page. No app (dashboard) pages,
 * no connect screen, no API.
 */
export const PUBLIC_PAGES: readonly string[] = ['/', '/index-checker', '/setup-guide', '/setup-guide/apple', '/setup-guide/google'];

/** Paths robots.txt asks crawlers to skip */
export const PRIVATE_PATH_PREFIXES: readonly string[] = ['/dashboard', '/api/'];
