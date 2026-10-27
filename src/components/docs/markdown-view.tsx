import type { Block, Inline } from '@/lib/docs/markdown';
import { CodeBlock } from './doc-blocks';

function InlineView({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'text':
            return <span key={i}>{n.text}</span>;
          case 'code':
            return <code key={i}>{n.text}</code>;
          case 'strong':
            return (
              <strong key={i}>
                <InlineView nodes={n.children} />
              </strong>
            );
          case 'link':
            return (
              <a key={i} href={n.href} {...(/^https?:/.test(n.href) ? { rel: 'noopener noreferrer' } : {})}>
                <InlineView nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

/** Renders parsed Markdown blocks (no headings: the page renders those as sections) */
export function MarkdownView({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'paragraph':
            return (
              <p key={i}>
                <InlineView nodes={b.children} />
              </p>
            );
          case 'list': {
            const items = b.items.map((item, j) => (
              <li key={j}>
                <InlineView nodes={item} />
              </li>
            ));
            return b.ordered ? (
              <ol key={i} start={b.start}>
                {items}
              </ol>
            ) : (
              <ul key={i}>{items}</ul>
            );
          }
          case 'code':
            return <CodeBlock key={i} code={b.text} lang={b.lang || undefined} />;
          case 'heading':
            return null;
        }
      })}
    </>
  );
}
