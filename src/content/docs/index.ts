import { introduction, connectAppStore, connectGooglePlay, runItYourself } from './pages/get-started';
import { pricingStrategies, plans, existingSubscribers, pricingByProceeds, referenceData } from './pages/pricing';
import { appleOffers, googlePlayOffers, offersInStep } from './pages/offers';
import { cliInstall, cliCommands, specFiles, workspaces, agents } from './pages/cli';
import { security, changelog } from './pages/reference';
import type { DocGroup, DocPage, DocSearchEntry } from './types';

/** The docs, in sidebar order. Every page and heading here is in the search index. */
export const DOC_GROUPS: DocGroup[] = [
  { title: 'Get started', pages: [introduction, connectAppStore, connectGooglePlay, runItYourself] },
  { title: 'Pricing', pages: [pricingStrategies, plans, existingSubscribers, pricingByProceeds, referenceData] },
  { title: 'Offers', pages: [appleOffers, googlePlayOffers, offersInStep] },
  { title: 'Command line', pages: [cliInstall, cliCommands, specFiles, workspaces, agents] },
  { title: 'Reference', pages: [security, changelog] },
];

export const DOC_PAGES: DocPage[] = DOC_GROUPS.flatMap((g) => g.pages);

export function docHref(slug: string): string {
  return slug ? `/docs/${slug}` : '/docs';
}

export function findDoc(slug: string): { page: DocPage; group: string; prev?: DocPage; next?: DocPage } | undefined {
  const i = DOC_PAGES.findIndex((p) => p.slug === slug);
  if (i < 0) return undefined;
  const group = DOC_GROUPS.find((g) => g.pages.includes(DOC_PAGES[i]))!.title;
  return { page: DOC_PAGES[i], group, prev: DOC_PAGES[i - 1], next: DOC_PAGES[i + 1] };
}

/** Page titles and headings: what the docs search looks through */
export function docSearchIndex(): DocSearchEntry[] {
  return DOC_GROUPS.flatMap((g) =>
    g.pages.flatMap((p) => [
      { href: docHref(p.slug), title: p.title, context: g.title },
      ...p.sections.map((s) => ({ href: `${docHref(p.slug)}#${s.id}`, title: s.title, context: p.title })),
    ])
  );
}

/** The sidebar's groups of links */
export function docNavGroups() {
  return DOC_GROUPS.map((g) => ({ title: g.title, links: g.pages.map((p) => ({ href: docHref(p.slug), label: p.title })) }));
}
