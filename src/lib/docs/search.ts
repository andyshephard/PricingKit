import type { DocSearchEntry } from '@/content/docs/types';

const MAX_RESULTS = 8;

/** Entries whose title (or context) contains every word typed; title matches first */
export function searchDocs(index: readonly DocSearchEntry[], query: string): DocSearchEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: Array<{ entry: DocSearchEntry; score: number }> = [];
  for (const entry of index) {
    const title = entry.title.toLowerCase();
    const all = `${title} ${entry.context.toLowerCase()}`;
    if (!words.every((w) => all.includes(w))) continue;
    const inTitle = words.filter((w) => title.includes(w)).length;
    const starts = title.startsWith(words[0]) ? 1 : 0;
    scored.push({ entry, score: inTitle * 2 + starts + (entry.href.includes('#') ? 0 : 1) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS).map((s) => s.entry);
}
