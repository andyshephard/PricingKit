// What every command gets: parsed flags, the run's request budget, the
// environment (credentials), file access relative to cwd, and store adapters
// built from env credentials.

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AppleAdapter } from '@/lib/adapters/apple';
import { PlayAdapter } from '@/lib/adapters/play';
import type { ProductPriceState, ProductRef, ResolveResult, ResolveTarget, SnapMode } from '@/lib/pricing';
import type { RequestBudget } from '@/lib/utils/request-budget';
import type { Flags } from './args';
import { appleCredentialsFromEnv, googleCredentialsFromEnv } from './credentials';
import { CliError, type ExitCode } from './errors';
import type { Redactor } from './redact';

export interface CommandContext {
  flags: Flags;
  positionals: string[];
  json: boolean;
  budget: RequestBudget;
  env: Record<string, string | undefined>;
  cwd: string;
  redactor: Redactor;
  now: () => Date;
}

export interface CommandResult {
  exitCode: ExitCode;
  /** Printed with --json */
  json: unknown;
  /** Printed otherwise */
  text: string;
}

export async function readInputFile(ctx: CommandContext, path: string, what: string): Promise<string> {
  try {
    return await readFile(resolve(ctx.cwd, path), 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new CliError(`Can't read ${what} ${path}${code ? ` (${code})` : ''}`);
  }
}

/**
 * Write an output file (plans, snapshots, run logs). Never used for credentials.
 *
 * Always atomic and never through a link: the content goes to a new
 * temporary file next to the target (created with O_EXCL | O_NOFOLLOW, so a
 * planted file or link there is refused), then rename() replaces the
 * target's directory entry. rename() never follows a link at the target, so
 * a symlink or hard link swapped in after the checks is replaced, not written
 * through. An existing target that is a symlink, not a plain file, or a file
 * with more than one hard link is refused before anything is written (a link
 * there means someone expects the write to land elsewhere).
 */
export async function writeOutputFile(ctx: CommandContext, path: string, content: string): Promise<string> {
  const full = resolve(ctx.cwd, path);
  const fail = (why: string) => new CliError(`Can't write ${path} (${why})`);
  const checkTarget = async () => {
    let stat;
    try {
      stat = await lstat(full);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') return;
      throw fail(code ?? 'unreadable');
    }
    if (stat.isSymbolicLink()) throw fail('it is a symbolic link; it won\'t be written through or replaced');
    if (!stat.isFile()) throw fail('it exists and is not a plain file');
    if (stat.nlink > 1) throw fail(`it has ${stat.nlink} hard links; it won't be replaced`);
  };
  await checkTarget();
  const temp = join(dirname(full), `.${basename(full)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let created = false;
  try {
    const handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o666);
    created = true;
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    await checkTarget();
    await rename(temp, full);
  } catch (error) {
    if (created) await rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof CliError) throw error;
    const code = (error as { code?: string }).code;
    throw new CliError(`Can't write ${path}${code ? ` (${code})` : ''}`);
  }
  return full;
}

/** Same as writeOutputFile (every output file is written atomically); kept for the run log's call sites */
export const writeOutputFileAtomic = writeOutputFile;

/**
 * Optional pins: PRICINGKIT_EXPECT_BUNDLE_ID / PRICINGKIT_EXPECT_PACKAGE name
 * the only app this environment may touch (e.g. a CI job for one app). Any
 * other app, from a flag, a spec, a rules file or a plan, is refused before
 * credentials are loaded or anything is sent.
 */
export function assertExpectedApp(ctx: Pick<CommandContext, 'env'>, app: { bundleId: string } | { packageName: string }): void {
  const [variable, expected, actual] =
    'bundleId' in app ? ['PRICINGKIT_EXPECT_BUNDLE_ID', ctx.env.PRICINGKIT_EXPECT_BUNDLE_ID, app.bundleId] : ['PRICINGKIT_EXPECT_PACKAGE', ctx.env.PRICINGKIT_EXPECT_PACKAGE, app.packageName];
  if (expected !== undefined && expected.trim() !== '' && expected.trim() !== actual) {
    throw new CliError(`${actual} is not the app ${variable} allows (${expected.trim()}); nothing was read or sent`, 'APP_NOT_EXPECTED');
  }
}

export async function appleAdapter(ctx: CommandContext, bundleId: string): Promise<AppleAdapter> {
  assertExpectedApp(ctx, { bundleId });
  const credentials = await appleCredentialsFromEnv(ctx.env, bundleId, ctx.redactor);
  return new AppleAdapter({ credentials, budget: ctx.budget, now: ctx.now });
}

export async function playAdapter(ctx: CommandContext, packageName: string): Promise<PlayAdapter> {
  assertExpectedApp(ctx, { packageName });
  const credentials = await googleCredentialsFromEnv(ctx.env, ctx.redactor);
  return new PlayAdapter({ credentials, packageName, budget: ctx.budget });
}

/**
 * The read side of an adapter and nothing else. `plan` only ever holds one
 * of these, so it has no way to reach apply().
 */
export interface PriceReader {
  fetchState(product: ProductRef): Promise<ProductPriceState>;
  resolvePricePoints(product: ProductRef, targets: Record<string, ResolveTarget>, options?: { mode?: SnapMode }): Promise<ResolveResult>;
  /** Google Play: the regions version to record in a base-price plan (read-only price conversion) */
  fetchRegionsVersion?(): Promise<string | undefined>;
}

export function readOnly(adapter: PriceReader): PriceReader {
  return {
    fetchState: (product) => adapter.fetchState(product),
    resolvePricePoints: (product, targets, options) => adapter.resolvePricePoints(product, targets, options),
    ...(adapter.fetchRegionsVersion ? { fetchRegionsVersion: () => adapter.fetchRegionsVersion!() } : {}),
  };
}
