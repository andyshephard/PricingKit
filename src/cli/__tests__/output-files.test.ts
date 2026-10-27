// CLI output files (plans, snapshots, run logs) are written atomically and
// never through a link.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { chmodSync, linkSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { writeOutputFile, type CommandContext } from '../context';
import { CliError } from '../errors';
import { tempDir } from './fixtures';

let tmp: ReturnType<typeof tempDir>;
let ctx: CommandContext;
beforeEach(() => {
  tmp = tempDir();
  ctx = { cwd: tmp.dir } as CommandContext;
});
afterEach(() => tmp.cleanup());

describe('writeOutputFile', () => {
  it('writes a new file and replaces a plain one, leaving no temporary files', async () => {
    await writeOutputFile(ctx, 'out.json', 'one');
    await writeOutputFile(ctx, 'out.json', 'two');
    expect(readFileSync(join(tmp.dir, 'out.json'), 'utf8')).toBe('two');
    expect(readdirSync(tmp.dir)).toEqual(['out.json']);
  });

  it('keeps the permissions of a file it replaces', async () => {
    writeFileSync(join(tmp.dir, 'private.json'), 'one');
    chmodSync(join(tmp.dir, 'private.json'), 0o600);
    await writeOutputFile(ctx, 'private.json', 'two');
    expect(statSync(join(tmp.dir, 'private.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(tmp.dir, 'private.json'), 'utf8')).toBe('two');
  });

  it('refuses a symbolic link at the target and leaves its target alone', async () => {
    writeFileSync(join(tmp.dir, 'victim.txt'), 'keep');
    symlinkSync(join(tmp.dir, 'victim.txt'), join(tmp.dir, 'link.json'));
    await expect(writeOutputFile(ctx, 'link.json', 'evil')).rejects.toThrow(/symbolic link/);
    expect(readFileSync(join(tmp.dir, 'victim.txt'), 'utf8')).toBe('keep');
    expect(lstatSync(join(tmp.dir, 'link.json')).isSymbolicLink()).toBe(true);
  });

  it('refuses a file with more than one hard link', async () => {
    writeFileSync(join(tmp.dir, 'a.json'), 'keep');
    linkSync(join(tmp.dir, 'a.json'), join(tmp.dir, 'b.json'));
    const error = await writeOutputFile(ctx, 'b.json', 'evil').catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toMatch(/2 hard links/);
    expect(readFileSync(join(tmp.dir, 'a.json'), 'utf8')).toBe('keep');
  });

  it('refuses a folder, and reports a missing folder by code', async () => {
    await expect(writeOutputFile(ctx, '.', 'x')).rejects.toThrow(/not a plain file/);
    await expect(writeOutputFile(ctx, 'missing/out.json', 'x')).rejects.toThrow(/Can't write missing\/out\.json \(ENOENT\)/);
  });
});
