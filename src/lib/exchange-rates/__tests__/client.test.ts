// Open Exchange Rates: one in-flight request, failures remembered, refresh
// only with the caller's own key, a shared cache when the platform has one,
// and a timeout. fetch and the disk cache are stubbed: nothing leaves the process.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => {
    throw new Error('no disk cache in tests');
  }),
  writeFile: vi.fn(async () => {}),
}));

import { FAILURE_CACHE_MS, getExchangeRates, NoApiKeyError, resetExchangeRatesCacheForTests } from '../client';

const NOW = new Date('2030-06-01T00:00:00Z');
const ratesBody = () => new Response(JSON.stringify({ disclaimer: '', license: '', timestamp: 1, base: 'USD', rates: { USD: 1, EUR: 0.9 } }));
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetExchangeRatesCacheForTests();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('OPEN_EXCHANGE_RATES_APP_ID', 'operatorkey0000');
  fetchMock = vi.fn(async () => ratesBody());
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const keyOf = (call: unknown[]) => new URL(String(call[0])).searchParams.get('app_id');

describe('getExchangeRates', () => {
  it('concurrent misses share one upstream request, with a timeout', async () => {
    let release!: () => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => (release = () => resolve(ratesBody()))));
    const calls = Array.from({ length: 10 }, () => getExchangeRates());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    release();
    const results = await Promise.all(calls);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r === results[0])).toBe(true);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('remembers a failure for 5 minutes instead of retrying on every request', async () => {
    fetchMock.mockResolvedValue(new Response('{"description":"secret detail"}', { status: 429 }));
    await expect(getExchangeRates()).rejects.toThrow('Open Exchange Rates API error: 429');
    await expect(getExchangeRates()).rejects.toThrow(/429/);
    await expect(getExchangeRates()).rejects.not.toThrow(/secret detail/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW.getTime() + FAILURE_CACHE_MS + 1);
    fetchMock.mockImplementation(async () => ratesBody());
    await expect(getExchangeRates()).resolves.toMatchObject({ base: 'USD' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves stale data during an outage', async () => {
    await getExchangeRates();
    vi.setSystemTime(NOW.getTime() + 7 * 3600_000);
    fetchMock.mockRejectedValue(new Error('network down'));
    const stale = await getExchangeRates();
    expect(stale.rates.EUR).toBe(0.9);
    await getExchangeRates();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('?refresh=true never spends the operator key: with only that key it is served from the cache', async () => {
    await getExchangeRates();
    for (let i = 0; i < 20; i++) await getExchangeRates(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a refresh with the user's own key goes upstream with that key", async () => {
    await getExchangeRates();
    await getExchangeRates(true, 'userkey00000000');
    await getExchangeRates(true, 'userkey00000000');
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(['operatorkey0000', 'userkey00000000', 'userkey00000000']);
  });

  it('without any key, fails without contacting anyone (and not remembered as an upstream failure)', async () => {
    vi.stubEnv('OPEN_EXCHANGE_RATES_APP_ID', '');
    await expect(getExchangeRates()).rejects.toBeInstanceOf(NoApiKeyError);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(getExchangeRates(false, 'userkey00000000')).resolves.toMatchObject({ base: 'USD' });
  });

  it("a bogus user key can't poison the operator key: its failure isn't remembered and its request isn't shared", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).searchParams.get('app_id') === 'bogususerkey0000' ? new Response('{"error":true}', { status: 401 }) : ratesBody()
    );
    await expect(getExchangeRates(false, 'bogususerkey0000')).rejects.toThrow(/401/);
    await expect(getExchangeRates(true, 'bogususerkey0000')).rejects.toThrow(/401/);
    // The next visitor, on the operator key, still goes upstream and gets rates
    await expect(getExchangeRates()).resolves.toMatchObject({ base: 'USD' });
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(['bogususerkey0000', 'bogususerkey0000', 'operatorkey0000']);
  });

  it('a user-key request never waits on, or hands its result to, an operator-key request in flight', async () => {
    let release!: () => void;
    fetchMock.mockImplementation((url: string) =>
      new URL(url).searchParams.get('app_id') === 'operatorkey0000'
        ? new Promise((resolve) => (release = () => resolve(ratesBody())))
        : Promise.resolve(new Response('{"error":true}', { status: 401 }))
    );
    const operator = getExchangeRates();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(getExchangeRates(false, 'bogususerkey0000')).rejects.toThrow(/401/);
    release();
    await expect(operator).resolves.toMatchObject({ base: 'USD' });
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(['operatorkey0000', 'bogususerkey0000']);
  });

  it("shares results across isolates through the platform cache (Cloudflare's caches.default)", async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', {
      default: {
        match: async (url: string) => store.get(url)?.clone(),
        put: async (url: string, response: Response) => void store.set(url, response),
      },
    });
    await getExchangeRates();
    expect(store.size).toBe(1);
    resetExchangeRatesCacheForTests(); // another isolate: empty memory
    await getExchangeRates();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
