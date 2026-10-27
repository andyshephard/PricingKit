import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { CopyButton } from './copy-button';

/**
 * A code block with a copy button. `example` labels it as an example (made-up
 * IDs, keys and amounts), so nobody mistakes it for a value to use.
 */
export function CodeBlock({ code, lang, title, example = false }: { code: string; lang?: string; title?: string; example?: boolean }) {
  const label = [example ? 'Example' : null, title].filter(Boolean).join(' · ');
  return (
    <figure className="my-5 overflow-hidden rounded-xl border border-line bg-code">
      <figcaption className="flex items-center gap-3 border-b border-code-foreground/10 px-4 py-2 text-xs text-code-foreground/80">
        <span className="min-w-0 flex-1 truncate font-sans font-semibold">{label || lang || 'Code'}</span>
        {lang && label && <span className="font-mono">{lang}</span>}
        <CopyButton text={code} />
      </figcaption>
      <pre className="m-0 overflow-x-auto rounded-none border-0 bg-transparent p-4 font-mono text-[13px] leading-[1.7] text-code-foreground sm:p-5">
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** A note in the docs: info (default) or a warning */
export function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'warn'; title?: string; children: ReactNode }) {
  return (
    <div
      role="note"
      className={cn(
        'my-6 rounded-xl border px-5 py-4 text-[15px] leading-relaxed',
        tone === 'warn' ? 'border-warn-border bg-warn text-warn-foreground' : 'border-transparent bg-info text-info-foreground',
        // Inline code and links keep their own colours readable on the tinted background
        '[&_code]:bg-card/60 [&_code]:text-inherit [&_a]:text-inherit [&_a]:underline [&_strong]:text-inherit'
      )}
    >
      {title && <strong className="font-bold">{title} </strong>}
      {children}
    </div>
  );
}

/** A table in the docs; scrolls sideways on its own on narrow screens */
export function DocTable({ head, rows, caption }: { head: ReactNode[]; rows: ReactNode[][]; caption?: string }) {
  return (
    <div className="my-6 overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-left text-[15px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="bg-docs-raised">
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-4 py-3 align-bottom font-bold whitespace-nowrap text-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-t border-line align-top">
              {row.map((cell, c) =>
                c === 0 ? (
                  <th key={c} scope="row" className="px-4 py-3 font-semibold text-foreground">
                    {cell}
                  </th>
                ) : (
                  <td key={c} className="px-4 py-3">
                    {cell}
                  </td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A link to another docs page (and anchor) */
export function DocLink({ to, children }: { to: string; children: ReactNode }) {
  const href = to.startsWith('#') ? to : `/docs${to ? `/${to}` : ''}`;
  return <Link href={href}>{children}</Link>;
}
