// pricingkit CLI entry. Read-only commands over the framework-free pricing
// core (src/lib/pricing) and the store adapters (src/lib/adapters). Nothing
// here imports Next.js or the web app (src/cli/__tests__/cli-boundary.test.ts).
//
// stdout carries the result only (JSON with --json); everything else, including
// the store clients' own console logging, goes to stderr. Every line passes
// through the Redactor first.

import { format } from 'node:util';
import { getErrorStatus } from '@/lib/utils/api-error';
import { RequestBudget } from '@/lib/utils/request-budget';
import packageJson from '../../package.json';
import { COMMAND_HELP, MAIN_HELP, parseCliArgs, type CommandName } from './args';
import type { CommandContext, CommandResult } from './context';
import { CliError, EXIT_ERROR, EXIT_OK, UsageError, type ExitCode } from './errors';
import { Redactor } from './redact';
import { diffCommand } from './commands/diff';
import { driftCommand } from './commands/drift';
import { exportCommand } from './commands/export';
import { offersCommand } from './commands/offers';
import { planCommand } from './commands/plan';

export { EXIT_CHANGES, EXIT_ERROR, EXIT_OK } from './errors';

const HANDLERS: Record<CommandName, (ctx: CommandContext) => Promise<CommandResult>> = {
  export: exportCommand,
  plan: planCommand,
  diff: diffCommand,
  offers: offersCommand,
  drift: driftCommand,
};

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  now?: () => Date;
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Send console output (store clients log retries and error bodies) to stderr, redacted, for the duration of fn */
async function withConsoleOnStderr<T>(write: (text: string) => void, fn: () => Promise<T>): Promise<T> {
  const saved = CONSOLE_METHODS.map((m) => console[m]);
  for (const m of CONSOLE_METHODS) console[m] = (...args: unknown[]) => write(`${format(...args)}\n`);
  try {
    return await fn();
  } finally {
    CONSOLE_METHODS.forEach((m, i) => (console[m] = saved[i]));
  }
}

function errorJson(error: unknown): { error: { message: string; code?: string | number; status?: number } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof CliError ? error.code : ((error as { code?: string | number })?.code ?? undefined);
  const status = error instanceof CliError ? undefined : getErrorStatus(error);
  return { error: { message, ...(code !== undefined ? { code } : {}), ...(status !== undefined ? { status } : {}) } };
}

/** Run the CLI. Never throws; returns the exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<ExitCode> {
  const redactor = new Redactor();
  const out = (text: string) => io.stdout(redactor.redact(text));
  const err = (text: string) => io.stderr(redactor.redact(text));
  const wantsJson = argv.includes('--json');

  return withConsoleOnStderr(err, async () => {
    try {
      const args = parseCliArgs(argv);
      if (args.kind === 'help') {
        out(`${args.command ? COMMAND_HELP[args.command] : MAIN_HELP}\n`);
        return EXIT_OK;
      }
      if (args.kind === 'version') {
        out(`${packageJson.version}\n`);
        return EXIT_OK;
      }

      const budget = new RequestBudget({ limit: args.budget });
      const ctx: CommandContext = {
        flags: args.flags,
        positionals: args.positionals,
        json: args.json,
        budget,
        env: io.env,
        cwd: io.cwd,
        redactor,
        now: io.now ?? (() => new Date()),
      };
      const result = await HANDLERS[args.command](ctx);
      out(args.json ? `${JSON.stringify(result.json, null, 2)}\n` : `${result.text}\n`);
      err(`${budget.used} of ${budget.limit} store requests used\n`);
      return result.exitCode;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).trim();
      if (wantsJson) out(`${JSON.stringify(errorJson(error), null, 2)}\n`);
      const status = error instanceof CliError ? undefined : getErrorStatus(error);
      err(`error: ${message}${status ? ` (HTTP ${status})` : ''}\n`);
      if (error instanceof UsageError) err('Run "pricingkit --help" for usage.\n');
      return EXIT_ERROR;
    }
  });
}

/** Process entry used by bin/pricingkit.mjs */
export async function main(argv = process.argv.slice(2)): Promise<ExitCode> {
  return runCli(argv, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
  });
}
