import type { ReactNode } from 'react';

/** One heading of a docs page and what follows it; `id` is the anchor */
export interface DocSection {
  id: string;
  title: string;
  /** 2 (default) or 3: a sub-heading, indented in "On this page" */
  level?: 2 | 3;
  body: ReactNode;
}

export interface DocPage {
  /** URL segment under /docs; '' is /docs itself */
  slug: string;
  title: string;
  /** One sentence under the title, also the page's meta description */
  description: string;
  /** Text between the description and the first heading */
  intro?: ReactNode;
  sections: DocSection[];
}

export interface DocGroup {
  title: string;
  pages: DocPage[];
}

/** What the client-side search sees: titles and headings only, built at build time */
export interface DocSearchEntry {
  href: string;
  title: string;
  /** The page title for a heading, or the group for a page */
  context: string;
}
