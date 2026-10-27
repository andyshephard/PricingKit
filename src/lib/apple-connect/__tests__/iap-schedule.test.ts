// POST /inAppPurchasePriceSchedules replaces the whole schedule, so a price
// change must send one schedule holding every manual price.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '../types';
import { appleKeyConnection } from '../../token-source';
import { ApiError } from '@/lib/utils/api-error';

const appleApiRequest = vi.fn();
vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});

import { replaceInAppPurchaseManualPrices } from '../products';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.app',
};
const connection = appleKeyConnection(credentials);

function manual(id: string, territory: string, pricePoint: string, startDate: string | null, endDate: string | null = null) {
  return {
    id,
    type: 'inAppPurchasePrices',
    attributes: { startDate, endDate },
    relationships: {
      territory: { data: { id: territory, type: 'territories' } },
      inAppPurchasePricePoint: { data: { id: pricePoint, type: 'inAppPurchasePricePoints' } },
    },
  };
}

type Body = {
  data: { relationships: { baseTerritory: { data: { id: string } }; manualPrices: { data: unknown[] } } };
  included: Array<{ attributes: { startDate: string | null }; relationships: { inAppPurchasePricePoint: { data: { id: string } } } }>;
};

beforeEach(() => {
  appleApiRequest.mockReset();
});

/** Serve these manual prices and record the one schedule POST */
function serve(entries: ReturnType<typeof manual>[], post: (body: Body) => unknown = () => ({})) {
  appleApiRequest.mockImplementation(async (_c: unknown, endpoint: string, options: { method?: string; body?: unknown } = {}) => {
    if (options.method === 'POST') return post(options.body as Body);
    if (endpoint.endsWith('/manualPrices')) return { data: entries, links: { self: 'x' } };
    throw new Error(`unexpected ${endpoint}`);
  });
}

function sentSchedule(): Array<[string, string | null]> {
  const posts = appleApiRequest.mock.calls.filter((c) => c[2]?.method === 'POST');
  expect(posts).toHaveLength(1);
  return (posts[0][2].body as Body).included.map((i) => [i.relationships.inAppPurchasePricePoint.data.id, i.attributes.startDate]);
}

// GBR has a current price AND a scheduled one
const withCurrentAndScheduled = () => [
  manual('m1', 'USA', 'pp-usa', null),
  manual('m2', 'GBR', 'pp-gbr-now', '2020-01-01'),
  manual('m3', 'GBR', 'pp-gbr-later', '2099-01-01'),
];

describe('replaceInAppPurchaseManualPrices: a territory with a current and a scheduled price', () => {
  it('an immediate change replaces the current price and keeps the scheduled one', async () => {
    serve(withCurrentAndScheduled());
    const result = await replaceInAppPurchaseManualPrices(connection, 'iap-1', { GB: { pricePointId: 'pp-gbr-new' } }, 'USA', {}, '2030-01-01');
    expect(sentSchedule()).toEqual([
      ['pp-usa', null],
      ['pp-gbr-new', null],
      ['pp-gbr-later', '2099-01-01'],
    ]);
    expect(result.keptScheduled).toEqual([{ territoryId: 'GBR', startDate: '2099-01-01' }]);
  });

  it('a future-dated change keeps the current price and adds the new one', async () => {
    serve(withCurrentAndScheduled());
    await replaceInAppPurchaseManualPrices(connection, 'iap-1', { GB: { pricePointId: 'pp-gbr-summer', startDate: '2098-06-01' } }, 'USA', {}, '2030-01-01');
    expect(sentSchedule()).toEqual([
      ['pp-usa', null],
      ['pp-gbr-now', null],
      ['pp-gbr-later', '2099-01-01'],
      ['pp-gbr-summer', '2098-06-01'],
    ]);
  });

  it('a future-dated change on the same date replaces that scheduled price only', async () => {
    serve(withCurrentAndScheduled());
    await replaceInAppPurchaseManualPrices(connection, 'iap-1', { GB: { pricePointId: 'pp-gbr-other', startDate: '2099-01-01' } }, 'USA', {}, '2030-01-01');
    expect(sentSchedule()).toEqual([
      ['pp-usa', null],
      ['pp-gbr-now', null],
      ['pp-gbr-other', '2099-01-01'],
    ]);
  });

  it('names the kept scheduled price when Apple refuses the schedule, instead of dropping it', async () => {
    serve(withCurrentAndScheduled(), () => {
      throw new ApiError('Invalid schedule', { status: 409, platform: 'apple' });
    });
    const promise = replaceInAppPurchaseManualPrices(connection, 'iap-1', { GB: { pricePointId: 'pp-gbr-new' } }, 'USA', {}, '2030-01-01');
    await expect(promise).rejects.toMatchObject({ status: 409 });
    await expect(promise).rejects.toThrow(/kept the existing scheduled prices.*GBR from 2099-01-01.*not removed/);
  });

  it('sends one current price per territory even if older active entries exist', async () => {
    serve([
      manual('m1', 'USA', 'pp-usa-2019', null),
      manual('m2', 'USA', 'pp-usa-2021', '2021-01-01'),
    ]);
    await replaceInAppPurchaseManualPrices(connection, 'iap-1', { GB: { pricePointId: 'pp-gbr' } }, 'USA', {}, '2030-01-01');
    expect(sentSchedule()).toEqual([
      ['pp-usa-2021', null],
      ['pp-gbr', null],
    ]);
  });

  it('refuses a start date that is not in the future', async () => {
    await expect(
      replaceInAppPurchaseManualPrices(connection, 'iap-1', { GB: { pricePointId: 'pp', startDate: '2020-01-01' } }, 'USA', {}, '2030-01-01')
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_START_DATE' });
    expect(appleApiRequest).not.toHaveBeenCalled();
  });
});

describe('replaceInAppPurchaseManualPrices', () => {
  it('sends one schedule: changed territories replaced, the rest kept, expired dropped', async () => {
    appleApiRequest.mockImplementation(async (_c: unknown, endpoint: string, options: { method?: string } = {}) => {
      if (options.method === 'POST') return {};
      if (endpoint === '/inAppPurchasePriceSchedules/iap-1/manualPrices') {
        return {
          data: [
            manual('m1', 'USA', 'pp-usa', null),
            manual('m2', 'GBR', 'pp-gbr-old', '2020-01-01'),
            manual('m3', 'FRA', 'pp-fra-next', '2099-01-01'),
            manual('m4', 'DEU', 'pp-deu-old', '2019-01-01', '2020-01-01'),
          ],
          links: { self: 'x' },
        };
      }
      throw new Error(`unexpected ${endpoint}`);
    });

    const result = await replaceInAppPurchaseManualPrices(
      connection,
      'iap-1',
      { GB: { pricePointId: 'pp-gbr-new' }, JP: { pricePointId: 'pp-jpn' } },
      'USA',
      {},
      '2030-01-01'
    );

    const posts = appleApiRequest.mock.calls.filter((c) => c[2]?.method === 'POST');
    expect(posts).toHaveLength(1);
    const body = posts[0][2].body as Body;
    expect(body.data.relationships.baseTerritory.data.id).toBe('USA');
    expect(body.included.map((i) => [i.relationships.inAppPurchasePricePoint.data.id, i.attributes.startDate])).toEqual([
      ['pp-usa', null],
      ['pp-gbr-new', null],
      ['pp-fra-next', '2099-01-01'],
      ['pp-jpn', null],
    ]);
    expect(body.data.relationships.manualPrices.data).toHaveLength(4);
    expect(result).toEqual({ sent: 2, kept: 2, keptScheduled: [] });
  });

  it('refuses to rebuild a schedule from an entry without its relationships', async () => {
    appleApiRequest.mockResolvedValue({
      data: [{ id: 'm1', type: 'inAppPurchasePrices', attributes: { startDate: null }, relationships: { territory: { data: { id: 'USA' } } } }],
      links: { self: 'x' },
    });
    await expect(
      replaceInAppPurchaseManualPrices(connection, 'iap-1', { GB: { pricePointId: 'pp' } }, 'USA')
    ).rejects.toMatchObject({ status: 502, code: 'INCOMPLETE_PRICE_SCHEDULE' });
    expect(appleApiRequest.mock.calls.some((c) => c[2]?.method === 'POST')).toBe(false);
  });

  it('treats a missing schedule as empty and still requires the base territory price', async () => {
    appleApiRequest.mockRejectedValue(new ApiError('Not found', { status: 404, platform: 'apple' }));
    await expect(
      replaceInAppPurchaseManualPrices(connection, 'iap-1', { GB: { pricePointId: 'pp' } }, 'USA')
    ).rejects.toMatchObject({ status: 422, code: 'MISSING_BASE_TERRITORY_PRICE' });
  });

  it('rejects unknown territories', async () => {
    await expect(
      replaceInAppPurchaseManualPrices(connection, 'iap-1', { ZZ: { pricePointId: 'pp' } }, 'USA')
    ).rejects.toMatchObject({ status: 400 });
    expect(appleApiRequest).not.toHaveBeenCalled();
  });
});
