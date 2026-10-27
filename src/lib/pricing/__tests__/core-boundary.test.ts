// The pricing core must stay framework-free so a CLI, a GitHub Action or any
// other front end can use it without Next.js. This walks the full import graph
// of every file under src/lib/pricing (tests excluded) and fails if it reaches
// Next, React, the web app, or anything that does network I/O.
//
// The CLI (src/cli, launched by bin/pricingkit.mjs) gets the same walk with a
// wider allowance: it may reach the adapters and store clients (it does
// network I/O), but never Next, React, the web app or its cookie sessions.
import { describe, it, expect } from 'vitest';
import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../..');
const CORE = resolve(__dirname, '..');
const CLI = join(SRC, 'cli');
const BIN = resolve(SRC, '../bin/pricingkit.mjs');

// Third-party packages the core may use. Everything else is refused.
const ALLOWED_PACKAGES = new Set(['zod']);

// Source directories and modules the core must never reach, directly or not.
const FORBIDDEN_PATHS = [
  'app/',
  'components/',
  'hooks/',
  'store/',
  'middleware/',
  'lib/adapters/',
  'lib/apple-connect/client.ts',
  'lib/google-play/client.ts',
  'lib/exchange-rates/',
  'lib/world-bank/',
  'lib/encryption.ts',
];

function listCoreFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...listCoreFiles(full));
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  return found;
}

function resolveLocal(from: string, spec: string): string | undefined {
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

// The CLI may reach the store clients and adapters, but not the web app or cookie sessions.
// yaml: YAML spec and rules files (src/cli/spec-file.ts); no dependencies of its own.
const CLI_ALLOWED_PACKAGES = new Set(['zod', 'yaml']);
const CLI_FORBIDDEN_PATHS = ['app/', 'components/', 'hooks/', 'store/', 'middleware/', 'lib/session.ts'];

interface Boundary {
  allowedPackages: Set<string>;
  forbiddenPaths: string[];
  /** Node built-ins (node:fs, ...) */
  allowBuiltins: boolean;
  allowFetch: boolean;
}

const CORE_BOUNDARY: Boundary = { allowedPackages: ALLOWED_PACKAGES, forbiddenPaths: FORBIDDEN_PATHS, allowBuiltins: false, allowFetch: false };
const CLI_BOUNDARY: Boundary = { allowedPackages: CLI_ALLOWED_PACKAGES, forbiddenPaths: CLI_FORBIDDEN_PATHS, allowBuiltins: true, allowFetch: true };

function isBuiltin(spec: string): boolean {
  return spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0]);
}

function walk(entry: string, violations: string[], seen: Set<string>, boundary: Boundary = CORE_BOUNDARY): void {
  if (seen.has(entry)) return;
  seen.add(entry);
  if (!/\.tsx?$/.test(entry)) return; // JSON data
  const source = readFileSync(entry, 'utf8');
  const rel = relative(SRC, entry);
  if (!boundary.allowFetch && /\bfetch\s*\(/.test(source.replace(/\/\/.*$/gm, ''))) {
    violations.push(`${rel} calls fetch()`);
  }
  for (const spec of specifiers(source)) {
    if (spec.startsWith('.') || spec.startsWith('@/')) {
      const target = resolveLocal(entry, spec);
      if (!target) {
        violations.push(`${rel}: cannot resolve ${spec}`);
        continue;
      }
      const targetRel = relative(SRC, target);
      const forbidden = boundary.forbiddenPaths.find((p) => targetRel === p || targetRel.startsWith(p));
      if (forbidden) {
        violations.push(`${rel} imports ${targetRel}`);
        continue;
      }
      walk(target, violations, seen, boundary);
    } else if (boundary.allowBuiltins && isBuiltin(spec)) {
      continue;
    } else {
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!boundary.allowedPackages.has(pkg)) violations.push(`${rel} imports package "${spec}"`);
    }
  }
}

describe('pricing core boundary', () => {
  const files = listCoreFiles(CORE);

  it('finds the core sources', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it('never reaches Next.js, React, the web app or network code', () => {
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const file of files) walk(file, violations, seen);
    expect(violations).toEqual([]);
  });

  it('detects a forbidden import (self-check)', () => {
    expect(specifiers(`import { NextResponse } from 'next/server';`)).toEqual(['next/server']);
    expect(specifiers(`export * from './strategies';`)).toEqual(['./strategies']);
    expect(specifiers(`import type { X } from "@/lib/google-play/client";`)).toEqual(['@/lib/google-play/client']);
  });
});

describe('CLI boundary', () => {
  const files = listCoreFiles(CLI);

  it('finds the CLI sources, entry included', () => {
    expect(files).toContain(join(CLI, 'main.ts'));
  });

  it('never reaches Next.js, React, the web app or cookie sessions', () => {
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const file of files) walk(file, violations, seen, CLI_BOUNDARY);
    expect(violations).toEqual([]);
    // The walk really follows the CLI into the core and the adapters
    expect([...seen].map((f) => relative(SRC, f))).toEqual(expect.arrayContaining(['lib/pricing/index.ts', 'lib/adapters/apple.ts', 'lib/adapters/play.ts']));
  });

  it('launches through tsx and node built-ins only', () => {
    const source = readFileSync(BIN, 'utf8');
    const packages = specifiers(source).filter((s) => !isBuiltin(s));
    expect(packages.every((s) => s === 'tsx' || s.startsWith('tsx/'))).toBe(true);
    expect(source).toContain('../src/cli/main.ts');
  });

  it('flags a web-app import from the CLI (self-check)', () => {
    const violations: string[] = [];
    walk(join(SRC, 'app/api/export/route.ts'), violations, new Set(), CLI_BOUNDARY);
    expect(violations.some((v) => v.includes('next'))).toBe(true);
  });
});
