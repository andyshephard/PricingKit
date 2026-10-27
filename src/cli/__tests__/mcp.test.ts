// pricingkit mcp: the MCP server's tools, their schemas and refusals, and
// the stdio transport. Agents can plan; humans apply: no tool writes to a
// store. The App Store client is mocked: nothing leaves the process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});

import { FakeOfferStore } from '@/lib/adapters/__tests__/fake-apple-offer-store';
import { changeSetHash, parseChangeSet } from '@/lib/pricing';
import { McpServer, serveMcp, TOOLS } from '../mcp';
import { run as runCliCaptured, fakeAppleEnv, tempDir } from './fixtures';

const BUNDLE = 'com.example.app';
const A = '9900000001';
let store: FakeOfferStore;
let env: Record<string, string>;
let tmp: ReturnType<typeof tempDir>;
let server: McpServer;
let nextId = 0;

async function call(method: string, params: Record<string, unknown> = {}) {
  return (await server.handle({ jsonrpc: '2.0', id: ++nextId, method, params })) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}
async function tool(name: string, args: Record<string, unknown>) {
  const r = await call('tools/call', { name, arguments: args });
  return r.result as { content: Array<{ text: string }>; structuredContent?: { exitCode?: number; result?: unknown; command?: string; hash?: string }; isError?: boolean };
}
const writeJson = (name: string, value: unknown) => writeFileSync(join(tmp.dir, name), JSON.stringify(value));

beforeEach(async () => {
  store = new FakeOfferStore().addSubscription(A, 'ONE_YEAR', { USA: '49.99', GBR: '44.99' }, { USA: ['24.99', '27.99', '49.99', '54.99'], GBR: ['22.99', '24.99', '44.99', '49.99'] });
  store.seedPromo(A, 'example_annual_50', {}, { USA: '24.99', GBR: '22.99' });
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation(store.handle);
  env = await fakeAppleEnv();
  tmp = tempDir();
  server = new McpServer({ cwd: tmp.dir, env, now: () => new Date('2030-01-01T00:00:00Z') });
  writeJson('rules.json', {
    kind: 'pricingkit.offerRules',
    schemaVersion: 1,
    app: { bundleId: BUNDLE },
    offers: [{ product: { platform: 'apple', type: 'subscription', id: A }, kind: 'apple.promo', key: 'example_annual_50', pricing: { type: 'percentOfCurrent', percent: '50', snap: 'nearest' }, syncWithBase: true }],
  });
  writeJson('base.json', { kind: 'pricingkit.spec', schemaVersion: 1, app: { bundleId: BUNDLE }, products: [{ product: { platform: 'apple', type: 'subscription', id: A }, targets: { type: 'fixed', prices: { US: '54.99', GB: '49.99' } } }] });
});
afterEach(() => tmp.cleanup());

describe('MCP protocol', () => {
  it('initializes, answers ping and lists exactly the read and plan tools', async () => {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pricingkit' } });
    expect((await call('initialize', { protocolVersion: '1999-01-01' })).result!.protocolVersion).toBe('2025-06-18');
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect((await call('ping')).result).toEqual({});
    expect((await call('nope')).error).toMatchObject({ code: -32601 });

    const list = (await call('tools/list')).result as { tools: Array<{ name: string; inputSchema: { type: string; additionalProperties: boolean; properties: Record<string, unknown>; required?: string[] } }> };
    expect(list.tools.map((t) => t.name)).toEqual(['offers', 'drift', 'plan', 'diff', 'apply_command']);
    for (const t of list.tools) {
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      for (const key of t.inputSchema.required ?? []) expect(t.inputSchema.properties).toHaveProperty(key);
    }
    // No tool can write: none maps to the CLI's apply, and none takes --confirm or force flags
    for (const t of TOOLS) {
      expect(t.name).not.toBe('apply');
      expect(Object.keys(t.inputSchema.properties)).not.toEqual(expect.arrayContaining(['confirm']));
      expect(Object.keys(t.inputSchema.properties).some((k) => /force|confirm|allow/i.test(k))).toBe(false);
    }
  });
});

describe('MCP tools', () => {
  it('drift and offers run the read-only commands', async () => {
    const drift = await tool('drift', { rules: 'rules.json' });
    expect(drift.structuredContent).toMatchObject({ exitCode: 0, result: { kind: 'pricingkit.rulesDrift', inSync: true } });
    const offers = await tool('offers', { bundleId: BUNDLE, subscription: A, kind: 'apple.promo' });
    expect(offers.structuredContent).toMatchObject({ exitCode: 0, result: { kind: 'pricingkit.offers' } });
    expect(store.writes()).toEqual([]);
  });

  it('plan writes a plan file, diff summarises it, apply_command returns the command and applies nothing', async () => {
    const plan = await tool('plan', { spec: 'base.json', rules: 'rules.json', out: 'plans/plan.json' });
    // plans/ doesn't exist: the CLI reports it, nothing is written
    expect(plan.isError).toBe(true);
    const ok = await tool('plan', { spec: 'base.json', rules: 'rules.json', out: 'plan.json' });
    expect(ok.structuredContent!.exitCode).toBe(2);
    const changeSet = parseChangeSet(readFileSync(join(tmp.dir, 'plan.json'), 'utf8'));
    const hash = changeSetHash(changeSet);
    expect((ok.structuredContent!.result as { hash: string }).hash).toBe(hash);

    const diff = await tool('diff', { plan: 'plan.json' });
    expect(diff.structuredContent).toMatchObject({ exitCode: 2, result: { changeSetHash: hash, byGroup: { basePrices: 2, offers: 1 } } });

    const before = appleApiRequest.mock.calls.length;
    const command = await tool('apply_command', { plan: 'plan.json' });
    expect(command.structuredContent!.command).toBe(`pricingkit apply plan.json --confirm ${hash} --allow-base-prices`);
    expect(command.content[0].text).toMatch(/A person must review the plan/);
    expect(appleApiRequest.mock.calls.length).toBe(before);
    expect(store.writes()).toEqual([]);
    expect(readdirSync(tmp.dir).some((f) => f.endsWith('.run.json'))).toBe(false);

    // The command it returns works for the person who runs it
    const applied = await runCliCaptured((command.structuredContent!.command as string).split(' ').slice(1), { env, cwd: tmp.dir });
    expect(applied.code).toBe(0);
    expect(store.writes()).toHaveLength(3);
  });

  it('apply_command adds --force-delete for deletes and --resume when asked', async () => {
    const del = await runCliCaptured(['offer', 'delete', '--bundle-id', BUNDLE, '--subscription', A, '--kind', 'apple.promo', '--offer', 'example_annual_50', '--out', 'del.json'], { env, cwd: tmp.dir });
    expect(del.code).toBe(2);
    const hash = changeSetHash(parseChangeSet(readFileSync(join(tmp.dir, 'del.json'), 'utf8')));
    const r = await tool('apply_command', { plan: 'del.json', resume: 'del.run.json' });
    expect(r.structuredContent!.command).toBe(`pricingkit apply del.json --confirm ${hash} --resume del.run.json --force-delete`);
  });

  it('refuses apply, unknown arguments, flag injection and paths outside the working directory', async () => {
    const apply = await tool('apply', { plan: 'plan.json' });
    expect(apply.isError).toBe(true);
    expect(apply.content[0].text).toMatch(/Unknown tool "apply"\. Plans are applied by a person: use apply_command/);

    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['plan', { spec: 'base.json' }, /out is required/],
      ['plan', { spec: 'base.json', out: 'p.json', confirm: 'x' }, /Unknown argument "confirm"/],
      ['drift', { rules: '--help' }, /can't be empty or start with "-"/],
      ['offers', { bundleId: BUNDLE, subscription: A, kind: 'apple.everything' }, /kind must be one of/],
      ['offers', { bundleId: BUNDLE, subscription: 9900000001 }, /subscription must be a string/],
      ['plan', { spec: '../outside.json', out: 'p.json' }, /spec must be a file inside the working directory/],
      ['diff', { plan: '/etc/hosts' }, /plan must be a file inside the working directory/],
      ['plan', { spec: 'base.json', out: '../p.json' }, /out must be a file inside the working directory/],
    ];
    for (const [name, args, message] of cases) {
      const r = await tool(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.content[0].text).toMatch(message);
    }
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('reports CLI errors as tool errors, redacted, with the exit code', async () => {
    const r = await tool('drift', { rules: 'missing.json' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ exitCode: 1, result: { error: { message: expect.stringMatching(/Can't read rules file missing\.json/) } } });
    expect(JSON.stringify(r)).not.toContain(env.ASC_PRIVATE_KEY.split('\n')[1]);
  });
});

describe('MCP stdio transport', () => {
  it('reads newline-delimited JSON-RPC and writes one response per request, protocol only', async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const done = serveMcp({ cwd: tmp.dir, env, input, output: (line) => out.push(line) });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write('not json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diff', arguments: { plan: 'nope.json' } } })}\n`);
    input.end();
    await done;
    const messages = out.map((l) => JSON.parse(l));
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26' } });
    expect(messages[1]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(messages[2]).toMatchObject({ id: 2, result: { isError: true } });
  });
});

describe('the write boundary', () => {
  it('only the apply command calls the executor; the MCP server never names it (apply argv is refused at run time too)', () => {
    const cliDir = join(__dirname, '..');
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : sources(join(dir, e.name))) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    const callers = sources(cliDir).filter((f) => /applyChangeSet\(|\.applyOffer\(|\.applyMany\(|adapter\.apply\(/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => f.slice(cliDir.length + 1))).toEqual(['commands/apply.ts']);
    const mcp = readFileSync(join(cliDir, 'mcp.ts'), 'utf8');
    expect(mcp).not.toMatch(/commands\/apply'|applyCommand\b|applyChangeSet/);
  });
});
