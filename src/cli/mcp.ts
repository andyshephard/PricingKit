// pricingkit mcp: a Model Context Protocol server over stdio, so an agent can
// read offers, make plans and summarise them with the same
// commands a person runs. Agents can plan; humans apply.
//
// - Tools: offers, plan, diff (each runs the CLI command in-process
//   with --json) and apply_command, which only reads a plan file and returns
//   the start of the `pricingkit apply` command, without --confirm or the
//   opt-in flags: the person gets the hash from their own diff and adds the
//   flags knowingly. Nothing here can
//   write to a store: there is no apply tool, and the CLI's apply command is
//   never invoked (src/cli/__tests__/mcp.test.ts checks both).
// - Arguments are typed: each tool builds the argv itself, values can't start
//   with "-" (no flag injection). File paths use a safe character set, no
//   ".." segments and nothing under .git/, and must resolve (realpath, so
//   symlinks can't escape) inside the working directory the server was
//   started in. Outputs never replace a file that isn't a plan or state
//   file of the same kind. The command apply_command returns is shell-quoted.
// - Credentials come from the server's environment, as for the CLI, and every
//   output passes the CLI's Redactor.
// - Hand-rolled JSON-RPC 2.0 over newline-delimited stdio (MCP's stdio
//   transport): no SDK dependency. Calls run one at a time.

import { lstat, readFile, realpath, stat as statFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { assertRunMatches, isOfferOp, parseChangeSet, parseRun, parseStateSnapshot } from '@/lib/pricing';
import packageJson from '../../package.json';
import { runCli, type CliIO } from './main';
import { Redactor } from './redact';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

type JsonSchema = { type: 'object'; properties: Record<string, { type: string; description: string; enum?: string[] }>; required?: string[]; additionalProperties: false };
type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Path arguments: read (must exist) or written (out files), and the extensions allowed */
  paths: PathArg[];
  /** Arguments -> CLI argv (always run with --json) */
  argv?: (args: Args) => string[];
}

interface PathArg {
  key: string;
  mode: 'read' | 'write';
  extensions: string[];
  /** write: an existing file may be replaced only if it already parses as this kind */
  kind?: 'changeset' | 'state';
}
const SPEC_EXT = ['.json', '.yaml', '.yml'];
const read = (key: string, extensions = ['.json']): PathArg => ({ key, mode: 'read', extensions });
const write = (key: string, kind: 'changeset' | 'state'): PathArg => ({ key, mode: 'write', extensions: ['.json'], kind });

const str = (description: string, extra: { enum?: string[] } = {}) => ({ type: 'string', description, ...extra });
const APP_PROPS = {
  bundleId: str('App Store app bundle ID (give this or packageName)'),
  packageName: str('Google Play package name (give this or bundleId)'),
};
const appFlags = (a: Args) => [...(a.bundleId ? ['--bundle-id', String(a.bundleId)] : []), ...(a.packageName ? ['--package-name', String(a.packageName)] : [])];
const opt = (flag: string, value: unknown) => (value === undefined ? [] : [flag, String(value)]);

export const TOOLS: Tool[] = [
  {
    name: 'offers',
    description: "List a subscription's offers with prices per territory (App Store) or a base plan's offers with phases, eligibility and tags (Google Play). Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        ...APP_PROPS,
        subscription: str('App Store: numeric subscription ID; Google Play: subscription product ID'),
        basePlan: str('Google Play base plan ID (omit for every base plan)'),
        kind: str('App Store offer kind filter', { enum: ['apple.intro', 'apple.promo', 'apple.offerCode', 'apple.winBack'] }),
      },
      required: ['subscription'],
      additionalProperties: false,
    },
    paths: [],
    argv: (a) => ['offers', ...appFlags(a), '--subscription', String(a.subscription), ...opt('--base-plan', a.basePlan), ...opt('--kind', a.kind)],
  },
  {
    name: 'plan',
    description:
      'Make a plan (dry run: only reads from the store) from a spec (base prices or offers) and/or an offer rules file, and write it to `out`. Returns the plan, without its confirm hash. Applying it is for a person: use apply_command.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: str('Path of a pricingkit.spec or pricingkit.offerPlanSpec file (JSON or YAML)'),
        rules: str('Path of a pricingkit.offerRules file: keep offers in step with base prices'),
        out: str('Path to write the plan file to (replaced if it exists)'),
        scheduledBase: str('With rules: hold (default) or now', { enum: ['hold', 'now'] }),
        stateOut: str('Path to write the prices the plan was made against'),
      },
      required: ['out'],
      additionalProperties: false,
    },
    paths: [read('spec', SPEC_EXT), read('rules', SPEC_EXT), write('out', 'changeset'), write('stateOut', 'state')],
    argv: (a) => ['plan', ...opt('--spec', a.spec), ...opt('--rules', a.rules), '--out', String(a.out), ...opt('--scheduled-base', a.scheduledBase), ...opt('--state-out', a.stateOut)],
  },
  {
    name: 'diff',
    description: 'Summarise a plan file: ops per product and territory, skipped territories, warnings and manual actions (not the confirm hash: the person applying it runs pricingkit diff themselves). Offline: no store requests.',
    inputSchema: { type: 'object', properties: { plan: str('Path of the plan file') }, required: ['plan'], additionalProperties: false },
    paths: [read('plan')],
    argv: (a) => ['diff', String(a.plan)],
  },
  {
    name: 'apply_command',
    description:
      'Returns the start of the `pricingkit apply` command for a plan file, for a person to finish and run: without --confirm (they get the hash by running `pricingkit diff` on the plan themselves) and without the opt-in flags (the result names the ones the plan needs and why, for the person to add). Never applies anything and sends no store requests: agents plan, humans apply.',
    inputSchema: {
      type: 'object',
      properties: { plan: str('Path of the plan file'), resume: str('Path of a run log to resume') },
      required: ['plan'],
      additionalProperties: false,
    },
    paths: [read('plan'), read('resume')],
  },
];

export interface McpServerOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Where the CLI's own stderr lines go (never stdout: that's the protocol channel) */
  log?: (text: string) => void;
  now?: () => Date;
}

class ToolInputError extends Error {}

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

/** Inside `root` (both real paths)? */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** Largest file a tool reads: a plan, run log, spec or rules file */
export const MAX_TOOL_FILE_BYTES = 16 * 1024 * 1024;

/** Throws ToolInputError unless `value` is a safe path inside cwd for this use */
async function checkPath(arg: PathArg, value: string, cwd: string): Promise<void> {
  const fail = (why: string) => new ToolInputError(`${arg.key} must be a file inside the working directory (${why})`);
  if (!SAFE_PATH.test(value) || value.startsWith('-') || value.startsWith('/')) throw fail('letters, digits, ".", "_", "-" and "/" only, relative');
  const segments = value.split('/');
  if (segments.some((s) => s === '..' || s === '' || s === '.')) throw fail('no "..", "." or empty segments');
  if (segments.some((s) => s === '.git')) throw fail('nothing under .git/');
  if (!arg.extensions.includes(extname(value).toLowerCase())) throw fail(`${arg.extensions.join(', ')} only`);
  const root = await realpath(cwd);
  const target = resolve(cwd, value);
  if (arg.mode === 'read') {
    const real = await realpathOrUndefined(target);
    // A missing file is reported by the command itself; an existing one must really be inside
    if (real !== undefined && !inside(root, real)) throw fail('it resolves outside, through a link');
    const parent = await realpathOrUndefined(dirname(target));
    if (parent !== undefined && parent !== root && !inside(root, parent)) throw fail('its folder resolves outside');
    if (real !== undefined) {
      // A FIFO or device would block the server; a huge file would exhaust its memory
      const info = await statFile(real).catch(() => undefined);
      if (!info?.isFile()) throw new ToolInputError(`${arg.key}: ${value} is not a regular file`);
      if (info.size > MAX_TOOL_FILE_BYTES) throw new ToolInputError(`${arg.key}: ${value} is larger than ${MAX_TOOL_FILE_BYTES / 1024 / 1024} MB`);
    }
    return;
  }
  // Written files never go into dot-folders (.github/, .vscode/, ...) or dot-files, where
  // tools pick up configuration and workflows
  if (segments.some((s) => s.startsWith('.'))) throw fail('no folders or files starting with "."');
  const parent = await realpathOrUndefined(dirname(target));
  if (parent === undefined) throw fail('its folder does not exist');
  if (parent !== root && !inside(root, parent)) throw fail('its folder resolves outside, through a link');
  if (parent !== root && relative(root, parent).split(sep).some((s) => s.startsWith('.'))) throw fail('no folders starting with "."');
  let stat;
  try {
    stat = await lstat(target);
  } catch {
    return; // a new file
  }
  if (!stat.isFile()) throw new ToolInputError(`${arg.key}: ${value} exists and is not a plain file; choose another name`);
  try {
    const text = await readFile(target, 'utf8');
    if (arg.kind === 'changeset') parseChangeSet(text);
    else parseStateSnapshot(text);
  } catch {
    throw new ToolInputError(`${arg.key}: ${value} exists and is not a ${arg.kind === 'changeset' ? 'plan' : 'state'} file; it won't be replaced. Choose another name`);
  }
}

async function checkArgs(tool: Tool, args: Args, cwd: string): Promise<void> {
  const props = tool.inputSchema.properties;
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(props, key)) throw new ToolInputError(`Unknown argument "${key}" for ${tool.name}`);
    const spec = props[key];
    if (spec.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string') throw new ToolInputError(`${key} must be a ${spec.type}`);
    if (typeof value === 'string') {
      if (value.trim() === '' || value.startsWith('-')) throw new ToolInputError(`${key} can't be empty or start with "-"`);
      if (spec.enum && !spec.enum.includes(value)) throw new ToolInputError(`${key} must be one of ${spec.enum.join(', ')}`);
    }
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (args[key] === undefined) throw new ToolInputError(`${key} is required`);
  }
  for (const arg of tool.paths) {
    const value = args[arg.key];
    if (typeof value === 'string') await checkPath(arg, value, cwd);
  }
}

/** POSIX shell quoting: safe words as they are, anything else in single quotes (also a leading "=", which zsh expands to a command's path) */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9._/:@%+-][A-Za-z0-9._/:=@%+-]*$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

async function readArgFile(cwd: string, path: string, what: string): Promise<string> {
  try {
    return await readFile(resolve(cwd, path), 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new ToolInputError(`Can't read ${what} ${path}${code ? ` (${code})` : ''}`);
  }
}

/** The apply command for a plan file: read it (offline), never apply it */
async function commandForPlan(args: Args, cwd: string): Promise<ToolResult> {
  const planPath = String(args.plan);
  let changeSet;
  try {
    changeSet = parseChangeSet(await readArgFile(cwd, planPath, 'plan file'));
  } catch (error) {
    throw error instanceof ToolInputError ? error : new ToolInputError((error as Error).message);
  }
  const resumePath = args.resume === undefined ? undefined : String(args.resume);
  let resumeNote: string | undefined;
  if (resumePath !== undefined) {
    try {
      const run = parseRun(await readArgFile(cwd, resumePath, 'run log'));
      assertRunMatches(changeSet, run);
      // A resume runs only pending and failed ops: ones the log records as ok or skipped aren't read or re-checked
      const done = run.ops.filter((r) => r.status === 'ok' || r.status === 'skipped').length;
      resumeNote = `--resume: the run log already records ${done} of ${run.ops.length} ops as done (ok or skipped); they won't be re-checked. ${run.ops.length - done} will be checked against the store and applied if still needed.`;
    } catch (error) {
      throw error instanceof ToolInputError ? error : new ToolInputError(`resume: ${(error as Error).message}`);
    }
  }
  // Deliberately incomplete: no --confirm hash and no opt-in flags. The person applying the plan
  // gets the hash from their own `pricingkit diff` and adds the flags knowingly; an agent can't
  // hand over a ready-to-paste command that skips the review.
  const baseOps = changeSet.ops.filter((op) => !isOfferOp(op)).length;
  const deletes = changeSet.ops.filter((op) => isOfferOp(op) && op.kind === 'deleteOffer').length;
  const argv = ['pricingkit', 'apply', planPath, ...(resumePath !== undefined ? ['--resume', resumePath] : [])];
  const command = argv.map(shellQuote).join(' ');
  const requiredFlags = [
    ...(baseOps > 0 ? [{ flag: '--allow-base-prices', reason: `the plan changes base prices (${baseOps} ${baseOps === 1 ? 'op' : 'ops'}); add it only if you mean to change them` }] : []),
    ...(deletes > 0
      ? [{ flag: '--force-delete', reason: `the plan deletes ${deletes} ${deletes === 1 ? 'offer' : 'offers'}; the store can't tell whether anyone redeemed them, and a deleted offer can't be restored` }]
      : []),
  ];
  const notes = [
    `This server cannot apply plans. A person reviews the plan by running "pricingkit diff ${shellQuote(planPath)}" themselves, then runs this command with --confirm <the hash that diff prints>${requiredFlags.length ? ' and the flags below' : ''}.`,
    ...(changeSet.ops.length === 0 ? ['The plan has no ops: applying it changes nothing.'] : []),
    ...(resumeNote ? [resumeNote] : []),
    ...requiredFlags.map((f) => `${f.flag} is needed: ${f.reason}.`),
    'Pin the app the server may work on with PRICINGKIT_EXPECT_BUNDLE_ID / PRICINGKIT_EXPECT_PACKAGE in its environment.',
  ];
  return {
    content: [{ type: 'text', text: `${command} --confirm <hash from pricingkit diff>\n\n${notes.join('\n')}` }],
    structuredContent: { command, argv, needsConfirm: true, requiredFlags, ops: changeSet.ops.length, notes },
  };
}

/**
 * The message of an unexpected error, safe to send: scrubbed of the
 * credentials in the server's environment and of key/token shapes, and short.
 */
export function internalErrorMessage(error: unknown, env: Record<string, string | undefined>): string {
  const redactor = new Redactor();
  for (const name of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY', 'ASC_PRIVATE_KEY_HEX', 'GOOGLE_SERVICE_ACCOUNT_JSON']) redactor.add(env[name]);
  try {
    const json = env.GOOGLE_SERVICE_ACCOUNT_JSON ? (JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as Record<string, unknown>) : {};
    for (const key of ['private_key', 'private_key_id', 'client_email']) if (typeof json[key] === 'string') redactor.add(json[key] as string);
  } catch {
    // not JSON: the whole value is already registered
  }
  const message = error instanceof Error ? error.message : 'Internal error';
  const clean = redactor.redact(message);
  return clean.length > 300 ? `${clean.slice(0, 300)}...` : clean;
}

// No tool output carries a confirm hash: the person applying a plan gets it
// from their own `pricingkit diff`, so an agent can't hand over a complete
// apply command (or one for a plan nobody reviewed).
const HASH_KEYS = new Set(['hash', 'changeSetHash', 'workspacePlanHash']);
const HASH_NOTE = 'run "pricingkit diff" yourself for the plan hash';

/** A copy of a tool's JSON result without confirm-hash fields */
export function stripHashes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripHashes);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !HASH_KEYS.has(k)).map(([k, v]) => [k, stripHashes(v)]));
  }
  return value;
}

/** Text with anything shaped like a confirm hash (32 hex digits) replaced */
function withoutHashes(text: string): string {
  return text.replace(/\b[0-9a-f]{32}\b/g, `[${HASH_NOTE}]`);
}

export class McpServer {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: McpServerOptions) {}

  private async callTool(name: string, args: Args): Promise<ToolResult> {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      const hint = name === 'apply' ? ' Plans are applied by a person: use apply_command to get the command to run.' : '';
      throw new ToolInputError(`Unknown tool "${name}".${hint}`);
    }
    await checkArgs(tool, args, this.options.cwd);
    if (!tool.argv) return commandForPlan(args, this.options.cwd);

    const argv = [...tool.argv(args), '--json'];
    if (argv[0] === 'apply') throw new Error('Internal error: the MCP server never runs apply');
    let stdout = '';
    let stderr = '';
    const io: CliIO = {
      stdout: (t) => (stdout += t),
      stderr: (t) => {
        stderr += t;
        this.options.log?.(t);
      },
      env: this.options.env,
      cwd: this.options.cwd,
      ...(this.options.now ? { now: this.options.now } : {}),
    };
    const exitCode = await runCli(argv, io);
    let result: unknown = withoutHashes(stdout);
    try {
      result = stripHashes(JSON.parse(stdout));
    } catch {
      // keep the text
    }
    const text = typeof result === 'string' ? result.trim() : JSON.stringify(result, null, 2);
    const errText = withoutHashes(stderr).trim();
    return {
      content: [{ type: 'text', text: `${text}${errText ? `\n\n[stderr]\n${errText}` : ''}\n\n[exit code ${exitCode}]` }],
      structuredContent: { exitCode, result },
      ...(exitCode === 1 ? { isError: true } : {}),
    };
  }

  /** Handle one JSON-RPC message; returns the response, or undefined for a notification */
  async handle(message: unknown): Promise<Record<string, unknown> | undefined> {
    const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const hasId = msg !== null && typeof msg === 'object' && Object.hasOwn(msg, 'id');
    // Only ids JSON-RPC allows are echoed back (string, number); anything else is answered with id null
    const validId = hasId && (typeof msg.id === 'string' || (typeof msg.id === 'number' && Number.isFinite(msg.id)));
    const isRequest = validId;
    const reply = (body: Record<string, unknown>) => (isRequest ? { jsonrpc: '2.0', id: msg.id, ...body } : undefined);
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (hasId && msg.id !== null && !validId)) {
      return { jsonrpc: '2.0', id: validId ? msg.id : null, error: { code: -32600, message: 'Invalid request' } };
    }
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'initialize': {
        const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return reply({
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'pricingkit', version: packageJson.version },
            instructions: 'Read store prices and offers and make plans. Applying a plan is for a person: apply_command returns the start of the command, which they complete with the hash from their own pricingkit diff.',
          },
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return reply({ result: {} });
      case 'tools/list':
        return reply({ result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Args;
        // A notification (no id, or id null) gets no answer, so a tool that writes files (plan) would write
        // silently: refuse it. Read-only tools may still run (their result is simply not sent).
        if (!isRequest && TOOLS.find((t) => t.name === name)?.paths.some((p) => p.mode === 'write')) {
          this.options.log?.(`pricingkit mcp: refused a ${name} call sent as a notification (no id); it writes files, so send it as a request with an id\n`);
          return hasId ? { jsonrpc: '2.0', id: null, error: { code: -32600, message: `${name} writes files: send it as a request with a string or number id` } } : undefined;
        }
        const run = this.queue.then(() => this.callTool(name, args));
        this.queue = run.catch(() => undefined);
        try {
          return reply({ result: await run });
        } catch (error) {
          if (error instanceof ToolInputError) return reply({ result: { content: [{ type: 'text', text: error.message }], isError: true } });
          return reply({ error: { code: -32603, message: internalErrorMessage(error, this.options.env) } });
        }
      }
      default:
        return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  }
}

/** Longest request line accepted (bytes); longer lines are answered with an error and dropped */
export const MAX_LINE_BYTES = 1_000_000;
/** Requests handled at once; reading pauses while this many are in flight */
const MAX_IN_FLIGHT = 16;

/**
 * Serve MCP over newline-delimited JSON on `input` / `output` until input
 * ends. stdout carries protocol messages only. A failing output (e.g. EPIPE
 * when the client went away) stops the server instead of throwing.
 */
export async function serveMcp(options: McpServerOptions & { input: NodeJS.ReadableStream; output: (line: string) => void }): Promise<void> {
  const server = new McpServer(options);
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  const send = (value: unknown) => {
    if (closed) return;
    try {
      options.output(JSON.stringify(value));
    } catch (error) {
      closed = true;
      options.log?.(`pricingkit mcp: output closed (${(error as { code?: string }).code ?? (error as Error).message}); stopping\n`);
    }
  };
  const handleLine = async (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    try {
      const response = await server.handle(message);
      if (response) send(response);
    } catch (error) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: internalErrorMessage(error, options.env) } });
    }
  };

  let buffer = '';
  let dropping = false; // inside an over-long line: skip to its end
  // Bytes are decoded with a StringDecoder, so a multibyte character split across two reads survives
  const decoder = new StringDecoder('utf8');
  for await (const chunk of options.input) {
    if (closed) break;
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (dropping) {
        dropping = false;
        continue;
      }
      if (line.trim() === '') continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Request longer than ${MAX_LINE_BYTES} bytes` } });
        continue;
      }
      const task: Promise<void> = handleLine(line).finally(() => inFlight.delete(task));
      inFlight.add(task);
      if (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight);
    }
    if (!dropping && Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Request longer than ${MAX_LINE_BYTES} bytes` } });
      buffer = '';
      dropping = true;
    } else if (dropping) {
      buffer = '';
    }
  }
  buffer += decoder.end();
  if (!closed && !dropping && buffer.trim() !== '') {
    const task = handleLine(buffer);
    inFlight.add(task);
  }
  await Promise.all(inFlight);
}
