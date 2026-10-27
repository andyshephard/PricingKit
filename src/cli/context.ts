// What every command gets: parsed flags, the run's request budget, the
// environment (credentials), file access relative to cwd, and store adapters
// built from env credentials.

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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

/** Write an output file (plans, snapshots). Never used for credentials. */
export async function writeOutputFile(ctx: CommandContext, path: string, content: string): Promise<string> {
  const full = resolve(ctx.cwd, path);
  try {
    await writeFile(full, content, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new CliError(`Can't write ${path}${code ? ` (${code})` : ''}`);
  }
  return full;
}

/**
 * Write a file atomically: a temporary file next to it, then a rename, so a
 * crash mid-write never leaves a truncated run log.
 */
export async function writeOutputFileAtomic(ctx: CommandContext, path: string, content: string): Promise<string> {
  const full = resolve(ctx.cwd, path);
  const temp = `${full}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, content, 'utf8');
    await rename(temp, full);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    const code = (error as { code?: string }).code;
    throw new CliError(`Can't write ${path}${code ? ` (${code})` : ''}`);
  }
  return full;
}

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
