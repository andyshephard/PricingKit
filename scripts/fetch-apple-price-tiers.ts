#!/usr/bin/env npx tsx
/**
 * Regenerate the static Apple price tier data
 * (src/lib/apple-connect/price-tier-data.json and the generated date in
 * price-tier-data.ts and price-tier-meta.ts) from the live App Store Connect API.
 *
 * READ-ONLY: it lists territories and one in-app purchase's price points.
 * It needs real App Store Connect credentials, so it is never run in CI or
 * tests; run it by hand and review the diff before committing.
 *
 * Usage:
 *   ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_PRIVATE_KEY_PATH=./AuthKey.p8 \
 *     npx tsx scripts/fetch-apple-price-tiers.ts --iap <in-app purchase ID> [--dry-run]
 *     [--prefer EUR=DEU,USD=USA] [--out <file.json>] [--budget 2000]
 *
 * - Credentials: the CLI's variables (ASC_KEY_ID, ASC_ISSUER_ID and one of
 *   ASC_PRIVATE_KEY, ASC_PRIVATE_KEY_HEX, ASC_PRIVATE_KEY_PATH). Any role that
 *   can read in-app purchases works.
 * - --iap: the numeric App Store Connect ID of any in-app purchase of the
 *   team (price point ladders are the same for every in-app purchase).
 * - --prefer: which territory a currency's ladder is read from (default: the
 *   first territory App Store Connect lists for that currency).
 * - --dry-run: read and validate everything, print a summary, write nothing.
 * - Requests: 1 territory list + about 4 pages per currency (~120 currencies),
 *   within --budget (default 2000). The client retries 429 and 5xx.
 *
 * The run fails without writing anything if a price point ID doesn't decode
 * to a tier (the encoding is undocumented) or a currency has no prices.
 */

import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { appleListAll } from '../src/lib/apple-connect/pagination';
import { buildPriceTierData, serializeTierData, updateTierModuleDate, type TierBuildSource } from '../src/lib/apple-connect/price-tier-build';
import { RequestBudget } from '../src/lib/utils/request-budget';
import { appleCredentialsFromEnv } from '../src/cli/credentials';
import { Redactor } from '../src/cli/redact';
import { toApiError } from '../src/lib/utils/api-error';
import { appleKeyConnection } from '../src/lib/key-token-source';

const ROOT = resolve(__dirname, '..');
const DEFAULT_JSON = join(ROOT, 'src/lib/apple-connect/price-tier-data.json');
const MODULES = [join(ROOT, 'src/lib/apple-connect/price-tier-data.ts'), join(ROOT, 'src/lib/apple-connect/price-tier-meta.ts')];

function parseArgs(argv: string[]) {
  const out: { iap?: string; prefer: Record<string, string>; out?: string; dryRun: boolean; budget: number } = { prefer: {}, dryRun: false, budget: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--iap') out.iap = next();
    else if (arg === '--out') out.out = next();
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--budget') out.budget = Number(next());
    else if (arg === '--prefer') {
      for (const pair of next().split(',')) {
        const [currency, territory] = pair.split('=');
        if (!/^[A-Z]{3}$/.test(currency ?? '') || !/^[A-Z]{3}$/.test(territory ?? '')) throw new Error(`--prefer takes CUR=TER pairs (alpha-3 territory), e.g. EUR=DEU; got ${pair}`);
        out.prefer[currency] = territory;
      }
    } else throw new Error(`Unknown argument ${arg}`);
  }
  if (!out.iap || !/^\d+$/.test(out.iap)) throw new Error('--iap <numeric in-app purchase ID> is required');
  if (!Number.isInteger(out.budget) || out.budget < 1) throw new Error('--budget must be a positive whole number');
  return out;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const redactor = new Redactor();
  const connection = appleKeyConnection(await appleCredentialsFromEnv(process.env, '', redactor));
  const budget = new RequestBudget({ limit: args.budget });
  const source: TierBuildSource = {
    async listTerritories() {
      const { data } = await appleListAll<{ id: string; attributes?: { currency?: string } }>(connection, '/territories', { queryParams: { limit: '200' }, budget });
      return data.map((t) => ({ id: t.id, currency: t.attributes?.currency ?? '' }));
    },
    async listPricePoints(territory) {
      const { data } = await appleListAll<{ id: string; attributes?: { customerPrice?: string } }>(connection, `/inAppPurchases/${args.iap}/pricePoints`, {
        queryParams: { 'filter[territory]': territory, 'fields[inAppPurchasePricePoints]': 'customerPrice', limit: '200' },
        apiVersion: 'v2',
        budget,
      });
      return data.map((p) => ({ id: p.id, customerPrice: p.attributes?.customerPrice ?? '' }));
    },
  };
  const { data, territories } = await buildPriceTierData(source, { prefer: args.prefer, onProgress: (m) => process.stderr.write(`${m}\n`) });
  const currencies = Object.keys(data).length;
  const tiers = Object.values(data).reduce((n, rows) => n + rows.length, 0);
  process.stderr.write(`${currencies} currencies, ${tiers} prices, ${budget.used} requests\n`);
  process.stderr.write(`Ladders read from: ${Object.entries(territories).map(([c, t]) => `${c}=${t}`).join(', ')}\n`);
  if (args.dryRun) {
    process.stderr.write('Dry run: nothing written.\n');
    return 0;
  }
  const generatedAt = new Date();
  const jsonPath = args.out ? resolve(args.out) : DEFAULT_JSON;
  await writeAtomic(jsonPath, serializeTierData(data));
  if (!args.out) {
    for (const file of MODULES) await writeAtomic(file, updateTierModuleDate(await readFile(file, 'utf8'), generatedAt));
  }
  process.stderr.write(`Wrote ${jsonPath}${args.out ? '' : ` and the generated date in ${MODULES.join(', ')}`}. Review the diff before committing.\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    const message = error instanceof Error ? error.message : toApiError(error, 'apple').message;
    process.stderr.write(`fetch-apple-price-tiers: ${message}\n`);
    process.exit(1);
  }
);
