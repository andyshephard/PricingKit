// The pricing core must stay framework-free so a CLI, a GitHub Action or any
// other front end can use it without Next.js. This walks the full import graph
// of every file under src/lib/pricing (tests excluded) and fails if it reaches
// Next, React, the web app, or anything that does network I/O.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../..');
const CORE = resolve(__dirname, '..');

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

function walk(entry: string, violations: string[], seen: Set<string>): void {
  if (seen.has(entry)) return;
  seen.add(entry);
  if (!/\.tsx?$/.test(entry)) return; // JSON data
  const source = readFileSync(entry, 'utf8');
  const rel = relative(SRC, entry);
  if (/\bfetch\s*\(/.test(source.replace(/\/\/.*$/gm, ''))) {
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
      const forbidden = FORBIDDEN_PATHS.find((p) => targetRel === p || targetRel.startsWith(p));
      if (forbidden) {
        violations.push(`${rel} imports ${targetRel}`);
        continue;
      }
      walk(target, violations, seen);
    } else {
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!ALLOWED_PACKAGES.has(pkg)) violations.push(`${rel} imports package "${spec}"`);
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
