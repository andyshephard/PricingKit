'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DocSearchEntry } from '@/content/docs/types';
import { searchDocs } from '@/lib/docs/search';

/**
 * Search over the docs' page titles and headings. The index is built when
 * the pages are (at build time) and passed in; nothing is fetched.
 */
export function DocsSearch({ index, className }: { index: readonly DocSearchEntry[]; className?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchDocs(index, query), [index, query]);
  const showList = open && query.trim() !== '';

  const go = (entry: DocSearchEntry) => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    router.push(entry.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      const entry = results[active];
      if (entry) {
        e.preventDefault();
        go(entry);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={cn('relative', className)}>
      <label className="flex items-center gap-2 rounded-full border border-border bg-docs-raised px-3.5 py-2 text-sm text-muted-foreground focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label="Search docs"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
          placeholder="Search docs"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Let a click on a result land before the list closes
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
      </label>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="absolute top-full right-0 left-0 z-30 mt-2 max-h-[70vh] overflow-auto rounded-2xl border bg-popover p-1.5 shadow-[var(--shadow-panel)]"
        >
          {results.length === 0 ? (
            <li role="option" aria-selected={false} aria-disabled="true" className="px-3 py-2.5 text-sm text-muted-foreground">
              No page or heading matches.
            </li>
          ) : (
            results.map((r, i) => (
              <li
                key={r.href}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(r)}
                onMouseEnter={() => setActive(i)}
                className={cn('cursor-pointer rounded-xl px-3 py-2', i === active && 'bg-accent text-accent-foreground')}
              >
                <span className="block text-sm font-semibold">{r.title}</span>
                <span className={cn('block text-xs', i === active ? 'text-accent-foreground' : 'text-muted-foreground')}>{r.context}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
