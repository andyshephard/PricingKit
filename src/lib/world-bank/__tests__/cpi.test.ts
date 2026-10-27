// World Bank CPI series for the "inflate" stale-PPP policy: one shared
// request for concurrent callers, results cached, failures remembered for 5
// minutes. fetch is stubbed: nothing leaves the process.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CPI_FAILURE_CACHE_MS, getCpiSeries, resetCpiCacheForTests } from '../ppp';

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
