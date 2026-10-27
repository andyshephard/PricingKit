// Spec and rules files may be JSON or YAML (.yaml / .yml). YAML is turned
// into the same JSON text the core parsers already read, so both formats go
// through one set of checks.
//
// YAML numbers would lose what the author wrote (4.10 -> 4.1, an App Store ID
// 0123... -> 123), and the core takes amounts as decimal strings. So every
// number keeps its source text, except under the few keys whose value is a
// real integer (schemaVersion, periods, ...). Tags (!!binary, custom tags),
// several documents in one file, duplicate keys and alias bombs are refused.
// Error messages give the line and column only, never the file's text.

import { extname } from 'node:path';
import { isPair, isScalar, parseDocument, visit } from 'yaml';
import { readInputFile, type CommandContext } from './context';
import { CliError } from './errors';

/** Keys whose value the core schemas take as a JSON number */
const INTEGER_KEYS = new Set([
  'schemaVersion',
  'periods',
  'phase',
  'recurrenceCount',
  'paidSubscriptionDurationInMonths',
  'minimum',
  'maximum',
  'waitBetweenOffersInMonths',
]);

export function isYamlPath(path: string): boolean {
  return ['.yaml', '.yml'].includes(extname(path).toLowerCase());
}

export class YamlSpecError extends CliError {
  constructor(what: string, detail: string) {
    super(`${what} is not valid YAML (${detail})`, 'INVALID_YAML');
    this.name = 'YamlSpecError';
  }
}

/** YAML text -> JSON text for the core parsers. Throws YamlSpecError. */
export function yamlToJson(text: string, what = 'the file'): string {
  const doc = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true, prettyErrors: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    const offset = problem.pos?.[0];
    throw new YamlSpecError(what, `${offset !== undefined ? `${position(text, offset)}: ` : ''}${problem.code}`);
  }
  let tagged: { tag: string; at?: string } | undefined;
  visit(doc, {
    Node(_key, node) {
      if (node.tag === undefined) return undefined;
      tagged = { tag: node.tag, ...(node.range ? { at: position(text, node.range[0]) } : {}) };
      return visit.BREAK;
    },
  });
  if (tagged) throw new YamlSpecError(what, `${tagged.at ? `${tagged.at}: ` : ''}tags such as ${tagged.tag} aren't allowed`);
  visit(doc, {
    Scalar(key, node, path) {
      if (typeof node.value !== 'number' && typeof node.value !== 'bigint') return;
      if (key === 'key') return; // map keys are strings in JSON anyway
      const parent = path[path.length - 1];
      if (isPair(parent) && isScalar(parent.key) && INTEGER_KEYS.has(String(parent.key.value))) return;
      node.value = node.source ?? String(node.value);
    },
  });
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 100 });
  } catch {
    throw new YamlSpecError(what, 'too many aliases');
  }
  return JSON.stringify(value ?? null);
}

/** "line L, column C" (1-based) of an offset in text */
function position(text: string, offset: number): string {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length))).split('\n');
  return `line ${before.length}, column ${before[before.length - 1].length + 1}`;
}

/**
 * Read a spec or rules file as JSON text: JSON files as they are, YAML files
 * (.yaml / .yml) converted. `what` names the file in errors.
 */
export async function readSpecText(ctx: CommandContext, path: string, what: string): Promise<string> {
  const text = await readInputFile(ctx, path, what);
  return isYamlPath(path) ? yamlToJson(text, `${what} ${path}`) : text;
}
