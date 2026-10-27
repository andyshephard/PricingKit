import { describe, it, expect } from 'vitest';
import { appSelection, COMMANDS, MAX_BUDGET, parseBudget, parseCliArgs, stringFlag } from '../args';
import { EXIT_CHANGES, EXIT_ERROR, EXIT_OK, UsageError } from '../errors';
import { run } from './fixtures';

describe('parseCliArgs', () => {
  it('parses a command with its flags, --json and the default budget', () => {
    const parsed = parseCliArgs(['export', '--bundle-id', 'com.example.app', '--subscription', '123', '--json']);
    expect(parsed).toEqual({
      kind: 'command',
      command: 'export',
      flags: { 'bundle-id': 'com.example.app', subscription: '123', json: true },
      positionals: [],
      json: true,
      budget: 1000,
    });
  });

  it('takes --budget and --flag=value forms', () => {
    const parsed = parseCliArgs(['drift', '--budget=250', '--percent=50']);
    expect(parsed).toMatchObject({ kind: 'command', budget: 250, json: false, flags: { percent: '50' } });
  });

  it('accepts a positional plan file only for diff', () => {
    expect(parseCliArgs(['diff', 'plan.json'])).toMatchObject({ command: 'diff', positionals: ['plan.json'] });
    expect(() => parseCliArgs(['export', 'extra'])).toThrow(UsageError);
  });

  it('refuses unknown commands and unknown or misplaced flags', () => {
    expect(() => parseCliArgs(['apply'])).toThrow(/Unknown command "apply"/);
    expect(() => parseCliArgs(['--json'])).toThrow(/Give a command first/);
    expect(() => parseCliArgs(['export', '--spec', 'x.json'])).toThrow(UsageError);
    expect(() => parseCliArgs(['plan', '--percent', '50'])).toThrow(/Unknown option '--percent'/);
    expect(() => parseCliArgs(['export', '--subscription'])).toThrow(UsageError);
  });

  it('has no write command', () => {
    expect(COMMANDS).toEqual(['export', 'plan', 'diff', 'offers', 'drift']);
  });

  it('recognises help and version in every form', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['help', 'drift'])).toEqual({ kind: 'help', command: 'drift' });
    expect(parseCliArgs(['plan', '--help'])).toEqual({ kind: 'help', command: 'plan' });
    expect(parseCliArgs(['--version'])).toEqual({ kind: 'version' });
    expect(() => parseCliArgs(['help', 'nope'])).toThrow(UsageError);
  });
});

describe('parseBudget', () => {
  it('defaults to 1000 and takes whole numbers in range', () => {
    expect(parseBudget(undefined)).toBe(1000);
    expect(parseBudget('1')).toBe(1);
    expect(parseBudget(String(MAX_BUDGET))).toBe(MAX_BUDGET);
  });

  it.each(['0', '-5', '1.5', 'lots', '', String(MAX_BUDGET + 1)])('refuses %j', (value) => {
    expect(() => parseBudget(value)).toThrow(UsageError);
  });
});

describe('flag helpers', () => {
  it('stringFlag trims, requires and refuses empty values', () => {
    expect(stringFlag({ a: ' x ' }, 'a')).toBe('x');
    expect(stringFlag({}, 'a')).toBeUndefined();
    expect(() => stringFlag({}, 'a', true)).toThrow('--a is required');
    expect(() => stringFlag({ a: '  ' }, 'a')).toThrow("--a can't be empty");
  });

  it('appSelection takes exactly one of --bundle-id and --package-name', () => {
    expect(appSelection({ 'bundle-id': 'b' })).toEqual({ platform: 'apple', bundleId: 'b' });
    expect(appSelection({ 'package-name': 'p' })).toEqual({ platform: 'google', packageName: 'p' });
    expect(() => appSelection({ 'bundle-id': 'b', 'package-name': 'p' })).toThrow(/not both/);
    expect(() => appSelection({})).toThrow(/Choose the app/);
    expect(appSelection({}, false)).toBeUndefined();
  });
});

describe('exit codes and output streams', () => {
  it('uses 0, 1 and 2', () => {
    expect([EXIT_OK, EXIT_ERROR, EXIT_CHANGES]).toEqual([0, 1, 2]);
  });

  it('prints help on stdout and exits 0', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: pricingkit <command>');
    expect(r.stdout).toContain('2  Drift found, or the plan has ops');
    expect(r.stderr).toBe('');
    for (const command of COMMANDS) {
      const help = await run(['help', command]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`pricingkit ${command}`);
    }
  });

  it('prints the version', async () => {
    const r = await run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it('exits 1 on a usage error, with the message on stderr', async () => {
    const r = await run(['export', '--nope']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^error: Unknown option '--nope'/);
    expect(r.stderr).toContain('pricingkit --help');
  });

  it('with --json, also puts the error on stdout as JSON', async () => {
    const r = await run(['export', '--json', '--bundle-id', 'com.example.app']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: { message: '--subscription is required', code: 'USAGE' } });
  });
});
