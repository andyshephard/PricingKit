// Route files must get credentials from src/middleware/auth.ts, never define
// their own cookie helper or import one from another route file.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const API = join(__dirname, '..');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

describe('auth helpers', () => {
  it('are defined once, in src/middleware/auth.ts', () => {
    const offenders: string[] = [];
    for (const file of routeFiles(API)) {
      const source = readFileSync(file, 'utf8');
      if (/from\s+'[^']*auth\/route'/.test(source)) offenders.push(`${relative(API, file)} imports a route file`);
      if (/export\s+async\s+function\s+get\w*AuthFromCookies/.test(source)) {
        offenders.push(`${relative(API, file)} defines its own auth helper`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
