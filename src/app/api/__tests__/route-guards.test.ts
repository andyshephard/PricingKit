// Every route handler that changes something (POST, PUT, PATCH, DELETE) must
// start with the cross-site check (the rejectCrossSite exported by
// src/lib/request-guard.ts, not a local look-alike), and no route may read a
// request body itself (only readJsonBody, which caps it). Checked with the
// TypeScript compiler and its type checker, not regular expressions: it finds
// handlers however they are exported, and body reads on a Request whatever
// the variable is called (aliases included), whether a reader is called,
// referenced or destructured, or the raw .body stream is touched.
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

const API = join(__dirname, '..');
const ROOT = join(__dirname, '../../../..');
const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_READS = new Set(['json', 'text', 'formData', 'arrayBuffer', 'blob', 'bytes', 'body']);
const REQUEST_GUARD = join(ROOT, 'src/lib/request-guard.ts');

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
      else if (!isRequestGuardExport(checker, first as ts.VariableStatement)) {
        problems.push(`${exported.name} calls a rejectCrossSite that is not the one exported by @/lib/request-guard`);
      }
    }
    const isRequest = (expression: ts.Expression) => {
      const type = checker.getTypeAtLocation(expression);
      const names = [type.getSymbol()?.getName(), ...(type.isUnion() ? type.types.map((t) => t.getSymbol()?.getName()) : [])];
      return names.some((n) => n === 'Request' || n === 'NextRequest');
    };
    const visit = (node: ts.Node) => {
      // request.json(), request.body, const read = request.text, ...
      if (ts.isPropertyAccessExpression(node) && BODY_READS.has(node.name.text) && isRequest(node.expression)) {
        const what = node.name.text === 'body' ? '.body' : `.${node.name.text}()`;
        problems.push(`reads the request body itself (${what}); use readJsonBody`);
      }
      // const { body, json } = request
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name) && isRequest(node.initializer)) {
        for (const element of node.name.elements) {
          const name = (element.propertyName ?? element.name).getText(source);
          if (BODY_READS.has(name)) problems.push(`reads the request body itself (destructures ${name}); use readJsonBody`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    out[relative(API, file)] = problems;
  }
  return out;
}

/** The first statement's rejectCrossSite resolves (through imports and aliases) to the export of src/lib/request-guard.ts */
function isRequestGuardExport(checker: ts.TypeChecker, statement: ts.VariableStatement): boolean {
  const init = statement.declarationList.declarations[0]?.initializer;
  if (!init || !ts.isCallExpression(init)) return false;
  let symbol = checker.getSymbolAtLocation(init.expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  return symbol?.getName() === 'rejectCrossSite' && declaration?.getSourceFile().fileName === REQUEST_GUARD;
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
      [at('lookalike')]: `import { NextRequest, NextResponse } from 'next/server';\nfunction rejectCrossSite(_r: NextRequest): Response | null { return null; }\nexport async function POST(request: NextRequest) { const crossSite = rejectCrossSite(request); if (crossSite) return crossSite; return NextResponse.json({}); }\n`,
      [at('stream')]: `${head}export async function POST(request: NextRequest) { const crossSite = rejectCrossSite(request); if (crossSite) return crossSite; const reader = request.body?.getReader(); return NextResponse.json({ ok: !!reader }); }\n`,
      [at('destructured')]: `${head}export async function POST(request: Request) { const crossSite = rejectCrossSite(request); if (crossSite) return crossSite; const { json: read } = request; return NextResponse.json(await read.call(request)); }\n`,
    };
    const result = analyse([], virtual);
    const of = (name: string) => result[relative(API, at(name))];
    expect(of('const')).toEqual([expect.stringMatching(/must be an exported function declaration/)]);
    expect(of('plain')).toEqual([expect.stringMatching(/must start with/)]);
    expect(of('alias')).toEqual([expect.stringMatching(/\.text\(\)/)]);
    expect(of('renamed')).toEqual([expect.stringMatching(/\.json\(\)/)]);
    // A Response's body (an upstream fetch) is fine
    expect(of('fine')).toEqual([]);
    expect(of('lookalike')).toEqual([expect.stringMatching(/not the one exported by @\/lib\/request-guard/)]);
    expect(of('stream')).toEqual([expect.stringMatching(/\(\.body\)/)]);
    expect(of('destructured')).toEqual([expect.stringMatching(/destructures json/)]);
  }, 60_000);
});
