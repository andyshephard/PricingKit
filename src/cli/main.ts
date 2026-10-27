// pricingkit CLI entry. Commands over the framework-free pricing
// core (src/lib/pricing) and the store adapters (src/lib/adapters). Nothing
// here imports Next.js or the web app (the "CLI boundary" tests in
// src/lib/pricing/__tests__/core-boundary.test.ts).
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
import { applyCommand } from './commands/apply';
import { diffCommand } from './commands/diff';
import { undoCommand } from './commands/undo';
import { driftCommand } from './commands/drift';
import { exportCommand } from './commands/export';
import { offerCommand } from './commands/offer';
import { offersCommand } from './commands/offers';
import { planCommand } from './commands/plan';
import { parityCommand } from './commands/parity';

export { EXIT_CHANGES, EXIT_ERROR, EXIT_OK } from './errors';

const HANDLERS: Record<CommandName, (ctx: CommandContext) => Promise<CommandResult>> = {
  export: exportCommand,
  plan: planCommand,
  diff: diffCommand,
  offers: offersCommand,
  offer: offerCommand,
  drift: driftCommand,
  parity: parityCommand,
  apply: applyCommand,
  undo: undoCommand,
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

/**
 * Store tokens the clients mint never pass through the CLI's own code, so
 * watch the requests a command sends for the duration of fn: every bearer
 * credential (Apple JWT, Google access token), Google's signed assertion and
 * the token endpoint's access_token are registered with the Redactor before
 * any response could echo them. Nothing is logged or stored.
 */
async function withTokensRedacted<T>(redactor: Redactor, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return fn();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization');
      if (authorization) redactor.add(authorization.replace(/^Bearer\s+/i, ''));
      if (typeof init?.body === 'string' && init.body.includes('assertion=')) {
        redactor.add(new URLSearchParams(init.body).get('assertion') ?? undefined);
      }
    } catch {
      // Observing must never break a request
    }
    const response = await original(input, init);
    try {
      if (/oauth2|\/token\b/.test(String(input instanceof Request ? input.url : input)) && response.ok) {
        const data = (await response.clone().json()) as { access_token?: unknown };
        if (typeof data.access_token === 'string') redactor.add(data.access_token);
      }
    } catch {
      // Not JSON: nothing to register
    }
    return response;
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** The message of anything thrown: Error, a plain { message } object, or a string. Never "[object Object]". */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function errorJson(error: unknown): { error: { message: string; code?: string | number; status?: number } } {
  const message = errorMessage(error).trim();
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

  return withConsoleOnStderr(err, () => withTokensRedacted(redactor, async () => {
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
      if (budget.used > 0) err(`${budget.used} of ${budget.limit} store requests used\n`);
      return result.exitCode;
    } catch (error) {
      const message = errorMessage(error).trim();
      if (wantsJson) out(`${JSON.stringify(errorJson(error), null, 2)}\n`);
      const status = error instanceof CliError ? undefined : getErrorStatus(error);
      err(`error: ${message}${status ? ` (HTTP ${status})` : ''}\n`);
      if (error instanceof UsageError) err('Run "pricingkit --help" for usage.\n');
      return EXIT_ERROR;
    }
  }));
}

/** Process entry used by bin/pricingkit.mjs */
export async function main(argv = process.argv.slice(2)): Promise<ExitCode> {
  if (argv[0] === 'mcp' && argv.length === 1) {
    // A long-running MCP server over stdio: stdout carries protocol messages only
    const { serveMcp } = await import('./mcp');
    // The client went away (EPIPE): stop reading instead of crashing on an unhandled 'error'
    let outputClosed = false;
    process.stdout.on('error', () => {
      outputClosed = true;
      process.stdin.destroy();
    });
    await serveMcp({
      cwd: process.cwd(),
      env: process.env,
      input: process.stdin,
      output: (line) => {
        if (outputClosed) throw Object.assign(new Error('stdout closed'), { code: 'EPIPE' });
        process.stdout.write(`${line}\n`);
      },
      log: (text) => process.stderr.write(text),
    });
    return EXIT_OK;
  }
  return runCli(argv, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
  });
}
