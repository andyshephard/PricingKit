// Every route that can change a store is POST/PATCH/PUT/DELETE behind a
// session: it takes credentials only from @/middleware/auth. The only
// exceptions are sign-in/out and app selection (which create or clear the
// session) and saving an Open Exchange Rates key (public by design, rate limited).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const API = resolve(__dirname, '..');
const SESSIONLESS = new Set(['auth/route.ts', 'apple/auth/route.ts', 'active-app/route.ts', 'apple/active-app/route.ts', 'settings/exchange-rates/route.ts']);

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : routes(full);
    return name === 'route.ts' ? [full] : [];
  });
}

describe('write routes need a session', () => {
  const files = routes(API).map((f) => ({ path: relative(API, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }));
  const writers = files.filter((f) => /export (async function|const) (POST|PATCH|PUT|DELETE)\b/.test(f.text));

  it('finds the offer write routes', () => {
    expect(writers.map((f) => f.path)).toEqual(expect.arrayContaining(['apple/subscriptions/[id]/offers/plan/route.ts', 'apple/subscriptions/[id]/offers/apply/route.ts']));
  });

  it.each(writers.filter((f) => !SESSIONLESS.has(f.path)).map((f) => [f.path, f.text]))('%s takes credentials from @/middleware/auth', (_path, text) => {
    expect(text).toMatch(/from '@\/middleware\/auth'/);
    expect(text).toMatch(/get(Apple|Google)AuthFromCookies\(\)|with(Apple|Google)Auth\(|require(Apple|Google)Auth\(/);
  });

  it('offer routes write only through POST, never GET', () => {
    for (const f of files.filter((f) => f.path.startsWith('apple/subscriptions/[id]/offers/'))) {
      const writes = /AppleAdapter|applyChangeSet/.test(f.text) && /applyChangeSet/.test(f.text);
      if (writes) expect(f.text).not.toMatch(/export (async function|const) GET\b/);
    }
  });
});
