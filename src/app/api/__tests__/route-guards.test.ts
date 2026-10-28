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

// ---------------------------------------------------------------------------
// Store routes take short-lived tokens from headers, and the web app never
// handles a store key.
//
// - Every handler of a store route (all but PUBLIC_ROUTES) calls
//   requireAppleAuth or requireGoogleAuth from src/middleware/auth.ts, directly
//   or through a function in the same file. Every such call is bound to a
//   const whose .ok is checked with an early return (if (!auth.ok) return ...).
// - Nothing under src/app, src/components, src/hooks, src/store or
//   src/middleware references the key-backed token sources
//   (src/lib/key-token-source.ts) or the in-process signers (generateJWT,
//   getGoogleAccessToken), under any import path or alias, or imports
//   key-token-source at runtime even indirectly, or reads cookies (next/headers
//   or request.cookies).

const AUTH = join(ROOT, 'src/middleware/auth.ts');
const KEY_TOKEN_SOURCE = join(ROOT, 'src/lib/key-token-source.ts');
const SIGNERS: Array<[file: string, name: string]> = [
  [join(ROOT, 'src/lib/apple-connect/client.ts'), 'generateJWT'],
  [join(ROOT, 'src/lib/google-play/client.ts'), 'getGoogleAccessToken'],
];
const HEADER_AUTH = new Set(['requireAppleAuth', 'requireGoogleAuth']);
/** Routes that never touch a store */
const PUBLIC_ROUTES = new Set(['ppp/route.ts', 'exchange-rates/route.ts', 'settings/exchange-rates/route.ts']);
const HANDLERS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const WEB_DIRS = ['src/app', 'src/components', 'src/hooks', 'src/store', 'src/middleware', 'src/lib/web'].map((d) => join(ROOT, d));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function program(files: string[], virtual: Record<string, string>) {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => (virtual[name] !== undefined ? ts.createSourceFile(name, virtual[name], lang, true) : getSourceFile(name, lang, ...rest));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => virtual[name] !== undefined || fileExists(name);
  const p = ts.createProgram([...files, ...Object.keys(virtual)], options, host);
  return { program: p, checker: p.getTypeChecker() };
}

function resolved(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

function declaredIn(symbol: ts.Symbol | undefined, file: string): boolean {
  return Boolean(symbol?.declarations?.some((d) => d.getSourceFile().fileName === file));
}

/** Store route handlers that don't call a header auth helper */
function analyseHeaderAuth(files: string[], virtual: Record<string, string> = {}): Record<string, string[]> {
  const { program: p, checker } = program(files, virtual);
  const out: Record<string, string[]> = {};
  for (const file of [...files, ...Object.keys(virtual)]) {
    const source = p.getSourceFile(file)!;
    const rel = relative(API, file).split('\\').join('/');
    const problems: string[] = [];
    if (PUBLIC_ROUTES.has(rel)) {
      out[rel] = problems;
      continue;
    }
    const callsAuth = (node: ts.Node, via: Set<ts.Symbol>): boolean => {
      let found = false;
      const visit = (n: ts.Node) => {
        if (found) return;
        if (ts.isCallExpression(n)) {
          const symbol = resolved(checker, n.expression);
          if (symbol && ((HEADER_AUTH.has(symbol.getName()) && declaredIn(symbol, AUTH)) || via.has(symbol))) {
            found = true;
            return;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(node);
      return found;
    };
    // Functions in this file that call a helper (for handlers that delegate, like export's builders)
    const helpers = new Set<ts.Symbol>();
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && callsAuth(statement.body, new Set())) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (symbol) helpers.add(symbol);
      }
    }
    // Every header auth call: bound to a const, and `if (!<it>.ok) return ...` in the same function
    const checkBinding = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const symbol = resolved(checker, node.expression);
        if (symbol && HEADER_AUTH.has(symbol.getName()) && declaredIn(symbol, AUTH)) {
          const declaration = node.parent;
          const name = ts.isVariableDeclaration(declaration) && declaration.initializer === node && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
          const list = declaration.parent;
          const isConst = name !== undefined && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
          let fn: ts.Node | undefined = node.parent;
          while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
          let checked = false;
          const findCheck = (n: ts.Node) => {
            if (checked) return;
            if (
              ts.isIfStatement(n) &&
              n.expression.getText(source).replace(/\s+/g, '') === `!${name}.ok` &&
              (ts.isReturnStatement(n.thenStatement) || (ts.isBlock(n.thenStatement) && n.thenStatement.statements.some(ts.isReturnStatement)))
            ) {
              checked = true;
              return;
            }
            ts.forEachChild(n, findCheck);
          };
          if (isConst && fn) findCheck(fn);
          if (!isConst || !checked) problems.push(`the result of ${symbol.getName()} must be bound to a const and checked: if (!<it>.ok) return <it>.response`);
        }
      }
      ts.forEachChild(node, checkBinding);
    };
    checkBinding(source);

    const moduleSymbol = checker.getSymbolAtLocation(source);
    for (const exported of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      if (!HANDLERS.has(exported.name)) continue;
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = symbol.declarations?.[0];
      if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body) {
        problems.push(`${exported.name} must be an exported function declaration`);
        continue;
      }
      if (!callsAuth(declaration.body, helpers)) {
        problems.push(`${exported.name} must call requireAppleAuth or requireGoogleAuth from @/middleware/auth`);
      }
    }
    out[rel] = problems;
  }
  return out;
}

/** Key handling in web code: references to key sources or signers, runtime imports of key-token-source, cookie reads */
function analyseKeyHandling(files: string[], virtual: Record<string, string> = {}): Record<string, string[]> {
  const { program: p, checker } = program(files, virtual);
  const out: Record<string, string[]> = {};
  const runtimeImports = (source: ts.SourceFile): string[] => {
    const targets: string[] = [];
    const add = (specifier: ts.Expression) => {
      const symbol = checker.getSymbolAtLocation(specifier);
      const target = symbol?.declarations?.[0]?.getSourceFile().fileName;
      if (target) targets.push(target);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        const bindings = node.importClause?.namedBindings;
        const onlyTypes = !node.importClause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
        if (!onlyTypes) add(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
        add(node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
        add(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return targets;
  };
  /** Does this module reach key-token-source through runtime imports? */
  const reach = new Map<string, string[] | null>();
  const pathTo = (file: string, seen: Set<string>): string[] | null => {
    if (file === KEY_TOKEN_SOURCE) return [file];
    if (reach.has(file)) return reach.get(file)!;
    if (seen.has(file) || file.includes('/node_modules/')) return null;
    seen.add(file);
    const source = p.getSourceFile(file);
    let found: string[] | null = null;
    for (const target of source ? runtimeImports(source) : []) {
      const path = pathTo(target, seen);
      if (path) {
        found = [file, ...path];
        break;
      }
    }
    reach.set(file, found);
    return found;
  };

  for (const file of [...files, ...Object.keys(virtual)]) {
    const source = p.getSourceFile(file)!;
    const problems = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const symbol = resolved(checker, node);
        if (declaredIn(symbol, KEY_TOKEN_SOURCE)) problems.add(`references ${symbol!.getName()} from src/lib/key-token-source.ts`);
        for (const [signerFile, name] of SIGNERS) {
          if (symbol?.getName() === name && declaredIn(symbol, signerFile)) problems.add(`references the in-process signer ${name}`);
        }
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'cookies') {
        const type = checker.getTypeAtLocation(node.expression);
        const names = [type.getSymbol()?.getName(), ...(type.isUnion() ? type.types.map((t) => t.getSymbol()?.getName()) : [])];
        if (names.some((n) => n === 'Request' || n === 'NextRequest')) problems.add('reads request.cookies (the server keeps no cookies)');
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'next/headers') {
        problems.add('imports next/headers (no cookies or raw header reads outside src/middleware/auth.ts)');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const path = pathTo(file, new Set());
    if (path) problems.add(`imports src/lib/key-token-source.ts at runtime (${path.map((f) => relative(ROOT, f)).join(' -> ')})`);
    out[relative(ROOT, file)] = [...problems];
  }
  return out;
}

describe('the web app never handles store keys (TypeScript AST and types)', () => {
  it('every store route handler takes its token from the header auth helpers', () => {
    const files = routeFiles(API);
    const results = analyseHeaderAuth(files);
    expect(Object.keys(results).filter((f) => !PUBLIC_ROUTES.has(f)).length).toBeGreaterThan(15);
    expect(Object.fromEntries(Object.entries(results).filter(([, p]) => p.length > 0))).toEqual({});
  }, 60_000);

  it('nothing in the web app references key token sources or in-process signers, or reads cookies', () => {
    const files = WEB_DIRS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(100);
    const results = analyseKeyHandling(files);
    expect(Object.fromEntries(Object.entries(results).filter(([, p]) => p.length > 0))).toEqual({});
  }, 120_000);

  it('self-check: catches a route without header auth, key sources under any alias, signers, indirect imports and cookie reads', () => {
    const route = (name: string) => join(API, '__virtual__', name, 'route.ts');
    const head = "import { NextResponse } from 'next/server';\nimport { requireAppleAuth } from '@/middleware/auth';\n";
    const auth = analyseHeaderAuth([], {
      [route('none')]: `import { NextResponse } from 'next/server';\nexport async function GET(request: Request) { return NextResponse.json({ ok: !!request }); }\n`,
      [route('direct')]: `${head}export async function GET(request: Request) { const auth = requireAppleAuth(request); if (!auth.ok) return auth.response; return NextResponse.json({}); }\n`,
      [route('delegated')]: `${head}async function build(request: Request) { const auth = requireAppleAuth(request); if (!auth.ok) return false; return true; }\nexport async function GET(request: Request) { return NextResponse.json({ ok: await build(request) }); }\n`,
      [route('lookalike')]: `import { NextResponse } from 'next/server';\nfunction requireAppleAuth(_r: Request) { return { ok: true }; }\nexport async function GET(request: Request) { requireAppleAuth(request); return NextResponse.json({}); }\n`,
      [route('unchecked')]: `${head}export async function GET(request: Request) { const auth = requireAppleAuth(request); return NextResponse.json({ ok: auth.ok }); }\n`,
      [route('unbound')]: `${head}export async function GET(request: Request) { if (!requireAppleAuth(request).ok) return NextResponse.json({}); return NextResponse.json({}); }\n`,
      [route('let')]: `${head}export async function GET(request: Request) { let auth = requireAppleAuth(request); if (!auth.ok) return auth.response; auth = requireAppleAuth(request); return NextResponse.json({}); }\n`,
    });
    const authOf = (name: string) => auth[relative(API, route(name)).split('\\').join('/')];
    expect(authOf('none')).toEqual([expect.stringMatching(/must call requireAppleAuth or requireGoogleAuth/)]);
    expect(authOf('direct')).toEqual([]);
    expect(authOf('delegated')).toEqual([]);
    expect(authOf('lookalike')).toEqual([expect.stringMatching(/must call/)]);
    expect(authOf('unchecked')).toEqual([expect.stringMatching(/must be bound to a const and checked/)]);
    expect(authOf('unbound')).toEqual([expect.stringMatching(/must be bound to a const and checked/)]);
    expect(authOf('let')).toEqual(expect.arrayContaining([expect.stringMatching(/must be bound to a const and checked/)]));

    // In a directory that exists, so relative imports between them resolve
    const web = (name: string) => join(API, '__tests__', `virtual-${name}.ts`);
    const keys = analyseKeyHandling([], {
      [web('direct')]: "import { appleKeyConnection } from '@/lib/key-token-source';\nexport const c = appleKeyConnection;\n",
      [web('aliased')]: "import * as k from '../../../lib/key-token-source';\nexport const s = k.GoogleKeyTokenSource;\n",
      [web('signer')]: "import { generateJWT as sign } from '@/lib/apple-connect';\nexport const s = sign;\n",
      [web('google-signer')]: "import { getGoogleAccessToken } from '@/lib/google-play';\nexport const g = getGoogleAccessToken;\n",
      [web('indirect')]: "export { x } from './virtual-reexport';\n",
      [web('reexport')]: "import '@/lib/key-token-source';\nexport const x = 1;\n",
      [web('cookies')]: "import { cookies } from 'next/headers';\nexport const c = cookies;\n",
      [web('types-only')]: "import type { AppleKeyCredentials } from '@/lib/apple-connect/client';\nexport type T = AppleKeyCredentials | null;\n",
      [web('fine')]: "import { appleApiRequest } from '@/lib/apple-connect/client';\nexport const r = appleApiRequest;\n",
      [web('request-cookies')]: "import type { NextRequest } from 'next/server';\nexport const read = (request: NextRequest) => request.cookies.get('x');\n",
    });
    const keysOf = (name: string) => keys[relative(ROOT, web(name))];
    expect(keysOf('direct')).toEqual(expect.arrayContaining([expect.stringMatching(/references appleKeyConnection/), expect.stringMatching(/at runtime/)]));
    expect(keysOf('aliased')).toEqual(expect.arrayContaining([expect.stringMatching(/references GoogleKeyTokenSource/)]));
    expect(keysOf('signer')).toEqual([expect.stringMatching(/in-process signer generateJWT/)]);
    expect(keysOf('google-signer')).toEqual([expect.stringMatching(/in-process signer getGoogleAccessToken/)]);
    expect(keysOf('indirect')).toEqual([expect.stringMatching(/at runtime .*virtual-reexport/)]);
    expect(keysOf('cookies')).toEqual([expect.stringMatching(/next\/headers/)]);
    expect(keysOf('types-only')).toEqual([]);
    expect(keysOf('fine')).toEqual([]);
    expect(keysOf('request-cookies')).toEqual([expect.stringMatching(/request\.cookies/)]);
  }, 120_000);
});
