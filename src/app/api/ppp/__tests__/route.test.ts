// /api/ppp: data years, the stale-PPP policy (cap or inflate by CPI) and
// freshness metadata. The World Bank and exchange-rate clients are mocked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCookieStore, type TestCookieStore } from '@/app/api/__tests__/helpers';

let cookieStore: TestCookieStore;
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
const getExchangeRates = vi.fn();
vi.mock('@/lib/exchange-rates/client', () => ({ getExchangeRates: (...a: unknown[]) => getExchangeRates(...a) }));
const getPPPMultipliers = vi.fn();
const getCpiSeries = vi.fn();
vi.mock('@/lib/world-bank/ppp', () => ({
  getPPPMultipliers: (...a: unknown[]) => getPPPMultipliers(...a),
  getCpiSeries: (...a: unknown[]) => getCpiSeries(...a),
}));

import { GET } from '../route';

const NOW = new Date('2030-06-01T00:00:00Z');
type Body = { success: boolean; data: Record<string, { pppMultiplier: number; source: string; pppYear?: number; pppStale?: boolean }>; metadata: Record<string, unknown> & { freshness: Array<{ id: string; stale: boolean; asOf?: string }> } };
const get = async (query = '') => {
  const res = await GET(new Request(`http://localhost/api/ppp${query}`));
  return { status: res.status, body: (await res.json()) as Body };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  cookieStore = createCookieStore();
  getExchangeRates.mockReset().mockResolvedValue({ base: 'USD', rates: { USD: 1, GBP: 0.8, INR: 80 }, timestamp: Date.parse('2030-05-31T12:00:00Z') / 1000, fetchedAt: NOW.toISOString() });
  getPPPMultipliers.mockReset().mockResolvedValue({
    multipliers: { US: 1, GB: 1, IN: 0.5 },
    pppConversionFactors: { US: 1, GB: 0.7, IN: 20 },
    years: { US: 2029, GB: 2029, IN: 2020 },
    baseYear: 2029,
    fetchedAt: NOW,
  });
  getCpiSeries.mockReset().mockResolvedValue({ IN: { 2020: 100, 2029: 150 }, US: { 2020: 100, 2029: 110 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GET /api/ppp staleness and freshness', () => {
  it('cap (default): a country whose PPP data is older than 3 years uses the static index, flagged', async () => {
    const { body } = await get();
    expect(body.data.GB).toMatchObject({ source: 'world-bank', pppYear: 2029 });
    expect(body.data.GB.pppStale).toBeUndefined();
    expect(body.data.IN).toMatchObject({ source: 'static', pppYear: 2020, pppStale: true });
    expect(body.metadata.pppStaleness).toEqual({ mode: 'cap', maxAgeYears: 3, regions: [{ region: 'IN', year: 2020, action: 'static' }] });
    expect(getCpiSeries).not.toHaveBeenCalled();
    expect(body.metadata.exchangeRatesAsOf).toBe('2030-05-31T12:00:00.000Z');
    expect(body.metadata.freshness.map((f) => `${f.id}:${f.stale}`)).toEqual(['ppp:false', 'bigmac:true', 'netflix:true', 'exchangeRates:false', 'appleTiers:true']);
  });

  it('inflate: the old factor is carried forward by CPI relative to the US', async () => {
    const { body } = await get('?pppStale=inflate');
    expect(getCpiSeries).toHaveBeenCalledWith(2020, NOW);
    // 20 x (150/100) / (110/100) / 80 INR per USD
    expect(body.data.IN.pppMultiplier).toBeCloseTo((20 * 1.5) / 1.1 / 80, 6);
    expect(body.data.IN).toMatchObject({ source: 'world-bank', pppStale: true, pppYear: 2020 });
    expect(body.metadata.pppStaleness).toMatchObject({ mode: 'inflate', regions: [{ region: 'IN', year: 2020, action: 'inflated', factorRatio: expect.closeTo(1.5 / 1.1, 6) }] });
  });

  it('inflate without CPI data falls back to the static index and says so; a larger maxAge keeps live data', async () => {
    getCpiSeries.mockRejectedValue(new Error('down'));
    const { body } = await get('?pppStale=inflate');
    expect(body.data.IN).toMatchObject({ source: 'static', pppStale: true });
    expect(body.metadata.pppStaleness).toMatchObject({ error: expect.stringMatching(/CPI data unavailable/) });
    const relaxed = await get('?pppMaxAge=20');
    expect(relaxed.body.data.IN).toMatchObject({ source: 'world-bank', pppYear: 2020 });
  });

  it('refuses an unknown policy; the static fallback carries freshness too', async () => {
    expect((await get('?pppStale=sometimes')).status).toBe(400);
    expect((await get('?pppMaxAge=-1')).status).toBe(400);
    getPPPMultipliers.mockRejectedValue(new Error('down'));
    const { body } = await get();
    expect(body.metadata.fallback).toBe(true);
    expect(body.metadata.freshness[0]).toMatchObject({ id: 'ppp', asOf: '2024-12-31' });
  });
});
