// pricingkit export --in-app: App Store in-app purchases and Google Play
// one-time products as pricingkit.state snapshots. Both store clients are
// mocked and fetch is stubbed to fail: nothing leaves the process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return {
    ...actual,
    appleApiRequest: (...args: unknown[]) => appleApiRequest(...args),
    // client.ts calls its own appleApiRequest internally; route the app lookup through the mock too
    getAppIdForBundleId: async (credentials: { bundleId: string }) => (credentials.bundleId === 'com.example.app' ? 'app-1' : null),
  };
});
const googlePlayFetch = vi.fn();
vi.mock('@/lib/google-play/client', () => ({ googlePlayFetch: (...args: unknown[]) => googlePlayFetch(...args) }));

import { parseStateSnapshot } from '@/lib/pricing';
import { fakeAppleEnv, run, tempDir, throwawayRsaPem } from './fixtures';

const point = (id: string, customerPrice: string) => ({ type: 'inAppPurchasePricePoints', id, attributes: { customerPrice, proceeds: (Number(customerPrice) * 0.7).toFixed(2) } });
const territory = (id: string, currency: string) => ({ type: 'territories', id, attributes: { currency } });
const price = (id: string, alpha3: string, pp: string | null, startDate: string | null = null, endDate: string | null = null) => ({
  type: 'inAppPurchasePrices',
  id,
  attributes: { startDate, endDate },
  relationships: { territory: { data: { type: 'territories', id: alpha3 } }, inAppPurchasePricePoint: { data: pp ? { type: 'inAppPurchasePricePoints', id: pp } : null } },
});

function appleStore(calls: string[]) {
  return async (_credentials: unknown, endpoint: string, options: { method?: string; queryParams?: Record<string, string>; budget?: { consume: (p: string) => void } } = {}) => {
    options.budget?.consume('apple');
    const method = options.method ?? 'GET';
    calls.push(`${method} ${endpoint}`);
    if (method !== 'GET') throw new Error(`unexpected write ${method} ${endpoint}`);
    if (endpoint === '/apps/app-1/inAppPurchasesV2') {
      const found = options.queryParams?.['filter[productId]'] === 'com.example.app.coins';
      return { data: found ? [{ type: 'inAppPurchases', id: 'iap-1', attributes: { productId: 'com.example.app.coins', name: 'Coins', inAppPurchaseType: 'CONSUMABLE', state: 'APPROVED' } }] : [] };
    }
    if (endpoint === '/inAppPurchasePriceSchedules/iap-1/manualPrices') {
      return {
        data: [price('m-usa-old', 'USA', 'pp-usa-049', null, '2029-06-01'), price('m-usa', 'USA', 'pp-usa-099', '2029-06-01'), price('m-usa-next', 'USA', 'pp-usa-199', '2030-03-01')],
        included: [point('pp-usa-049', '0.49'), point('pp-usa-099', '0.99'), point('pp-usa-199', '1.99'), territory('USA', 'USD')],
        links: { self: 'x' },
      };
    }
    if (endpoint === '/inAppPurchasePriceSchedules/iap-1/automaticPrices') {
      return {
        data: [price('a-gbr', 'GBR', 'pp-gbr-099'), price('a-deu', 'DEU', null)],
        included: [point('pp-gbr-099', '0.99'), territory('GBR', 'GBP'), territory('DEU', 'EUR')],
        links: { self: 'x' },
      };
    }
    if (endpoint === '/inAppPurchasePriceSchedules/iap-1/baseTerritory') return { data: { type: 'territories', id: 'USA', attributes: { currency: 'USD' } } };
    throw new Error(`unexpected ${method} ${endpoint}`);
  };
}

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  appleApiRequest.mockReset();
  googlePlayFetch.mockReset();
  vi.stubGlobal('fetch', async () => {
    throw new Error('no network in tests');
  });
  tmp = tempDir();
});
afterEach(() => {
  vi.unstubAllGlobals();
  tmp.cleanup();
});

describe('pricingkit export --in-app (App Store)', () => {
  it('exports current and scheduled prices, manual and automatic, with the base territory', async () => {
    const calls: string[] = [];
    appleApiRequest.mockImplementation(appleStore(calls));
    const env = await fakeAppleEnv();
    const r = await run(['export', '--bundle-id', 'com.example.app', '--in-app', 'com.example.app.coins', '--out', 'coins.json', '--json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(0);
    const snapshot = parseStateSnapshot(readFileSync(join(tmp.dir, 'coins.json'), 'utf8'));
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(readFileSync(join(tmp.dir, 'coins.json'), 'utf8')));
    const [state] = snapshot.products;
    expect(state.product).toEqual({ platform: 'apple', type: 'inapp', id: 'iap-1', productId: 'com.example.app.coins' });
    expect(state.baseTerritory).toBe('US');
    // The entry that ended 2029-06-01 is history; the one from that date is current; 2030-03-01 is scheduled
    expect(state.territories.US).toMatchObject({
      currency: 'USD',
      current: { currency: 'USD', amount: '0.99', pricePointId: 'pp-usa-099' },
      scheduled: { amount: '1.99', startDate: '2030-03-01' },
    });
    expect(state.territories.GB.current).toMatchObject({ currency: 'GBP', amount: '0.99' });
    // Nothing guessed: a price without its price point is a problem
    expect(state.territories.DE).toMatchObject({ current: null, problems: { current: expect.stringMatching(/has no price point/) } });
    expect(state.warnings).toEqual([expect.stringMatching(/^DE current:/)]);
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true);

    const text = await run(['export', '--bundle-id', 'com.example.app', '--in-app', 'com.example.app.coins'], { env, cwd: tmp.dir });
    expect(text.stdout).toMatch(/^3 territories \(base territory US\)/);
  });

  it("says not found for a product outside this app, and refuses mixed flags", async () => {
    appleApiRequest.mockImplementation(appleStore([]));
    const env = await fakeAppleEnv();
    const missing = await run(['export', '--bundle-id', 'com.example.app', '--in-app', 'com.example.other.coins', '--json'], { env, cwd: tmp.dir });
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).error).toMatchObject({ status: 404, message: expect.stringMatching(/not found in com\.example\.app/) });
    const mixed = await run(['export', '--bundle-id', 'com.example.app', '--in-app', 'x', '--subscription', '1'], { env, cwd: tmp.dir });
    expect(mixed.stderr).toMatch(/either --in-app <product id> or --subscription/);
  });
});

describe('pricingkit export --in-app (Google Play)', () => {
  it('exports the first purchase option of a one-time product', async () => {
    const calls: string[] = [];
    googlePlayFetch.mockImplementation(async (_c: unknown, path: string, options: { method?: string; budget?: { consume: (p: string) => void } } = {}) => {
      options.budget?.consume('google');
      calls.push(`${options.method ?? 'GET'} ${path}`);
      if (path.endsWith('/oneTimeProducts/coins') && (options.method ?? 'GET') === 'GET') {
        return {
          productId: 'coins',
          purchaseOptions: [
            {
              purchaseOptionId: 'buy',
              regionalPricingAndAvailabilityConfigs: [
                { regionCode: 'US', price: { currencyCode: 'USD', units: '0', nanos: 990000000 }, availability: 'AVAILABLE' },
                { regionCode: 'JP', price: { currencyCode: 'JPY', units: '160' }, availability: 'AVAILABLE' },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: 'robot@example-project.iam.gserviceaccount.com', private_key_id: 'abcdef0123456789', private_key: await throwawayRsaPem() }),
    };
    const r = await run(['export', '--package-name', 'com.example.app', '--in-app', 'coins', '--json'], { env, cwd: tmp.dir });
    expect(r.code).toBe(0);
    const snapshot = parseStateSnapshot(r.stdout);
    expect(snapshot.products[0].product).toEqual({ platform: 'google', type: 'inapp', productId: 'coins' });
    expect(snapshot.products[0].territories).toMatchObject({ US: { current: { currency: 'USD', amount: '0.99' } }, JP: { current: { currency: 'JPY', amount: '160' } } });
    expect(calls).toEqual(['GET /androidpublisher/v3/applications/com.example.app/oneTimeProducts/coins']);
  });
});
