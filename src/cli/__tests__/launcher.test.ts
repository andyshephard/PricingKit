// bin/pricingkit.mjs must turn tsx's disk cache off before tsx loads: the
// cache is a shared temporary folder whose compiled entries tsx trusts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const launcher = readFileSync(join(__dirname, '../../../bin/pricingkit.mjs'), 'utf8');

describe('bin/pricingkit.mjs', () => {
  it('sets TSX_DISABLE_CACHE before any tsx module is imported', () => {
    const disable = launcher.indexOf("process.env.TSX_DISABLE_CACHE = '1'");
    expect(disable).toBeGreaterThan(-1);
    // No static import of tsx (static imports run before the module body)
    expect(launcher).not.toMatch(/^import .* from ['"]tsx/m);
    const firstTsx = launcher.search(/import\(['"]tsx\//);
    expect(firstTsx).toBeGreaterThan(disable);
  });
});
