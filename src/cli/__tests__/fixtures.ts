// Shared helpers for CLI tests: run the CLI in-process with captured output,
// fake store servers (built on the adapter test fakes), and throwaway keys.
// No test reaches a real store: the store clients are mocked (vi.mock) or
// fetch is stubbed, and every key here is generated for the run.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../main';
import { FakeOfferServer, OFFER_SUB_ID, page, pointResource, priceEntry, promoOffer, territoryResource } from '@/lib/adapters/__tests__/fake-apple-offers';
import type { RequestBudget } from '@/lib/utils/request-budget';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(argv: string[], options: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    now: () => new Date('2030-01-01T00:00:00Z'),
  });
  return { code, stdout, stderr };
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pricingkit-cli-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A throwaway P-256 key in PKCS#8 PEM, like an App Store Connect .p8 */
export async function throwawayP8(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/** A throwaway RSA key in PKCS#8 PEM, like a service account's */
export async function throwawayRsaPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

export const APPLE_ENV_FAKE = {
  ASC_KEY_ID: 'FAKEKEY123',
  ASC_ISSUER_ID: '11111111-2222-3333-4444-555555555555',
  // Not a key: the store client is mocked in tests that use this, so it is never parsed
  ASC_PRIVATE_KEY: 'bm90LWEta2V5LWp1c3QtdGVzdC1ieXRlcw==',
};

// ---------------------------------------------------------------------------
// App Store offers: one annual subscription with a 50% promo offer

export const OFFER_SUB = `/subscriptions/${OFFER_SUB_ID}`;
const PROMO_PRICE = 'subscriptionPromotionalOfferPrices';

/**
 * Base prices US 59.99 / GB 27.99, ladders where 50% snaps to 29.99 / 13.99.
 * The promo matches the rule unless `gbPoint` says otherwise.
 */
export function offerServer(options: { gbPoint?: string } = {}): FakeOfferServer {
  const s = new FakeOfferServer();
  s.on(OFFER_SUB, { data: { type: 'subscriptions', id: OFFER_SUB_ID, attributes: { productId: 'com.example.app.pro.annual', subscriptionPeriod: 'ONE_YEAR' } } });
  const current = [
    ['USA', 'pp-usa-5999', '59.99'],
    ['GBR', 'pp-gbr-2799', '27.99'],
  ];
  s.on(
    `${OFFER_SUB}/prices`,
    page(
      current.map(([t, pp]) => ({
        type: 'subscriptionPrices',
        id: `price-${t}`,
        attributes: { startDate: null },
        relationships: { territory: { data: { type: 'territories', id: t } }, subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: pp } } },
      })),
      [...current.map(([t, pp, price]) => pointResource(pp, price, '0', t)), ...current.map(([t]) => territoryResource(t))]
    )
  );
  const ladders: Record<string, string[]> = { USA: ['29.99', '30.99'], GBR: ['12.99', '13.99', '14.99'] };
  s.on(`${OFFER_SUB}/pricePoints`, (_e: string, query: Record<string, string> | undefined) => {
    const wanted = (query?.['filter[territory]'] ?? '').split(',');
    const data = wanted.flatMap((t) => (ladders[t] ?? []).map((p) => pointResource(`pp-${t.toLowerCase()}-${p.replace('.', '')}`, p, '0', t)));
    return page(data, wanted.filter((t) => ladders[t]).map(territoryResource));
  });
  s.on(`${OFFER_SUB}/introductoryOffers`, page([]));
  s.on(`${OFFER_SUB}/offerCodes`, page([]));
  s.on(`${OFFER_SUB}/winBackOffers`, page([]));
  s.on(`${OFFER_SUB}/promotionalOffers`, page([promoOffer('promo-1', 'example_half', 'Half price year')]));
  const gb = options.gbPoint ?? 'pp-gbr-1399';
  s.on(
    '/subscriptionPromotionalOffers/promo-1/prices',
    page(
      [priceEntry(PROMO_PRICE, 'p1-usa', 'USA', 'pp-usa-2999'), priceEntry(PROMO_PRICE, 'p1-gbr', 'GBR', gb)],
      [
        pointResource('pp-usa-2999', '29.99', '25.49', 'USA'),
        pointResource(gb, gb === 'pp-gbr-1399' ? '13.99' : '12.99', '9.79', 'GBR'),
        territoryResource('USA'),
        territoryResource('GBR'),
      ]
    )
  );
  return s;
}

// ---------------------------------------------------------------------------
// Google Play: one subscription "pro" with base plan "annual"

type Money = { currencyCode: string; units: string; nanos?: number };
const REGIONS: Record<string, { currency: string; perUsd: number }> = {
  US: { currency: 'USD', perUsd: 1 },
  GB: { currency: 'GBP', perUsd: 0.8 },
};

function money(currency: string, amount: number): Money {
  const cents = Math.round(amount * 100);
  const units = Math.floor(cents / 100);
  const nanos = (cents % 100) * 10_000_000;
  return { currencyCode: currency, units: String(units), ...(nanos ? { nanos } : {}) };
}

export class FakePlay {
  calls: Array<{ method: string; path: string }> = [];
  subscription = {
    productId: 'pro',
    regionsVersion: { version: '2025/03' },
    basePlans: [
      {
        basePlanId: 'annual',
        regionalConfigs: [
          { regionCode: 'US', price: { currencyCode: 'USD', units: '29', nanos: 990000000 }, newSubscriberAvailability: true },
          { regionCode: 'GB', price: { currencyCode: 'GBP', units: '24', nanos: 990000000 }, newSubscriberAvailability: true },
        ],
      },
    ],
  };

  /** Requests that could change the store. convertRegionPrices is a read-only calculation. */
  writes(): string[] {
    return this.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/pricing:convertRegionPrices')).map((c) => `${c.method} ${c.path}`);
  }

  handle = async (_credentials: unknown, path: string, options: { method?: string; body?: unknown; budget?: RequestBudget } = {}) => {
    const method = options.method ?? 'GET';
    options.budget?.consume('google');
    this.calls.push({ method, path });
    if (path.endsWith('/pricing:convertRegionPrices')) {
      // No tax, fixed FX: converting a region's own price gives it back
      const input = (options.body as { price: Money }).price;
      const amount = Number(input.units) + (input.nanos ?? 0) / 1e9;
      const usd = amount / Object.values(REGIONS).find((r) => r.currency === input.currencyCode)!.perUsd;
      const converted: Record<string, unknown> = {};
      for (const [region, r] of Object.entries(REGIONS)) {
        converted[region] = { regionCode: region, price: money(r.currency, usd * r.perUsd), taxAmount: money(r.currency, 0) };
      }
      return { convertedRegionPrices: converted };
    }
    if (path.endsWith('/subscriptions/pro') && method === 'GET') return structuredClone(this.subscription);
    throw new Error(`FakePlay: unexpected ${method} ${path}`);
  };
}
