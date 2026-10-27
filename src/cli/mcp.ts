// pricingkit mcp: a Model Context Protocol server over stdio, so an agent can
// read offers, check drift, make plans and summarise them with the same
// commands a person runs. Agents can plan; humans apply.
//
// - Tools: offers, drift, plan, diff (each runs the CLI command in-process
//   with --json) and apply_command, which only reads a plan file and returns
//   the exact `pricingkit apply` command a person must run. Nothing here can
//   write to a store: there is no apply tool, and the CLI's apply command is
//   never invoked (src/cli/__tests__/mcp.test.ts checks both).
// - Arguments are typed: each tool builds the argv itself, values can't start
//   with "-" (no flag injection), and file paths must stay inside the working
//   directory the server was started in.
// - Credentials come from the server's environment, as for the CLI, and every
//   output passes the CLI's Redactor.
// - Hand-rolled JSON-RPC 2.0 over newline-delimited stdio (MCP's stdio
//   transport): no SDK dependency. Calls run one at a time.

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { changeSetHash, isOfferOp, parseChangeSet } from '@/lib/pricing';
import packageJson from '../../package.json';
import { runCli, type CliIO } from './main';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

type JsonSchema = { type: 'object'; properties: Record<string, { type: string; description: string; enum?: string[] }>; required?: string[]; additionalProperties: false };
type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Paths among the arguments (checked to stay inside the working directory) */
  paths: string[];
  /** Arguments -> CLI argv (always run with --json) */
  argv?: (args: Args) => string[];
}

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
    name: 'drift',
    description:
      'Check offers against their rules: every offer in a rules file (rules), or one offer (app, subscription, offer and percent or relativeDiscount). Read-only. exitCode 2 = drift found, 0 = in sync, 1 = error.',
    inputSchema: {
      type: 'object',
      properties: {
        rules: str('Path of a pricingkit.offerRules file (JSON or YAML), relative to the working directory'),
        ...APP_PROPS,
        subscription: str('Subscription (single-offer check)'),
        basePlan: str('Google Play base plan ID (single-offer check)'),
        kind: str('App Store offer kind (single-offer check)', { enum: ['apple.intro', 'apple.promo', 'apple.offerCode', 'apple.winBack'] }),
        offer: str('Offer key or ID (single-offer check)'),
        percent: str('Percent of each territory price, e.g. "50"'),
        relativeDiscount: str('Google Play: relative discount fraction, e.g. "0.5"'),
        basis: str('perPeriod or totalOverDuration', { enum: ['perPeriod', 'totalOverDuration'] }),
        threshold: str('Deviation threshold, 0..1'),
        territories: str('Comma-separated territories to check, e.g. "GB,US"'),
      },
      additionalProperties: false,
    },
    paths: ['rules'],
    argv: (a) => [
      'drift',
      ...opt('--rules', a.rules),
      ...appFlags(a),
      ...opt('--subscription', a.subscription),
      ...opt('--base-plan', a.basePlan),
      ...opt('--kind', a.kind),
      ...opt('--offer', a.offer),
      ...opt('--percent', a.percent),
      ...opt('--relative-discount', a.relativeDiscount),
      ...opt('--basis', a.basis),
      ...opt('--threshold', a.threshold),
      ...opt('--territories', a.territories),
    ],
  },
  {
    name: 'plan',
    description:
      'Make a plan (dry run: only reads from the store) from a spec (base prices or offers) and/or an offer rules file, and write it to `out`. Returns the plan and its hash. Applying it is for a person: use apply_command.',
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
    paths: ['spec', 'rules', 'out', 'stateOut'],
    argv: (a) => ['plan', ...opt('--spec', a.spec), ...opt('--rules', a.rules), '--out', String(a.out), ...opt('--scheduled-base', a.scheduledBase), ...opt('--state-out', a.stateOut)],
  },
  {
    name: 'diff',
    description: 'Summarise a plan file: ops per product and territory, skipped territories, warnings, manual actions and the plan hash. Offline: no store requests.',
    inputSchema: { type: 'object', properties: { plan: str('Path of the plan file') }, required: ['plan'], additionalProperties: false },
    paths: ['plan'],
    argv: (a) => ['diff', String(a.plan)],
  },
  {
    name: 'apply_command',
    description:
      'Returns the exact `pricingkit apply` command a person must run, after reviewing the plan, to apply a plan file (with the flags it needs: --allow-base-prices for base prices, --force-delete for deletes). Never applies anything and sends no store requests: agents plan, humans apply.',
    inputSchema: {
      type: 'object',
      properties: { plan: str('Path of the plan file'), resume: str('Path of a run log to resume') },
      required: ['plan'],
      additionalProperties: false,
    },
    paths: ['plan', 'resume'],
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

function checkArgs(tool: Tool, args: Args, cwd: string): void {
  const props = tool.inputSchema.properties;
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) throw new ToolInputError(`Unknown argument "${key}" for ${tool.name}`);
    if (spec.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string') throw new ToolInputError(`${key} must be a ${spec.type}`);
    if (typeof value === 'string') {
      if (value.trim() === '' || value.startsWith('-')) throw new ToolInputError(`${key} can't be empty or start with "-"`);
      if (spec.enum && !spec.enum.includes(value)) throw new ToolInputError(`${key} must be one of ${spec.enum.join(', ')}`);
    }
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (args[key] === undefined) throw new ToolInputError(`${key} is required`);
  }
  for (const key of tool.paths) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const rel = relative(cwd, resolve(cwd, value));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new ToolInputError(`${key} must be a file inside the working directory`);
  }
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

/** The apply command for a plan file: read it (offline), never apply it */
async function commandForPlan(args: Args, cwd: string): Promise<ToolResult> {
  const planPath = String(args.plan);
  let text: string;
  try {
    text = await readFile(resolve(cwd, planPath), 'utf8');
  } catch (error) {
    throw new ToolInputError(`Can't read plan file ${planPath}${(error as { code?: string }).code ? ` (${(error as { code: string }).code})` : ''}`);
  }
  let changeSet;
  try {
    changeSet = parseChangeSet(text);
  } catch (error) {
    throw new ToolInputError((error as Error).message);
  }
  const hash = changeSetHash(changeSet);
  const baseOps = changeSet.ops.filter((op) => !isOfferOp(op)).length;
  const deletes = changeSet.ops.filter((op) => isOfferOp(op) && op.kind === 'deleteOffer').length;
  const command = [
    'pricingkit apply',
    planPath,
    '--confirm',
    hash,
    ...(args.resume ? ['--resume', String(args.resume)] : []),
    ...(baseOps > 0 ? ['--allow-base-prices'] : []),
    ...(deletes > 0 ? ['--force-delete'] : []),
  ].join(' ');
  const notes = [
    'A person must review the plan (pricingkit diff) and run this command themselves; this server cannot apply plans.',
    ...(changeSet.ops.length === 0 ? ['The plan has no ops: applying it changes nothing.'] : []),
    ...(baseOps > 0 ? [`--allow-base-prices: the plan changes base prices (${baseOps} ops).`] : []),
    ...(deletes > 0 ? [`--force-delete: the plan deletes ${deletes} offer(s), which the store can't check for redemptions or can't undo.`] : []),
  ];
  return {
    content: [{ type: 'text', text: `${command}\n\n${notes.join('\n')}` }],
    structuredContent: { command, hash, ops: changeSet.ops.length, notes },
  };
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
    checkArgs(tool, args, this.options.cwd);
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
    let result: unknown = stdout;
    try {
      result = JSON.parse(stdout);
    } catch {
      // keep the text
    }
    return {
      content: [{ type: 'text', text: `${stdout.trim()}${stderr.trim() ? `\n\n[stderr]\n${stderr.trim()}` : ''}\n\n[exit code ${exitCode}]` }],
      structuredContent: { exitCode, result },
      ...(exitCode === 1 ? { isError: true } : {}),
    };
  }

  /** Handle one JSON-RPC message; returns the response, or undefined for a notification */
  async handle(message: unknown): Promise<Record<string, unknown> | undefined> {
    const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const isRequest = msg && typeof msg === 'object' && 'id' in msg && msg.id !== undefined && msg.id !== null;
    const reply = (body: Record<string, unknown>) => (isRequest ? { jsonrpc: '2.0', id: msg.id, ...body } : undefined);
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id: isRequest ? msg.id : null, error: { code: -32600, message: 'Invalid request' } };
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
            instructions: 'Read store prices and offers, check drift and make plans. Applying a plan is for a person: apply_command returns the command to run.',
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
        const run = this.queue.then(() => this.callTool(name, args));
        this.queue = run.catch(() => undefined);
        try {
          return reply({ result: await run });
        } catch (error) {
          if (error instanceof ToolInputError) return reply({ result: { content: [{ type: 'text', text: error.message }], isError: true } });
          return reply({ error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' } });
        }
      }
      default:
        return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  }
}

/**
 * Serve MCP over newline-delimited JSON on `input` / `output` until input
 * ends. stdout carries protocol messages only.
 */
export async function serveMcp(options: McpServerOptions & { input: NodeJS.ReadableStream; output: (line: string) => void }): Promise<void> {
  const server = new McpServer(options);
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  const pending: Array<Promise<void>> = [];
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      options.output(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      continue;
    }
    pending.push(
      server.handle(message).then((response) => {
        if (response) options.output(JSON.stringify(response));
      })
    );
  }
  await Promise.all(pending);
}
