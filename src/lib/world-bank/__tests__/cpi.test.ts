// World Bank CPI series for the "inflate" stale-PPP policy: one shared
// request for concurrent callers, results cached, failures remembered for 5
// minutes. fetch is stubbed: nothing leaves the process.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CPI_FAILURE_CACHE_MS, getCpiSeries, getPPPMultipliers, PPP_FAILURE_CACHE_MS, PPP_MIN_REFRESH_INTERVAL_MS, resetCpiCacheForTests, resetPPPCacheForTests } from '../ppp';

const NOW = new Date('2030-06-01T00:00:00Z');
const body = [{ page: 1 }, [
  { countryiso3code: 'IND', date: '2020', value: 100 },
  { countryiso3code: 'IND', date: '2029', value: 150 },
  { countryiso3code: 'USA', date: '2020', value: 100 },
  { countryiso3code: 'USA', date: '2029', value: null },
  { countryiso3code: 'ZZZ', date: '2029', value: 1 },
]];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetCpiCacheForTests();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('getCpiSeries', () => {
  it('concurrent callers share one request; the result is cached', async () => {
    let release!: () => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (release = () => resolve(new Response(JSON.stringify(body))))));
    const calls = [getCpiSeries(2020, NOW), getCpiSeries(2020, NOW), getCpiSeries(2020, NOW)];
    release();
    const [a, b, c] = await Promise.all(calls);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('FP.CPI.TOTL?format=json&per_page=20000&date=2020:2030');
    expect(a).toEqual({ IN: { 2020: 100, 2029: 150 }, US: { 2020: 100 } });
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(await getCpiSeries(2020, NOW)).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Another range is another request
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)));
    await getCpiSeries(2018, NOW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('remembers a failure for 5 minutes, then tries again', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 503 }));
    await expect(getCpiSeries(2020, NOW)).rejects.toThrow(/503/);
    await expect(getCpiSeries(2020, NOW)).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(NOW.getTime() + CPI_FAILURE_CACHE_MS - 1000));
    await expect(getCpiSeries(2020, NOW)).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(NOW.getTime() + CPI_FAILURE_CACHE_MS + 1000));
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(getCpiSeries(2020, NOW)).resolves.toMatchObject({ IN: { 2029: 150 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('getPPPMultipliers', () => {
  const pppBody = () =>
    new Response(JSON.stringify([{ page: 1 }, [
      { countryiso3code: 'USA', date: '2029', value: 1 },
      { countryiso3code: 'IND', date: '2029', value: 20 },
    ]]));

  beforeEach(() => {
    resetPPPCacheForTests();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('concurrent callers share one request', async () => {
    fetchMock.mockImplementation(async () => pppBody());
    const results = await Promise.all([getPPPMultipliers(), getPPPMultipliers(), getPPPMultipliers()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
  });

  it('remembers a failure for 5 minutes', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    await expect(getPPPMultipliers()).rejects.toThrow();
    const calls = fetchMock.mock.calls.length;
    await expect(getPPPMultipliers()).rejects.toThrow();
    await expect(getPPPMultipliers(true)).rejects.toThrow();
    expect(fetchMock.mock.calls.length).toBe(calls);
    vi.setSystemTime(NOW.getTime() + PPP_FAILURE_CACHE_MS + 1);
    fetchMock.mockImplementation(async () => pppBody());
    await expect(getPPPMultipliers()).resolves.toMatchObject({ baseYear: 2029 });
  });

  it('honours a forced refresh at most once per 10 minutes', async () => {
    fetchMock.mockImplementation(async () => pppBody());
    await getPPPMultipliers();
    for (let i = 0; i < 5; i++) await getPPPMultipliers(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW.getTime() + PPP_MIN_REFRESH_INTERVAL_MS);
    await getPPPMultipliers(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
