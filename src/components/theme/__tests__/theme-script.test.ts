import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { THEME_SCRIPT, THEME_SCRIPT_SHA256, THEME_STORAGE_KEY } from '../theme-script';

type Doc = { classList: Set<string>; colorScheme: string };

// Runs the boot script against a stand-in document, storage and media query.
function run({ stored, systemDark, storageThrows = false }: { stored?: string | null; systemDark: boolean; storageThrows?: boolean }): Doc {
  const doc: Doc = { classList: new Set(), colorScheme: '' };
  const documentElement = {
    classList: { toggle: (name: string, on: boolean) => (on ? doc.classList.add(name) : doc.classList.delete(name)) },
    style: {
      set colorScheme(value: string) {
        doc.colorScheme = value;
      },
    },
  };
  const localStorage = {
    getItem: (key: string) => {
      if (storageThrows) throw new Error('blocked');
      return key === THEME_STORAGE_KEY ? (stored ?? null) : null;
    },
  };
  const window = { matchMedia: (q: string) => ({ matches: q.includes('dark') && systemDark }) };
  new Function('document', 'localStorage', 'window', THEME_SCRIPT)({ documentElement }, localStorage, window);
  return doc;
}

describe('theme boot script', () => {
  it('follows the system setting when nothing is stored', () => {
    expect(run({ systemDark: true }).classList.has('dark')).toBe(true);
    expect(run({ systemDark: false }).classList.has('dark')).toBe(false);
  });

  it('prefers the stored choice over the system setting', () => {
    expect(run({ stored: 'light', systemDark: true }).classList.has('dark')).toBe(false);
    const dark = run({ stored: 'dark', systemDark: false });
    expect(dark.classList.has('dark')).toBe(true);
    expect(dark.colorScheme).toBe('dark');
  });

  it('ignores unknown stored values and blocked storage', () => {
    expect(run({ stored: 'sepia', systemDark: true }).classList.has('dark')).toBe(true);
    expect(run({ storageThrows: true, systemDark: false }).colorScheme).toBe('light');
  });

  it('publishes the CSP hash of the exact script', () => {
    const hash = createHash('sha256').update(THEME_SCRIPT, 'utf8').digest('base64');
    expect(THEME_SCRIPT_SHA256).toBe(`sha256-${hash}`);
  });
});
