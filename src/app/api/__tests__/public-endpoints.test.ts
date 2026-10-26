import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCookieStore, type TestCookieStore } from './helpers';

let cookieStore: TestCookieStore;
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

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
import { createSession } from '@/lib/google-play/client';
import type { ServiceAccountCredentials } from '@/lib/google-play/types';

const ENV_KEY = 'abcdef0123456789operatorkey9876';

const RATES = {
  base: 'USD',
  rates: { USD: 1, EUR: 0.9 },
  timestamp: 0,
  fetchedAt: new Date().toISOString(),
};

describe('public data endpoints', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', 'test-encryption-key-at-least-32-characters');
    cookieStore = createCookieStore();
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

  describe('?refresh=true requires a session', () => {
    it('anonymous GET /api/exchange-rates still works', async () => {
      const res = await exchangeRatesGET(new Request('http://localhost/api/exchange-rates'));
      expect(res.status).toBe(200);
      expect(getExchangeRatesMock).toHaveBeenCalledWith(false, undefined);
    });

    it('anonymous refresh on /api/exchange-rates returns 401 without hitting upstream', async () => {
      const res = await exchangeRatesGET(new Request('http://localhost/api/exchange-rates?refresh=true'));
      expect(res.status).toBe(401);
      expect(getExchangeRatesMock).not.toHaveBeenCalled();
    });

    it('anonymous refresh on /api/ppp returns 401 without hitting upstream', async () => {
      const res = await pppGET(new Request('http://localhost/api/ppp?refresh=true'));
      expect(res.status).toBe(401);
      expect(getPPPMultipliersMock).not.toHaveBeenCalled();
      expect(getExchangeRatesMock).not.toHaveBeenCalled();
    });

    it('a forged session cookie does not unlock refresh', async () => {
      cookieStore = createCookieStore({ gplay_session: 'not-a-valid-session', apple_session: 'nope' });
      const res = await exchangeRatesGET(new Request('http://localhost/api/exchange-rates?refresh=true'));
      expect(res.status).toBe(401);
    });

    it('a valid Google session can force a refresh', async () => {
      const session = await createSession({
        type: 'service_account',
        client_email: 'svc@example.iam.gserviceaccount.com',
        private_key_id: 'kid',
        private_key: 'unused',
      } as ServiceAccountCredentials);
      cookieStore = createCookieStore({ gplay_session: session });

      const res = await exchangeRatesGET(new Request('http://localhost/api/exchange-rates?refresh=true'));
      expect(res.status).toBe(200);
      expect(getExchangeRatesMock).toHaveBeenCalledWith(true, undefined);
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
