import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOC_GROUPS, DOC_PAGES, docHref, docSearchIndex, findDoc } from '..';
import { searchDocs } from '@/lib/docs/search';
import sitemap from '@/app/sitemap';
import robots from '@/app/robots';

const PAGES_DIR = join(__dirname, '../pages');
const sources = readdirSync(PAGES_DIR).map((f) => ({ file: f, text: readFileSync(join(PAGES_DIR, f), 'utf8') }));

describe('docs', () => {
  it('has the planned pages, each slug once, in five groups', () => {
    expect(DOC_GROUPS.map((g) => g.title)).toEqual(['Get started', 'Pricing', 'Offers', 'Command line', 'Reference']);
    const slugs = DOC_PAGES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('');
    expect(slugs).toContain('changelog');
    expect(DOC_PAGES).toHaveLength(19);
  });

  it('gives every heading a unique, URL-safe id', () => {
    for (const page of DOC_PAGES) {
      const ids = page.sections.map((s) => s.id);
      expect(new Set(ids).size, page.slug).toBe(ids.length);
      for (const id of ids) expect(id, page.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('every in-docs link points at a page (and heading) that exists', () => {
    for (const { file, text } of sources) {
      for (const [, to] of text.matchAll(/<DocLink to="([^"]*)"/g)) {
        const [slug, anchor] = to.split('#');
        const doc = findDoc(slug);
        expect(doc, `${file}: ${to}`).toBeDefined();
        if (anchor) expect(doc!.page.sections.map((s) => s.id), `${file}: ${to}`).toContain(anchor);
      }
      for (const [, anchor] of text.matchAll(/href="#([^"]+)"/g)) {
        expect(DOC_PAGES.some((p) => p.sections.some((s) => s.id === anchor)), `${file}: #${anchor}`).toBe(true);
      }
    }
  });

  it('indexes every page title and heading for search, and finds them', () => {
    const index = docSearchIndex();
    for (const page of DOC_PAGES) {
      expect(index.map((e) => e.href)).toContain(docHref(page.slug));
      for (const s of page.sections) expect(index.map((e) => e.href)).toContain(`${docHref(page.slug)}#${s.id}`);
    }
    expect(searchDocs(index, 'encryption')[0].href).toBe('/docs/run-it-yourself#encryption-key');
    expect(searchDocs(index, 'keychain').map((e) => e.href)).toContain('/docs/cli-install#macos-keychain');
    expect(searchDocs(index, 'zzzz')).toEqual([]);
  });

  it('describes removed features nowhere and never suggests npx outside the clone', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/drift/i);
      // Every npx either carries --no-install or is the warning against a bare npx pricingkit
      for (const m of text.matchAll(/npx (?!--no-install)\S+/g)) {
        const around = text.slice(Math.max(0, m.index! - 200), m.index! + 200);
        expect(around, `${file}: ${m[0]}`).toMatch(/Never run|Don&apos;t configure it as/);
      }
    }
  });
});

describe('sitemap and robots', () => {
  it('list the public pages and docs on the live domain, never the app', () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls).toContain('https://pricing-kit.com/');
    expect(urls).toContain('https://pricing-kit.com/docs');
    expect(urls).toContain('https://pricing-kit.com/docs/changelog');
    expect(urls).toContain('https://pricing-kit.com/setup-guide/apple');
    expect(urls).toContain('https://pricing-kit.com/index-checker');
    expect(urls.some((u) => /dashboard|\/api\//.test(u))).toBe(false);
    const r = robots();
    expect(r.sitemap).toBe('https://pricing-kit.com/sitemap.xml');
    expect(JSON.stringify(r.rules)).toContain('/dashboard');
  });
});
