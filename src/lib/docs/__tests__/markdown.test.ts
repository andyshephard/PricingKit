import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inlineText, parseInline, parseMarkdown, safeHref, slugify } from '../markdown';

describe('docs markdown reader', () => {
  it('reads headings, paragraphs, lists with continuation lines and code fences', () => {
    const blocks = parseMarkdown(
      [
        '# Title',
        'Intro line one',
        'and two.',
        '',
        '## [Unreleased]',
        '1. **First** item',
        '2. Second item',
        '   continues here',
        '',
        '- a `code` bit',
        '',
        '- after a blank line, same list',
        '```bash',
        'npm test',
        '```',
      ].join('\n')
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'heading', 'list', 'list', 'code']);
    expect(blocks[2]).toMatchObject({ type: 'heading', level: 2, id: 'unreleased', text: 'Unreleased' });
    expect(blocks[3]).toMatchObject({ type: 'list', ordered: true, start: 1 });
    const ordered = blocks[3] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(inlineText(ordered.items[1])).toBe('Second item continues here');
    const bullets = blocks[4] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(bullets.items).toHaveLength(2);
    expect(blocks[5]).toEqual({ type: 'code', lang: 'bash', text: 'npm test' });
  });

  it('keeps markup as text and only allows safe link targets', () => {
    expect(parseInline('<script>x</script>')).toEqual([{ type: 'text', text: '<script>x</script>' }]);
    expect(parseInline('[a](javascript:alert(1))')).not.toContainEqual(expect.objectContaining({ type: 'link' }));
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('/docs')).toBe('/docs');
    expect(safeHref('data:text/html,x')).toBeNull();
  });

  it('gives repeated headings unique ids', () => {
    const blocks = parseMarkdown('## Added\n\n## Added\n');
    expect(blocks.map((b) => (b.type === 'heading' ? b.id : ''))).toEqual(['added', 'added-2']);
    expect(slugify('`apply` --yes')).toBe('apply-yes');
  });

  it('reads the repository CHANGELOG without losing entries', () => {
    const source = readFileSync(join(__dirname, '../../../../CHANGELOG.md'), 'utf8');
    const blocks = parseMarkdown(source);
    const bulletLines = source.split('\n').filter((l) => /^(- |\d+\. )/.test(l)).length;
    const items = blocks.reduce((n, b) => n + (b.type === 'list' ? b.items.length : 0), 0);
    expect(items).toBe(bulletLines);
    expect(blocks.filter((b) => b.type === 'heading').map((b) => (b as { text: string }).text)).toContain('Security');
  });
});
