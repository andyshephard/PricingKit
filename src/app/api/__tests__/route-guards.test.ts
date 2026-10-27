// Every route handler that changes something (POST, PUT, PATCH, DELETE) must
// start with the cross-site check, and no route may read a request body
// itself (only readJsonBody, which caps it). Checked with the TypeScript
// compiler and its type checker, not regular expressions: it finds handlers
// however they are exported, and body reads on a Request whatever the
// variable is called (aliases included).
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

const API = join(__dirname, '..');
const ROOT = join(__dirname, '../../../..');
const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_READS = new Set(['json', 'text', 'formData', 'arrayBuffer', 'blob', 'bytes']);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

function compilerOptions(): ts.CompilerOptions {
  const configPath = join(ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  return { ...parsed.options, noEmit: true, skipLibCheck: true, incremental: false, tsBuildInfoFile: undefined };
}

/** Problems in one route file; `virtual` adds in-memory files (the self-checks) */
function analyse(files: string[], virtual: Record<string, string> = {}): Record<string, string[]> {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => (virtual[name] !== undefined ? ts.createSourceFile(name, virtual[name], lang, true) : getSourceFile(name, lang, ...rest));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => virtual[name] !== undefined || fileExists(name);
  const program = ts.createProgram([...files, ...Object.keys(virtual)], options, host);
  const checker = program.getTypeChecker();
  const out: Record<string, string[]> = {};

  for (const file of [...files, ...Object.keys(virtual)]) {
    const source = program.getSourceFile(file)!;
    const problems: string[] = [];
    const moduleSymbol = checker.getSymbolAtLocation(source);
    for (const exported of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      if (!METHODS.has(exported.name)) continue;
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = symbol.declarations?.[0];
      if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body) {
        problems.push(`${exported.name} must be an exported function declaration (export async function ${exported.name}(request) { ... })`);
        continue;
      }
      const param = declaration.parameters[0]?.name;
      const paramName = param && ts.isIdentifier(param) ? param.text : undefined;
      const [first, second] = declaration.body.statements;
      const checks =
        paramName !== undefined &&
        first?.getText(source).replace(/\s+/g, ' ') === `const crossSite = rejectCrossSite(${paramName});` &&
        second?.getText(source).replace(/\s+/g, ' ') === 'if (crossSite) return crossSite;';
      if (!checks) problems.push(`${exported.name} must start with: const crossSite = rejectCrossSite(<its request>); if (crossSite) return crossSite;`);
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && BODY_READS.has(node.expression.name.text)) {
        const receiver = checker.getTypeAtLocation(node.expression.expression);
        const names = [receiver.getSymbol()?.getName(), ...(receiver.isUnion() ? receiver.types.map((t) => t.getSymbol()?.getName()) : [])];
        if (names.some((n) => n === 'Request' || n === 'NextRequest')) {
          problems.push(`reads the request body itself (.${node.expression.name.text}()); use readJsonBody`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    out[relative(API, file)] = problems;
  }
  return out;
}

describe('route guards (TypeScript AST and types)', () => {
  it('every route that changes something checks the origin first and never reads a body itself', () => {
    const files = routeFiles(API);
    expect(files.length).toBeGreaterThan(15);
    const problems = Object.fromEntries(Object.entries(analyse(files)).filter(([, p]) => p.length > 0));
    expect(problems).toEqual({});
  }, 60_000);

  it('self-check: catches const and non-async handlers, a missing check, and body reads under any name', () => {
    const at = (name: string) => join(API, '__virtual__', name, 'route.ts');
    const head = "import { NextRequest, NextResponse } from 'next/server';\nimport { rejectCrossSite } from '@/lib/request-guard';\n";
    const virtual = {
      [at('const')]: `${head}export const POST = async (request: NextRequest) => NextResponse.json({});\n`,
      [at('plain')]: `${head}export function DELETE(request: Request) { return NextResponse.json({}); }\n`,
      [at('alias')]: `${head}async function handler(req: NextRequest) { const crossSite = rejectCrossSite(req); if (crossSite) return crossSite; const r = req; await r.text(); return NextResponse.json({}); }\nexport { handler as PATCH };\n`,
      [at('renamed')]: `${head}export async function PUT(req: NextRequest) { const crossSite = rejectCrossSite(req); if (crossSite) return crossSite; const body = await req.json(); return NextResponse.json(body); }\n`,
      [at('fine')]: `${head}export async function POST(req: Request) {\n  const crossSite = rejectCrossSite(req);\n  if (crossSite) return crossSite;\n  const upstream = await fetch('https://example.invalid');\n  return NextResponse.json(await upstream.json());\n}\n`,
    };
    const result = analyse([], virtual);
    const of = (name: string) => result[relative(API, at(name))];
    expect(of('const')).toEqual([expect.stringMatching(/must be an exported function declaration/)]);
    expect(of('plain')).toEqual([expect.stringMatching(/must start with/)]);
    expect(of('alias')).toEqual([expect.stringMatching(/\.text\(\)/)]);
    expect(of('renamed')).toEqual([expect.stringMatching(/\.json\(\)/)]);
    // A Response's body (an upstream fetch) is fine
    expect(of('fine')).toEqual([]);
  }, 60_000);
});
