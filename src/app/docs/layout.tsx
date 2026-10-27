import type { Metadata } from 'next';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { OpenAppLink } from '@/components/site/open-app-link';
import { pillPrimary } from '@/components/site/site-header';
import { SiteFooter } from '@/components/site/site-footer';
import { DocsSearch } from '@/components/docs/docs-search';
import { DocsSidebar } from '@/components/docs/docs-sidebar';
import { docNavGroups, docSearchIndex } from '@/content/docs';

export const metadata: Metadata = {
  title: {
    default: 'Docs',
    template: '%s · Docs · PricingKit',
  },
};

// Built once with the pages; the search runs in the browser over this index
const searchIndex = docSearchIndex();
const navGroups = docNavGroups();

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-docs-page">
      <a
        href="#docs-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <header className="border-b bg-docs-page">
        <nav aria-label="Main" className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 sm:gap-x-4 sm:px-8 sm:py-4">
          <Logo href="/" suffix="Docs" />
          {/* Phones: logo and Open the app on the first row, search and the theme toggle on the second */}
          <OpenAppLink className={`${pillPrimary} order-2 ml-auto px-4 py-2 text-sm whitespace-nowrap sm:order-3 sm:ml-0`} />
          <DocsSearch index={searchIndex} className="order-3 min-w-0 flex-1 basis-[calc(100%-3rem)] sm:order-1 sm:ml-auto sm:w-[320px] sm:flex-none sm:basis-auto" />
          <ThemeToggle className="order-4 sm:order-2" />
        </nav>
      </header>
      <div className="flex flex-1 flex-col lg:flex-row">
        <DocsSidebar groups={navGroups} />
        <main id="docs-content" className="flex min-w-0 flex-1">
          {children}
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
