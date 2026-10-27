import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every text/background pair the Atlas theme puts together must meet WCAG AA
// for normal text (4.5:1), in light and in dark.
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) vars[m[1]] = m[2].toLowerCase();
  return vars;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [text, background]
const PAIRS: Array<[string, string]> = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['soft', 'background'],
  ['soft', 'card'],
  ['soft', 'chip'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['muted-foreground', 'header'],
  ['primary-foreground', 'primary'],
  ['primary', 'card'],
  ['primary', 'background'],
  ['accent-foreground', 'accent'],
  ['secondary-foreground', 'secondary'],
  ['chip-foreground', 'chip'],
  ['destructive', 'card'],
  ['destructive-foreground', 'destructive'],
  ['change', 'card'],
  ['change', 'background'],
  ['info-foreground', 'info'],
  ['warn-foreground', 'warn'],
  ['success-foreground', 'success'],
  ['code-foreground', 'code'],
  ['link', 'card'],
  ['link', 'background'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
];

describe.each([
  ['light', ':root'],
  ['dark', '.dark'],
])('Atlas %s theme', (_name, selector) => {
  const vars = block(selector);

  it.each(PAIRS)('%s on %s meets WCAG AA', (text, background) => {
    expect(vars[text], text).toBeDefined();
    expect(vars[background], background).toBeDefined();
    expect(contrast(vars[text], vars[background])).toBeGreaterThanOrEqual(4.5);
  });
});
