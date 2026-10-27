// Argument parsing with node:util parseArgs (no dependency). Each command
// declares its own options; unknown options are an error.

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { UsageError } from './errors';

export const COMMANDS = ['export', 'plan', 'diff', 'offers', 'offer', 'drift', 'apply', 'undo'] as const;
export type CommandName = (typeof COMMANDS)[number];

type OptionSpec = NonNullable<ParseArgsConfig['options']>;

const COMMON: OptionSpec = {
  json: { type: 'boolean' },
  budget: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const APP: OptionSpec = {
  'bundle-id': { type: 'string' },
  'package-name': { type: 'string' },
};

const OPTIONS: Record<CommandName, OptionSpec> = {
  export: { ...COMMON, ...APP, subscription: { type: 'string' }, 'base-plan': { type: 'string' }, out: { type: 'string', short: 'o' } },
  plan: {
    ...COMMON,
    ...APP,
    spec: { type: 'string' },
    rules: { type: 'string' },
    'scheduled-base': { type: 'string' },
    out: { type: 'string', short: 'o' },
    'state-out': { type: 'string' },
    force: { type: 'boolean' },
  },
  diff: { ...COMMON, plan: { type: 'string' } },
  offers: { ...COMMON, ...APP, subscription: { type: 'string' }, 'base-plan': { type: 'string' }, kind: { type: 'string' } },
  offer: {
    ...COMMON,
    ...APP,
    subscription: { type: 'string' },
    'base-plan': { type: 'string' },
    kind: { type: 'string' },
    offer: { type: 'string' },
    'end-date': { type: 'string' },
    out: { type: 'string', short: 'o' },
    force: { type: 'boolean' },
  },
  drift: {
    ...COMMON,
    ...APP,
    rules: { type: 'string' },
    subscription: { type: 'string' },
    'base-plan': { type: 'string' },
    kind: { type: 'string' },
    offer: { type: 'string' },
    percent: { type: 'string' },
    'relative-discount': { type: 'string' },
    basis: { type: 'string' },
    snap: { type: 'string' },
    threshold: { type: 'string' },
    territories: { type: 'string' },
  },
  apply: {
    ...COMMON,
    plan: { type: 'string' },
    confirm: { type: 'string' },
    resume: { type: 'string' },
    'run-out': { type: 'string' },
    force: { type: 'boolean' },
    'force-delete': { type: 'boolean' },
    'allow-base-prices': { type: 'boolean' },
  },
  undo: { ...COMMON, out: { type: 'string', short: 'o' }, force: { type: 'boolean' } },
};

const ALLOWS_POSITIONAL: Partial<Record<CommandName, true>> = { diff: true, offer: true, apply: true, undo: true };

export type Flags = Record<string, string | boolean | undefined>;

export type ParsedArgs =
  | { kind: 'help'; command?: CommandName }
  | { kind: 'version' }
  | { kind: 'command'; command: CommandName; flags: Flags; positionals: string[]; json: boolean; budget: number };

export const MAX_BUDGET = 100_000;
/**
 * Default request cap for one CLI run. Lower than App Store Connect's hourly
 * 3600 so a run leaves room for the web app or another job on the same key.
 */
export const DEFAULT_CLI_BUDGET = 1000;

export function parseBudget(value: string | undefined): number {
  if (value === undefined) return DEFAULT_CLI_BUDGET;
  if (!/^\d+$/.test(value)) throw new UsageError(`--budget must be a whole number of requests, got ${JSON.stringify(value)}`);
  const n = Number(value);
  if (n < 1 || n > MAX_BUDGET) throw new UsageError(`--budget must be between 1 and ${MAX_BUDGET}`);
  return n;
}

function isCommand(value: string | undefined): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value ?? '');
}

/** Parse argv (without node and the script). Throws UsageError. */
export function parseCliArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h') return { kind: 'help' };
  if (first === '--version' || first === '-v') return { kind: 'version' };
  if (first === 'help') {
    if (rest[0] !== undefined && !isCommand(rest[0])) throw new UsageError(`Unknown command "${rest[0]}". Commands: ${COMMANDS.join(', ')}`);
    return { kind: 'help', command: rest[0] as CommandName | undefined };
  }
  if (!isCommand(first)) {
    throw new UsageError(
      first.startsWith('-') ? `Give a command first. Commands: ${COMMANDS.join(', ')}` : `Unknown command "${first}". Commands: ${COMMANDS.join(', ')}`
    );
  }

  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS[first], strict: true, allowPositionals: Boolean(ALLOWS_POSITIONAL[first]) });
  } catch (error) {
    throw new UsageError(`${(error as Error).message.replace(/\s*To specify a positional argument[\s\S]*$/, '')} (see pricingkit help ${first})`);
  }
  const flags = parsed.values as Flags;
  if (flags.help) return { kind: 'help', command: first };
  return {
    kind: 'command',
    command: first,
    flags,
    positionals: parsed.positionals,
    json: flags.json === true,
    budget: parseBudget(flags.budget as string | undefined),
  };
}

/** A string flag, or a UsageError naming it when it's required and missing */
export function stringFlag(flags: Flags, name: string, required: true): string;
export function stringFlag(flags: Flags, name: string, required?: false): string | undefined;
export function stringFlag(flags: Flags, name: string, required = false): string | undefined {
  const v = flags[name];
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'string') throw new UsageError(`--${name} can't be empty`);
  if (required) throw new UsageError(`--${name} is required`);
  return undefined;
}

export type AppSelection = { platform: 'apple'; bundleId: string } | { platform: 'google'; packageName: string };

/** Exactly one of --bundle-id (App Store) or --package-name (Google Play) */
export function appSelection(flags: Flags, required = true): AppSelection | undefined {
  const bundleId = stringFlag(flags, 'bundle-id');
  const packageName = stringFlag(flags, 'package-name');
  if (bundleId && packageName) throw new UsageError('Give either --bundle-id (App Store) or --package-name (Google Play), not both');
  if (bundleId) return { platform: 'apple', bundleId };
  if (packageName) return { platform: 'google', packageName };
  if (required) throw new UsageError('Choose the app: --bundle-id <id> (App Store) or --package-name <name> (Google Play)');
  return undefined;
}

// ---------------------------------------------------------------------------
// Help

const SHARED_HELP = `Shared options:
  --json            Machine-readable JSON on stdout
  --budget <n>      Most store requests this run may send (default ${DEFAULT_CLI_BUDGET})
  -h, --help        Help for the command`;

export const MAIN_HELP = `pricingkit: read store prices, plan price and offer changes, check offers for drift,
and apply reviewed plans. Only "apply" writes to a store, and only with --confirm.

Usage: pricingkit <command> [options]

Commands:
  export   Current prices of a subscription (App Store) or base plan (Google Play), as a state snapshot
  plan     Turn a pricing spec into a plan (ChangeSet); with --rules, keep offers in step with
           base prices. A dry run: never writes to a store
  diff     Human-readable summary of a plan file
  offers   List a subscription's offers: App Store offers with their prices per territory, or
           Google Play offers with their phases, eligibility, tags and regions
  offer    Plan deactivating, activating or deleting one existing offer (writes a plan file
           for "apply"); App Store and Google Play
  drift    Check offers against their rules (one offer, or every offer in a rules file with
           --rules); App Store and Google Play
  apply    Apply a reviewed plan, App Store or Google Play (needs --confirm <plan hash>; base
           prices also need --allow-base-prices); saves the run log
  undo     Turn a plan and its run log into an undo plan (offline), to review and apply

${SHARED_HELP}

Exit codes:
  0  OK (and, for plan, diff and drift: nothing to change)
  1  Error: bad arguments, missing credentials, a store error or a spent budget
  2  Drift found, or the plan has ops

Credentials come only from environment variables:
  App Store Connect: ASC_KEY_ID, ASC_ISSUER_ID, and one of ASC_PRIVATE_KEY (the .p8 contents),
                     ASC_PRIVATE_KEY_HEX (the same, hex-encoded) or ASC_PRIVATE_KEY_PATH
  Google Play:       GOOGLE_APPLICATION_CREDENTIALS (key file path) or GOOGLE_SERVICE_ACCOUNT_JSON (key JSON)
Optional pins: PRICINGKIT_EXPECT_BUNDLE_ID / PRICINGKIT_EXPECT_PACKAGE refuse any other app
(from a flag, spec, rules file or plan) before anything is read.

Run "pricingkit help <command>" for a command's options.`;

export const COMMAND_HELP: Record<CommandName, string> = {
  export: `Usage:
  pricingkit export --bundle-id <id> --subscription <subscription id> [--out <file>]
  pricingkit export --package-name <name> --subscription <product id> --base-plan <id> [--out <file>]

Reads the current (and scheduled) price in every territory and prints it as a
pricingkit.state snapshot (with --json) or a table. --out also writes the JSON
snapshot to a file. On the App Store, --subscription is the numeric App Store
Connect subscription ID.

${SHARED_HELP}`,
  plan: `Usage:
  pricingkit plan --spec <spec.json> [--out <plan.json>] [--state-out <state.json>] [--force]
  pricingkit plan --rules <rules.json> [--spec <base spec.json>] [--scheduled-base hold|now]
                  [--out <plan.json>] [--force]

The spec is a pricingkit.spec (base prices) or a pricingkit.offerPlanSpec
(offers: App Store offers to create or re-price, several products in one
spec, each offer with its own key; or, for a Google Play app, play.offer
offers to create, change or activate on base plans, previewed per region with
base price, offer price and discount, plus each offer's state, eligibility
and tags before and after, and its phases). For an offer plan the output also
lists refused offers and the plan hash to pass to "pricingkit apply
--confirm"; exit code 1 when an offer was refused (e.g. a Play spec that
leaves out a tag the offer has, without play.allowTagRemoval) or a Play region
was left out because Play's price is further from the percent-of-current
target than the deviation threshold (play.deviationThreshold, default 0.05).

Reads the products in the spec, turns its targets into per-territory prices,
snaps them to valid store prices and writes the ChangeSet (default
pricingkit-plan.json, never overwritten unless you pass --force or name it
with --out). A dry run: it only reads from the store (Google Play's
price conversion is a read-only call). Prints the ChangeSet with --json,
otherwise a summary. --state-out writes the prices the plan was made against.
The app comes from the spec; --bundle-id or --package-name, if given, must match.

Exit code 2 when the plan has ops, 0 when everything is already at target.

With --rules (a pricingkit.offerRules file: existing offers and the rule each
follows), plans keeping every offer marked syncWithBase in step:
  --rules alone           re-derives the offers against current base prices
                          (on demand, e.g. after a base price change)
  --rules with --spec     plans the base-price spec AND re-derives the offers
                          against the prices that plan sets, in one plan: base
                          ops first, then offer ops that wait for them
On the App Store only promotional offers can be re-priced. Offer codes,
win-back and introductory offers whose prices no longer match are listed
under "Needs manual action" with what to do; PricingKit never deletes or
re-creates an offer. On Google Play, offers priced at a percent of the base
price or at fixed prices get their phase prices re-written; offers with a
relative discount follow the base price by themselves ("follows base
automatically"). Base prices scheduled for a later date (spec startDate) are held by
default: offer prices change as soon as they are applied, so those
territories keep their offer price and are listed for a sync on or after the
date (the offer's other territories are still re-priced). --scheduled-base now re-prices
them now, against the scheduled prices, with a warning.
"pricingkit apply" applies a plan with base prices only with
--allow-base-prices: base prices first, then the offers derived from them.
Exit code 2 when the plan has ops or manual actions.

${SHARED_HELP}`,
  diff: `Usage:
  pricingkit diff <plan.json>
  pricingkit diff --plan <plan.json>

Summarises a plan file: ops per product and territory with before, after and
change, skipped territories by reason, and warnings. A plan with base prices
and offers shows them in two groups, base prices first (the order apply
uses), and lists offers that need manual action. Sends no store requests.
Exit code 2 when the plan has ops or manual actions.

${SHARED_HELP}`,
  offers: `Usage:
  pricingkit offers --bundle-id <id> --subscription <subscription id> [--kind <kind>]
  pricingkit offers --package-name <name> --subscription <product id> [--base-plan <id>]

App Store: lists the subscription's introductory, promotional, offer code and
win-back offers with each territory's price. --kind filters: apple.intro,
apple.promo, apple.offerCode, apple.winBack.
Google Play: lists the offers of one base plan (or, without --base-plan, of
every base plan of the subscription) with their state, eligibility, tags and
each phase's price per region. Anything Play returns that PricingKit can't
read exactly is listed as a problem.

${SHARED_HELP}`,
  offer: `Usage:
  pricingkit offer deactivate|activate|delete --bundle-id <id> --subscription <subscription id>
                   --kind <kind> --offer <offer key> [--end-date YYYY-MM-DD]
                   [--out <plan.json>] [--force]
  pricingkit offer deactivate|activate|delete --package-name <name> --subscription <product id>
                   --base-plan <id> --offer <offer id> [--out <plan.json>] [--force]

Plans one lifecycle change of an existing offer and writes it as a plan file
(default pricingkit-plan.json, never replaced without --force or --out). A dry
run: it only reads. Apply it like any plan, after review:
  pricingkit apply <plan.json> --confirm <plan hash> [--force-delete]

App Store (--kind apple.offerCode, apple.intro, apple.winBack or apple.promo):
  deactivate  offer codes: switch off; introductory and win-back offers: set
              the end date (--end-date, required)
  activate    offer codes: switch on; introductory and win-back offers: clear
              the end date
  delete      introductory, promotional and win-back offers (offer codes can't
              be deleted through the API). Applying needs --force-delete:
              App Store Connect doesn't report redemptions.
  Promotional offers have no active switch: stop presenting them, or delete.
  --offer is the offer's key as "pricingkit offers" lists it (promotional:
  offer code; offer code: name; win-back: offer ID; introductory: its key).
Google Play (--offer is the offer ID):
  deactivate  an active offer; subscribers who took it keep it
  activate    a draft or inactive offer
  delete      draft offers only; irreversible, so applying needs --force-delete

Anything the store doesn't allow (e.g. deleting an active Play offer) is
refused with the reason and no plan is written (OFFER_LIFECYCLE_REFUSED).
Exit code 2 when a plan was written.

${SHARED_HELP}`,
  drift: `Usage:
  pricingkit drift --rules <rules.json>
  pricingkit drift --bundle-id <id> --subscription <subscription id>
                   --kind <kind> --offer <offer id or key> --percent <n>
                   [--basis perPeriod|totalOverDuration] [--snap nearest|floor|ceil]
                   [--threshold <0..1>] [--territories all|GB,US,...]
  pricingkit drift --package-name <name> --subscription <product id> --base-plan <id>
                   --offer <offer id> (--percent <n> | --relative-discount <0..1>)
                   [--basis perPeriod|totalOverDuration] [--threshold <0..1>]
                   [--territories all|GB,US,...]

Checks every territory's offer price against "percent of that territory's
current price, snapped to its price points" and prints a pricingkit.offerDrift
report. Without --basis, a pay-up-front offer is checked over its whole
duration and any other offer per billing period.
On Google Play, --percent checks a phase priced at that percent of each
region's base price (made a valid price by Play's own conversion; about one
request per region), and --relative-discount checks that every region has
Play's native discount of that fraction ("0.5" = 50% off), which follows the
base price by itself. A pricingkit.playOfferDrift report is printed.
With --territories, only those territories are checked; the offer's other
territories are listed as outOfScope and don't affect the result.

Exit code 2 when the offer is not in sync (any mismatch, missing, extra,
unresolved or unreadable territory), 0 when every territory matches.

With --rules, checks every offer in a pricingkit.offerRules file (the app
comes from the file) and prints one pricingkit.rulesDrift report with each
offer's pricingkit.offerDrift report. Exit code 2 when any offer drifted or
doesn't exist, otherwise 1 when an offer couldn't be checked (e.g. a rule on a
free trial), otherwise 0. The text report starts with DRIFT, NOT CHECKED or
In sync and lists offers that couldn't be checked right below, with drift too.
A rules file for a Google Play app (packageName) checks its Play offers.

${SHARED_HELP}`,
  apply: `Usage:
  pricingkit apply <plan.json> --confirm <plan hash> [--run-out <run.json>] [--force]
  pricingkit apply <plan.json> --confirm <plan hash> --resume <run.json>
                   [--force-delete] [--allow-base-prices]

Applies a plan made by "pricingkit plan" (or "undo", or "offer"),
App Store or Google Play: the app comes from the plan.
A plan that changes base prices (a base-price spec, or --spec with --rules)
also needs --allow-base-prices: base prices go first and an offer derived
from them is sent only once they are in place (BASE_NOT_APPLIED otherwise).
App Store base prices rely on two behaviours not yet confirmed on a test app
(an immediate price replacing the territory's older entries; a second
scheduled price created before the old one is deleted): try a base-price
plan on a test app before relying on it.
--confirm must be the plan's hash, as printed by "plan" and "diff": any
other value refuses the whole run before anything is read or sent. Each op
is checked against the store first: one already done is skipped, one whose
offer changed since the plan was made fails with nothing sent. The run log (pricingkit.applyRun) is saved after every step to
--run-out (default <plan>.run.json, next to the plan file), written atomically. An existing log is
never replaced unless you pass --force (or resume it in place); resume a
failed or interrupted run with --resume. Deleting an offer needs --force-delete: App Store
Connect doesn't report redemptions, and a deleted Play offer (drafts only) is gone for good.

Exit code 0 when every op is done, 1 otherwise (the log says which).

${SHARED_HELP}`,
  undo: `Usage:
  pricingkit undo <plan.json> <run.json> [--out <undo.json>] [--force]

Builds the plan that undoes what the run changed (newest first, from each
op's "before"), writes it (default <plan>.undo.json next to the plan, never replaced unless
--force), and prints its summary, its hash and anything that can't be
reversed (e.g. offer codes already redeemed). Sends no store requests and
needs no credentials. Works for runs from the CLI and from the web app (save
the plan and the run log from its offer dialog). Apply the undo plan like any
other: pricingkit apply <undo.json> --confirm <hash>, with --force-delete when
it deletes offers.

Exit code 2 when there is something to undo, 0 otherwise.

${SHARED_HELP}`,
};
