// Workspaces: one file covering several apps (App Store bundles and Google
// Play packages), their base-price specs, offer rules and offer plan specs,
// plus cross-store parity mappings.
//
// Format (pricingkit.workspace v1, JSON or YAML through the CLI):
// {
//   "kind": "pricingkit.workspace", "schemaVersion": 1,
//   "apps": [
//     { "id": "ios", "app": { "bundleId": "com.example.app" },
//       "spec": "pricing/ios.yaml",        // a pricingkit.spec file, or "products": [...] inline
//       "rules": "pricing/ios-rules.yaml", // a pricingkit.offerRules file (optional)
//       "offers": "pricing/ios-offers.yaml" },  // a pricingkit.offerPlanSpec file (optional)
//     { "id": "android", "app": { "packageName": "com.example.app" }, "products": [ ... ] }
//   ],
//   "parity": [
//     { "id": "annual",
//       "apple": { "bundleId": "com.example.app", "subscription": "1234567890" },
//       "play": { "packageName": "com.example.app", "subscription": "pro", "basePlan": "annual" },
//       "target": { "type": "strategy", "strategy": "ppp", "base": { "territory": "US", "amount": "49.99" } },
//       "baseTerritory": "US", "threshold": "0.05" }
//   ]
// }
//
// Paths are relative to the workspace file. Everything stays app-scoped:
// planning a workspace writes one plan file per app (and one more per app
// for its offer plan spec), each with the app in it, its own hash and the
// existing per-app safety checks; a workspace plan index
// (pricingkit.workspacePlan) lists them in apply order under one combined
// hash. A plan never holds ops for two apps.
// Framework-free: no file access (src/cli/workspace.ts reads the files).

import { z } from 'zod';
import { compareDecimal, isDecimalString, normalizeDecimal } from './decimal';
import type { AppRef, ProductRef } from './model';
import { productKey } from './model';
import { appRefSchema, canonicalJson, confirmHashSchema, contentHash } from './refs';
import { parsePricingSpec, PRICING_SPEC_KIND, PRICING_SPEC_SCHEMA_VERSION, PricingSpecError, type PricingSpec } from './spec';
import { parityAppleProduct, parityPlayProduct, type ParityMapping, type ParityReport } from './parity';

export const WORKSPACE_KIND = 'pricingkit.workspace' as const;
export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_PLAN_KIND = 'pricingkit.workspacePlan' as const;
/** 2: the index hash is SHA-256 (32 hex digits); version 1 indexes (FNV-1a 64) are still read, with a warning */
export const WORKSPACE_PLAN_SCHEMA_VERSION = 2 as const;

/** A path inside the workspace: relative, no ".." or "." segments, nothing under .git */
export const WORKSPACE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
export const WORKSPACE_APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface WorkspaceApp {
  /** Short local name, used for plan file names: lower-case letters, digits, hyphens */
  id: string;
  app: AppRef;
  description?: string;
  /** A pricingkit.spec file for this app */
  spec?: string;
  /** Or: the spec's products inline (same schema as a pricingkit.spec's products) */
  products?: unknown[];
  /** A pricingkit.offerRules file for this app (sync) */
  rules?: string;
  /** A pricingkit.offerPlanSpec file for this app (offers to create or re-price) */
  offers?: string;
}

export interface WorkspaceParityMapping extends ParityMapping {
  /** One target for both stores (pricingkit.spec targets); each store snaps it separately */
  target?: unknown;
  /** The base territory of both products (per product, as in a spec) */
  baseTerritory?: string;
  /** App Store snapping of the target (default nearest) */
  snap?: 'nearest' | 'floor' | 'ceil';
}

export interface PricingWorkspace {
  kind: typeof WORKSPACE_KIND;
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  description?: string;
  apps: WorkspaceApp[];
  parity?: WorkspaceParityMapping[];
}

export class WorkspaceError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid workspace:\n- ${issues.join('\n- ')}`);
    this.name = 'WorkspaceError';
  }
}

const pathSchema = z
  .string()
  .regex(WORKSPACE_PATH_PATTERN, 'must be a relative path of letters, digits, ".", "_", "-" and "/"')
  .refine((p) => !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '.' || s === '' || s === '.git'), { message: 'must stay inside the workspace (no "..", "." or empty segments, nothing under .git)' })
  .refine((p) => /\.(json|ya?ml)$/i.test(p), { message: 'must be a .json, .yaml or .yml file' });
const territorySchema = z.string().regex(/^[A-Z]{2}$/, 'territory must be ISO 3166-1 alpha-2, e.g. "GB"');
const playIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,150}$/, 'must be a Google Play ID (letters, digits, ".", "_", "-")');

const appSchema = z
  .object({
    id: z.string().regex(WORKSPACE_APP_ID_PATTERN, 'id: lower-case letters, digits and hyphens, at most 40, starting with a letter or digit'),
    app: appRefSchema,
    description: z.string().optional(),
    spec: pathSchema.optional(),
    products: z.array(z.unknown()).min(1).optional(),
    rules: pathSchema.optional(),
    offers: pathSchema.optional(),
  })
  .strict();

const paritySchema = z
  .object({
    id: z.string().regex(WORKSPACE_APP_ID_PATTERN, 'id: lower-case letters, digits and hyphens, at most 40'),
    apple: z.object({ bundleId: z.string().min(1), subscription: z.string().regex(/^\d{1,20}$/, 'the numeric App Store Connect subscription ID') }).strict(),
    play: z.object({ packageName: z.string().min(1), subscription: playIdSchema, basePlan: playIdSchema }).strict(),
    threshold: z
      .string()
      .refine((v) => isDecimalString(v) && compareDecimal(v, '0') >= 0 && compareDecimal(v, '1') <= 0, { message: 'threshold is a fraction from 0 to 1, e.g. "0.05"' })
      .transform((v) => normalizeDecimal(v))
      .optional(),
    territories: z.array(territorySchema).min(1).optional(),
    target: z.unknown().optional(),
    baseTerritory: territorySchema.optional(),
    snap: z.enum(['nearest', 'floor', 'ceil']).optional(),
  })
  .strict();

const workspaceSchema = z
  .object({
    kind: z.literal(WORKSPACE_KIND),
    schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
    description: z.string().optional(),
    apps: z.array(appSchema).min(1).max(50),
    parity: z.array(paritySchema).max(200).optional(),
  })
  .strict();

export function appLabel(app: AppRef): string {
  return 'bundleId' in app ? `${app.bundleId} (App Store)` : `${app.packageName} (Google Play)`;
}

export function sameAppRef(a: AppRef, b: AppRef): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Parse and check a workspace from JSON text or a parsed object. Throws WorkspaceError listing every problem. */
export function parseWorkspace(input: string | unknown): PricingWorkspace {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new WorkspaceError(['not valid JSON']);
    }
  }
  const versioned = raw as { schemaVersion?: unknown } | null;
  if (versioned && typeof versioned === 'object' && typeof versioned.schemaVersion === 'number' && versioned.schemaVersion > WORKSPACE_SCHEMA_VERSION) {
    throw new WorkspaceError([`schemaVersion ${versioned.schemaVersion} was written by a newer PricingKit; this one reads ${WORKSPACE_SCHEMA_VERSION}`]);
  }
  const result = workspaceSchema.safeParse(raw);
  if (!result.success) throw new WorkspaceError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  const ws = result.data as PricingWorkspace;
  const problems: string[] = [];
  const ids = new Set<string>();
  ws.apps.forEach((entry, index) => {
    const where = `apps.${index} (${entry.id})`;
    if (ids.has(entry.id)) problems.push(`${where}: the id is used twice`);
    ids.add(entry.id);
    const twin = ws.apps.findIndex((other) => sameAppRef(other.app, entry.app));
    if (twin !== index) problems.push(`${where}: ${appLabel(entry.app)} is already apps.${twin}; list each app once`);
    if (entry.spec && entry.products) problems.push(`${where}: give spec or products, not both`);
  });
  const parityIds = new Set<string>();
  const appleSubs = new Map<string, string>();
  const playPlans = new Map<string, string>();
  (ws.parity ?? []).forEach((m, index) => {
    const where = `parity.${index} (${m.id})`;
    if (parityIds.has(m.id)) problems.push(`${where}: the id is used twice`);
    parityIds.add(m.id);
    if (!ws.apps.some((a) => 'bundleId' in a.app && a.app.bundleId === m.apple.bundleId)) problems.push(`${where}: apple.bundleId is not one of the workspace's apps`);
    if (!ws.apps.some((a) => 'packageName' in a.app && a.app.packageName === m.play.packageName)) problems.push(`${where}: play.packageName is not one of the workspace's apps`);
    const appleKey = `${m.apple.bundleId}/${m.apple.subscription}`;
    const playKey = `${m.play.packageName}/${m.play.subscription}/${m.play.basePlan}`;
    if (appleSubs.has(appleKey)) problems.push(`${where}: the App Store subscription is already mapped by ${appleSubs.get(appleKey)}`);
    if (playPlans.has(playKey)) problems.push(`${where}: the Google Play base plan is already mapped by ${playPlans.get(playKey)}`);
    appleSubs.set(appleKey, m.id);
    playPlans.set(playKey, m.id);
    if (m.target === undefined && (m.baseTerritory || m.snap)) problems.push(`${where}: baseTerritory and snap go with a target`);
  });
  if (problems.length > 0) throw new WorkspaceError(problems);
  return ws;
}

/** The parity mappings that touch an app, with the product on that app's side */
export function parityProductsFor(ws: PricingWorkspace, app: AppRef): Array<{ mapping: WorkspaceParityMapping; product: ProductRef }> {
  const out: Array<{ mapping: WorkspaceParityMapping; product: ProductRef }> = [];
  for (const mapping of ws.parity ?? []) {
    if ('bundleId' in app && mapping.apple.bundleId === app.bundleId) out.push({ mapping, product: parityAppleProduct(mapping) });
    if ('packageName' in app && mapping.play.packageName === app.packageName) out.push({ mapping, product: parityPlayProduct(mapping) });
  }
  return out;
}

/**
 * One app's base-price spec: its own products (from its spec file, already
 * parsed, or inline) plus a product per parity mapping with a target. A
 * product listed both ways is refused. Returns undefined when the app has no
 * base-price products. Throws WorkspaceError.
 */
export function workspaceAppSpec(ws: PricingWorkspace, entry: WorkspaceApp, loaded?: PricingSpec): PricingSpec | undefined {
  const where = `app ${entry.id}`;
  if (loaded && !sameAppRef(loaded.app, entry.app)) {
    throw new WorkspaceError([`${where}: its spec file is for ${appLabel(loaded.app)}, not ${appLabel(entry.app)}`]);
  }
  const own: unknown[] = loaded ? loaded.products : (entry.products ?? []);
  const fromParity = parityProductsFor(ws, entry.app)
    .filter(({ mapping }) => mapping.target !== undefined)
    .map(({ mapping, product }) => ({
      product,
      targets: mapping.target,
      ...(mapping.baseTerritory ? { baseTerritory: mapping.baseTerritory } : {}),
      ...(mapping.snap && product.platform === 'apple' ? { snap: mapping.snap } : {}),
    }));
  if (own.length === 0 && fromParity.length === 0) return undefined;
  const ownKeys = new Set(
    own.map((p) => {
      const ref = (p as { product?: ProductRef })?.product;
      return ref && typeof ref === 'object' ? productKey(ref) : '';
    })
  );
  const clashes = parityProductsFor(ws, entry.app).filter(({ mapping, product }) => mapping.target !== undefined && ownKeys.has(productKey(product)));
  if (clashes.length > 0) {
    throw new WorkspaceError(clashes.map(({ mapping, product }) => `${where}: ${productKey(product)} has its own spec entry and parity.${mapping.id}'s target; keep one`));
  }
  try {
    return parsePricingSpec({
      kind: PRICING_SPEC_KIND,
      schemaVersion: PRICING_SPEC_SCHEMA_VERSION,
      app: entry.app,
      ...(loaded?.description ?? entry.description ? { description: loaded?.description ?? entry.description } : {}),
      products: [...own, ...fromParity],
      ...(loaded?.freshness ? { freshness: loaded.freshness } : {}),
    });
  } catch (error) {
    if (error instanceof PricingSpecError) {
      // Name parity entries by their mapping rather than by their index in the generated spec
      const issues = error.issues.map((issue) =>
        issue.replace(/^products\.(\d+)/, (match, n) => {
          const i = Number(n);
          return i >= own.length ? `parity ${parityIdAt(ws, entry.app, i - own.length)}` : match;
        })
      );
      throw new WorkspaceError(issues.map((i) => `${where}: ${i}`));
    }
    throw error;
  }
}

function parityIdAt(ws: PricingWorkspace, app: AppRef, index: number): string {
  return parityProductsFor(ws, app).filter(({ mapping }) => mapping.target !== undefined)[index]?.mapping.id ?? String(index);
}

// ---------------------------------------------------------------------------
// The workspace plan index

export type WorkspacePlanPart = 'prices' | 'offers';

export interface WorkspacePlanEntry {
  /** The workspace app's id */
  appId: string;
  app: AppRef;
  part: WorkspacePlanPart;
  /** The plan file, next to the index (a file name, no directories) */
  file: string;
  /** changeSetHash of that plan */
  hash: string;
  ops: number;
  baseOps: number;
  offerOps: number;
  manualActions: number;
}

export interface WorkspacePlan {
  kind: typeof WORKSPACE_PLAN_KIND;
  schemaVersion: 1 | typeof WORKSPACE_PLAN_SCHEMA_VERSION;
  createdAt: string;
  description?: string;
  /** In apply order: app by app as the workspace lists them, prices before offers */
  plans: WorkspacePlanEntry[];
  /** Parity on the planned prices (planner notes: not covered by the hash) */
  parity?: ParityReport;
  /** workspacePlanHash(plans): confirms the whole set at once */
  hash: string;
}

export const WORKSPACE_PLAN_FILE_PATTERN = /^[a-z0-9][a-z0-9.-]{0,80}\.json$/;

/**
 * Hash over every plan's app, file and hash, in order: what `apply
 * --workspace-plan --confirm` must name. SHA-256 (32 hex digits) for
 * indexes of schema version 2; version 1 indexes keep their FNV-1a 64 hash.
 */
export function workspacePlanHash(plans: Array<Pick<WorkspacePlanEntry, 'appId' | 'app' | 'part' | 'file' | 'hash'>>, schemaVersion: number = WORKSPACE_PLAN_SCHEMA_VERSION): string {
  return contentHash(canonicalJson(plans.map((p) => ({ appId: p.appId, app: p.app, part: p.part, file: p.file, hash: p.hash }))), schemaVersion < 2 ? 'fnv1a64' : 'sha256');
}

/** A warning for a version 1 index (FNV-1a 64 hash, not collision-resistant); null for current ones */
export function legacyWorkspaceHashWarning(plan: Pick<WorkspacePlan, 'schemaVersion'>): string | null {
  return plan.schemaVersion < 2
    ? 'This workspace plan index (schema version 1) uses the old FNV-1a hash, which is not collision-resistant. It is still accepted for now; plan the workspace again for a SHA-256 hash.'
    : null;
}

const planEntrySchema = z
  .object({
    appId: z.string().regex(WORKSPACE_APP_ID_PATTERN),
    app: appRefSchema,
    part: z.enum(['prices', 'offers']),
    file: z.string().regex(WORKSPACE_PLAN_FILE_PATTERN, 'a plan file name next to the index'),
    hash: confirmHashSchema,
    ops: z.number().int().min(0),
    baseOps: z.number().int().min(0),
    offerOps: z.number().int().min(0),
    manualActions: z.number().int().min(0),
  })
  .strict();

const workspacePlanSchema = z
  .object({
    kind: z.literal(WORKSPACE_PLAN_KIND),
    schemaVersion: z.union([z.literal(1), z.literal(WORKSPACE_PLAN_SCHEMA_VERSION)]),
    createdAt: z.string().min(1),
    description: z.string().optional(),
    plans: z.array(planEntrySchema),
    parity: z.unknown().optional(),
    hash: confirmHashSchema,
  })
  .strict();

export function buildWorkspacePlan(input: { createdAt: string; description?: string; plans: WorkspacePlanEntry[]; parity?: ParityReport }): WorkspacePlan {
  return {
    kind: WORKSPACE_PLAN_KIND,
    schemaVersion: WORKSPACE_PLAN_SCHEMA_VERSION,
    createdAt: input.createdAt,
    ...(input.description ? { description: input.description } : {}),
    plans: input.plans,
    ...(input.parity ? { parity: input.parity } : {}),
    hash: workspacePlanHash(input.plans),
  };
}

export function serializeWorkspacePlan(plan: WorkspacePlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** Parse a workspace plan index. Its hash must match its entries, and no plan file or (app, part) may appear twice. */
export function parseWorkspacePlan(input: string | unknown): WorkspacePlan {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new WorkspaceError(['not valid JSON']);
    }
  }
  const versioned = raw as { schemaVersion?: unknown } | null;
  if (versioned && typeof versioned === 'object' && typeof versioned.schemaVersion === 'number' && versioned.schemaVersion > WORKSPACE_PLAN_SCHEMA_VERSION) {
    throw new WorkspaceError([`schemaVersion ${versioned.schemaVersion} was written by a newer PricingKit`]);
  }
  const result = workspacePlanSchema.safeParse(raw);
  if (!result.success) throw new WorkspaceError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  const plan = result.data as WorkspacePlan;
  const problems: string[] = [];
  const files = new Set<string>();
  const parts = new Set<string>();
  for (const entry of plan.plans) {
    if (files.has(entry.file)) problems.push(`plan file ${entry.file} is listed twice`);
    files.add(entry.file);
    const part = `${canonicalJson(entry.app)} ${entry.part}`;
    if (parts.has(part)) problems.push(`${appLabel(entry.app)} has two ${entry.part} plans`);
    parts.add(part);
  }
  if (plan.hash !== workspacePlanHash(plan.plans, plan.schemaVersion)) problems.push("the hash doesn't match the plans listed (the index was edited after planning)");
  if (problems.length > 0) throw new WorkspaceError(problems);
  return plan;
}
