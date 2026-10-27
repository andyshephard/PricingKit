import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appleHeaders, googleHeaders, testAppleToken } from './helpers';

const getExchangeRatesMock = vi.fn();
vi.mock('@/lib/exchange-rates/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exchange-rates/client')>();
  return {
    ...actual,
    getExchangeRates: (...args: unknown[]) => getExchangeRatesMock(...args),
  };
});

const getPPPMultipliersMock = vi.fn();
vi.mock('@/lib/world-bank/ppp', () => ({
  getPPPMultipliers: (...args: unknown[]) => getPPPMultipliersMock(...args),
}));

import { GET as settingsGET } from '../settings/exchange-rates/route';
import { GET as exchangeRatesGET } from '../exchange-rates/route';
import { GET as pppGET } from '../ppp/route';

const ENV_KEY = 'abcdef0123456789operatorkey9876';

const RATES = {
  base: 'USD',
  rates: { USD: 1, EUR: 0.9 },
  timestamp: 0,
  fetchedAt: new Date().toISOString(),
};

describe('public data endpoints', () => {
  beforeEach(() => {
    getExchangeRatesMock.mockReset().mockResolvedValue(RATES);
    getPPPMultipliersMock.mockReset().mockRejectedValue(new Error('World Bank down: internal detail'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('GET /api/settings/exchange-rates', () => {
    it('never returns any part of the operator env key', async () => {
      vi.stubEnv('OPEN_EXCHANGE_RATES_APP_ID', ENV_KEY);
      const res = await settingsGET();
      const body = await res.json();
      const text = JSON.stringify(body);

      expect(body).toMatchObject({ success: true, hasKey: true, configured: true, source: 'environment' });
      expect(body.apiKey).toBeUndefined();
      expect(text).not.toContain(ENV_KEY.slice(0, 4));
      expect(text).not.toContain(ENV_KEY.slice(-4));
    });

    it('reports none when no key is configured', async () => {
      vi.stubEnv('OPEN_EXCHANGE_RATES_APP_ID', '');
      const body = await (await settingsGET()).json();
      expect(body).toMatchObject({ success: true, hasKey: false, source: 'none' });
    });
  });

  describe('?refresh=true needs a store token header', () => {
    it('anonymous GET /api/exchange-rates still works', async () => {
      const res = await exchangeRatesGET(new Request('http://localhost/api/exchange-rates'));
      expect(res.status).toBe(200);
      expect(getExchangeRatesMock).toHaveBeenCalledWith(false, undefined);
    });

    it('anonymous refresh on /api/exchange-rates is refused without hitting upstream', async () => {
      const res = await exchangeRatesGET(new Request('http://localhost/api/exchange-rates?refresh=true'));
      expect(res.status).toBe(403);
      expect(getExchangeRatesMock).not.toHaveBeenCalled();
    });

    it('anonymous refresh on /api/ppp is refused without hitting upstream', async () => {
      const res = await pppGET(new Request('http://localhost/api/ppp?refresh=true'));
      expect(res.status).toBe(403);
      expect(getPPPMultipliersMock).not.toHaveBeenCalled();
      expect(getExchangeRatesMock).not.toHaveBeenCalled();
    });

    it('a malformed or expired token does not unlock refresh', async () => {
      for (const headers of [{ 'x-pk-apple-token': 'nope' }, appleHeaders(null, testAppleToken({ iat: Math.floor(Date.now() / 1000) - 3600 })), { 'x-pk-google-token': 'short' }]) {
        const res = await exchangeRatesGET(new Request('http://localhost/api/exchange-rates?refresh=true', { headers }));
        expect(res.status).toBe(403);
      }
    });

    it('a store token header allows a refresh (a speed bump: upstream caps still apply)', async () => {
      for (const headers of [googleHeaders(null), appleHeaders(null)]) {
        const res = await exchangeRatesGET(new Request('http://localhost/api/exchange-rates?refresh=true', { headers }));
        expect(res.status).toBe(200);
      }
      expect(getExchangeRatesMock).toHaveBeenCalledWith(true, undefined);
    });
  });

  describe("the user's Open Exchange Rates key comes from X-PK-OER-Key", () => {
    it('is passed on when well formed, and ignored otherwise', async () => {
      await exchangeRatesGET(new Request('http://localhost/api/exchange-rates', { headers: { 'x-pk-oer-key': '0123456789abcdef0123456789abcdef' } }));
      expect(getExchangeRatesMock).toHaveBeenLastCalledWith(false, '0123456789abcdef0123456789abcdef');
      await exchangeRatesGET(new Request('http://localhost/api/exchange-rates', { headers: { 'x-pk-oer-key': 'bad key!' } }));
      expect(getExchangeRatesMock).toHaveBeenLastCalledWith(false, undefined);
      await pppGET(new Request('http://localhost/api/ppp', { headers: { 'x-pk-oer-key': '0123456789abcdef0123456789abcdef' } }));
      expect(getExchangeRatesMock).toHaveBeenLastCalledWith(false, '0123456789abcdef0123456789abcdef');
    });
  });

  describe('error responses do not leak upstream messages', () => {
    it('/api/exchange-rates 500', async () => {
      getExchangeRatesMock.mockRejectedValue(new Error('upstream said: app_id=secret'));
      const res = await exchangeRatesGET(new Request('http://localhost/api/exchange-rates'));
      const text = JSON.stringify(await res.json());
      expect(res.status).toBe(500);
      expect(text).not.toContain('secret');
    });

    it('/api/ppp fallback metadata', async () => {
      getExchangeRatesMock.mockRejectedValue(new Error('upstream said: app_id=secret'));
      const res = await pppGET(new Request('http://localhost/api/ppp'));
      const text = JSON.stringify(await res.json());
      expect(res.status).toBe(200);
      expect(text).not.toContain('internal detail');
      expect(text).not.toContain('secret');
    });
  });
});
