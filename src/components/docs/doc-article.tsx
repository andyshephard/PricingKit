import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DocPage } from '@/content/docs/types';

const docHref = (slug: string) => (slug ? `/docs/${slug}` : '/docs');

function OnThisPage({ page, className }: { page: DocPage; className?: string }) {
  if (page.sections.length === 0) return null;
  return (
    <nav aria-label="On this page" className={cn('text-sm', className)}>
      <p className="mb-2.5 font-bold text-foreground">On this page</p>
      <ul>
        {page.sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className={cn('block rounded-md py-1 text-muted-foreground transition-colors hover:text-foreground', s.level === 3 && 'pl-3.5')}
            >
              {s.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * One docs page: title, description, intro, its sections with anchored
 * headings, previous / next links, and the "On this page" column (a
 * collapsible list above the text on narrower screens).
 */
export function DocArticle({ page, group, prev, next }: { page: DocPage; group: string; prev?: DocPage; next?: DocPage }) {
  return (
    <div className="flex min-w-0 flex-1 gap-12 px-4 py-10 sm:px-8 lg:px-14 lg:py-12">
      <article className="prose-atlas min-w-0 max-w-[740px] flex-1">
        <p className="text-[13px] font-semibold text-accent-foreground">{group}</p>
        <h1 className="mt-2 text-[32px] leading-tight font-extrabold tracking-[-0.02em] text-foreground sm:text-[40px]">{page.title}</h1>
        <p className="mt-4 text-[18px] leading-[1.7]">{page.description}</p>

        {page.sections.length > 1 && (
          <details className="mt-6 rounded-xl border border-line px-4 py-3 xl:hidden">
            <summary className="cursor-pointer text-sm font-bold text-foreground">On this page</summary>
            <OnThisPage page={page} className="mt-2 [&>p]:hidden" />
          </details>
        )}

        {page.intro && <div className="mt-6">{page.intro}</div>}

        {page.sections.map((s) =>
          s.level === 3 ? (
            <section key={s.id} aria-labelledby={s.id}>
              <h3 id={s.id}>{s.title}</h3>
              {s.body}
            </section>
          ) : (
            <section key={s.id} aria-labelledby={s.id}>
              <h2 id={s.id}>{s.title}</h2>
              {s.body}
            </section>
          )
        )}

        {(prev || next) && (
          <nav aria-label="Previous and next page" className="mt-14 flex flex-wrap justify-between gap-3 border-t border-line pt-6 text-[15px]">
            {prev ? (
              <Link href={docHref(prev.slug)} className="inline-flex items-center gap-1.5 no-underline hover:underline">
                <ChevronLeft className="size-4" aria-hidden="true" />
                {prev.title}
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link href={docHref(next.slug)} className="ml-auto inline-flex items-center gap-1.5 no-underline hover:underline">
                {next.title}
                <ChevronRight className="size-4" aria-hidden="true" />
              </Link>
            )}
          </nav>
        )}
      </article>
      <OnThisPage page={page} className="sticky top-6 hidden w-[200px] shrink-0 self-start xl:block" />
    </div>
  );
}
