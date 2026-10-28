import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APPLE_APPLY_MIN_VALID_SECONDS, BrowserKeyError, GOOGLE_APPLY_MIN_VALID_SECONDS, type TokenOptions } from '@/lib/browser-keys';
import { createApiFetch, planRoute, type ApiFetchDeps, type TokenProvider } from '../api-fetch';

const NOW = Date.parse('2030-01-01T12:00:00Z');

/** Token provider that hands out apple-1, apple-2, ... and records each request's options */
function fakeKeys() {
  let apple = 0;
  let google = 0;
  let offset = 0;
  const calls: Array<{ platform: 'apple' | 'google'; options: TokenOptions }> = [];
  const keys: TokenProvider & { calls: typeof calls; offsets: number[] } = {
    calls,
    offsets: [],
    getAppleToken: vi.fn(async (options: TokenOptions = {}) => {
      calls.push({ platform: 'apple', options });
      return `apple-${++apple}`;
    }),
    getGoogleAccessToken: vi.fn(async (options: TokenOptions = {}) => {
      calls.push({ platform: 'google', options });
      return `google-${++google}`;
    }),
    setClockOffsetMs: vi.fn((ms: number) => {
      offset = ms;
      keys.offsets.push(ms);
    }),
    getClockOffsetMs: () => offset,
  };
  return keys;
}

type Sent = { url: string; method: string; headers: Headers; body?: BodyInit | null };

function setup(responses: Array<(sent: Sent) => Response>, overrides: Partial<ApiFetchDeps> = {}) {
  const keys = fakeKeys();
  const sent: Sent[] = [];
  const onAuthFailure = vi.fn();
  const queue = [...responses];
  const deps: ApiFetchDeps = {
    keys: () => keys,
    fetch: vi.fn(async (input: string, init: RequestInit) => {
      const request = { url: input, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body };
      sent.push(request);
      const next = queue.shift();
      return next ? next(request) : Response.json({ ok: true });
    }),
    activeApp: (platform) => (platform === 'apple' ? 'com.example.ios' : 'com.example.android'),
    activePlatform: () => 'apple',
    oerKey: () => null,
    onAuthFailure,
    now: () => NOW,
    ...overrides,
  };
  return { apiFetch: createApiFetch(deps), keys, sent, onAuthFailure };
}

const ok = () => Response.json({ ok: true });
const unauthorized = (code: string, date?: string) => () =>
  Response.json({ error: 'no', code }, { status: 401, headers: date ? { Date: date } : {} });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('planRoute', () => {
  const plan = (path: string) => planRoute(new URL(path, 'http://localhost'));
  it('maps each /api route to its store and whether it needs an app', () => {
    expect(plan('/api/apple/products')).toEqual({ platform: 'apple', needsApp: true, publicData: false });
    expect(plan('/api/apple/subscriptions/1/offers/apply')).toMatchObject({ platform: 'apple', needsApp: true });
    expect(plan('/api/apple/apps')).toMatchObject({ platform: 'apple', needsApp: false });
    expect(plan('/api/apple/auth')).toMatchObject({ platform: 'apple', needsApp: false });
    expect(plan('/api/apple/active-app')).toMatchObject({ platform: 'apple', needsApp: false });
    expect(plan('/api/products/sku')).toMatchObject({ platform: 'google', needsApp: true });
    expect(plan('/api/subscriptions')).toMatchObject({ platform: 'google', needsApp: true });
    expect(plan('/api/bulk')).toMatchObject({ platform: 'google', needsApp: true });
    expect(plan('/api/auth')).toMatchObject({ platform: 'google', needsApp: true });
    expect(plan('/api/active-app')).toMatchObject({ platform: 'google', needsApp: false });
    expect(plan('/api/export?platform=apple&type=inapp&id=x')).toMatchObject({ platform: 'apple', needsApp: true });
    expect(plan('/api/export?platform=google&type=inapp&id=x')).toMatchObject({ platform: 'google', needsApp: true });
    expect(plan('/api/ppp')).toEqual({ platform: null, needsApp: false, publicData: true });
    expect(plan('/api/exchange-rates?refresh=true')).toMatchObject({ publicData: true });
    expect(plan('/api/settings/exchange-rates')).toEqual({ platform: null, needsApp: false, publicData: false });
    // Look-alike prefixes are not store routes
    expect(plan('/api/productsx')).toMatchObject({ platform: null });
  });
});

describe('apiFetch headers', () => {
  it('sends the Apple token and app on Apple routes, the Google token and package on Google routes', async () => {
    const { apiFetch, sent } = setup([]);
    await apiFetch('/api/apple/products');
    await apiFetch('/api/products');
    expect(sent[0].headers.get('x-pk-apple-token')).toBe('apple-1');
    expect(sent[0].headers.get('x-pk-app')).toBe('com.example.ios');
    expect(sent[0].headers.get('x-pk-google-token')).toBeNull();
    expect(sent[1].headers.get('x-pk-google-token')).toBe('google-1');
    expect(sent[1].headers.get('x-pk-app')).toBe('com.example.android');
    expect(sent[1].headers.get('x-pk-apple-token')).toBeNull();
  });

  it('sends no app where the route takes none, and honours overrides', async () => {
    const { apiFetch, sent } = setup([]);
    await apiFetch('/api/apple/apps');
    await apiFetch('/api/auth', { method: 'POST', app: 'com.example.new' });
    expect(sent[0].headers.get('x-pk-app')).toBeNull();
    expect(sent[1].headers.get('x-pk-app')).toBe('com.example.new');
  });

  it('asks for a long-lived token on writes and exports, a normal one on reads', async () => {
    const { apiFetch, keys } = setup([]);
    await apiFetch('/api/apple/products');
    await apiFetch('/api/apple/subscriptions/1/offers/apply', { method: 'POST', body: '{}' });
    await apiFetch('/api/bulk', { method: 'POST', body: '{}' });
    await apiFetch('/api/export?platform=apple&type=inapp&id=x');
    expect(keys.calls.map((c) => c.options.minValidSeconds)).toEqual([undefined, APPLE_APPLY_MIN_VALID_SECONDS, GOOGLE_APPLY_MIN_VALID_SECONDS, APPLE_APPLY_MIN_VALID_SECONDS]);
  });

  it('public data routes get the OER key, and a store token only on refresh', async () => {
    const { apiFetch, sent, keys } = setup([], { oerKey: () => '0123456789abcdef0123456789abcdef' });
    await apiFetch('/api/ppp');
    await apiFetch('/api/exchange-rates?refresh=true');
    expect(sent[0].headers.get('x-pk-oer-key')).toBe('0123456789abcdef0123456789abcdef');
    expect(sent[0].headers.get('x-pk-apple-token')).toBeNull();
    expect(sent[1].headers.get('x-pk-apple-token')).toBe('apple-1');
    expect(keys.calls).toHaveLength(1);
  });

  it('leaves other routes alone', async () => {
    const { apiFetch, sent, keys } = setup([]);
    await apiFetch('/api/settings/exchange-rates');
    expect([...sent[0].headers.keys()]).toEqual([]);
    expect(keys.calls).toHaveLength(0);
  });
});

describe('apiFetch on 401', () => {
  it('retries a read once with a new token, passing the refused one as rejected', async () => {
    const { apiFetch, sent, keys, onAuthFailure } = setup([unauthorized('NOT_AUTHORIZED'), ok]);
    const response = await apiFetch('/api/apple/products');
    expect(response.status).toBe(200);
    expect(sent.map((s) => s.headers.get('x-pk-apple-token'))).toEqual(['apple-1', 'apple-2']);
    expect(keys.calls[1].options).toEqual({ rejected: 'apple-1' });
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('corrects the clock from the Date header when it is clearly off', async () => {
    const serverAhead = new Date(NOW + 5 * 60 * 1000).toUTCString();
    const { apiFetch, keys } = setup([unauthorized('TOKEN_EXPIRED', serverAhead), ok]);
    await apiFetch('/api/apple/products');
    expect(keys.offsets).toEqual([5 * 60 * 1000]);

    const close = setup([unauthorized('TOKEN_EXPIRED', new Date(NOW + 2000).toUTCString()), ok]);
    await close.apiFetch('/api/apple/products');
    expect(close.keys.offsets).toEqual([]);
  });

  it('re-signs with minValidSeconds on TOKEN_TOO_SHORT', async () => {
    const { apiFetch, keys } = setup([unauthorized('TOKEN_TOO_SHORT'), ok]);
    await apiFetch('/api/apple/products');
    expect(keys.calls[1].options).toEqual({ rejected: 'apple-1', minValidSeconds: APPLE_APPLY_MIN_VALID_SECONDS });
  });

  it('retries a write only when the server auth check refused it', async () => {
    const preCheck = setup([unauthorized('TOKEN_TOO_SHORT'), ok]);
    const retried = await preCheck.apiFetch('/api/apple/subscriptions/1/offers/apply', { method: 'POST', body: '{"a":1}' });
    expect(retried.status).toBe(200);
    expect(preCheck.sent).toHaveLength(2);
    expect(preCheck.sent[1].body).toBe('{"a":1}');

    // Refused by the store after the route started: not replayed, Connect prompt
    const upstream = setup([unauthorized('NOT_AUTHORIZED')]);
    const refused = await upstream.apiFetch('/api/apple/subscriptions/1/offers/apply', { method: 'POST', body: '{}' });
    expect(refused.status).toBe(401);
    expect(upstream.sent).toHaveLength(1);
    expect(upstream.onAuthFailure).toHaveBeenCalledWith('apple');
  });

  it('prompts to connect after a second 401, and retries only once', async () => {
    const { apiFetch, sent, onAuthFailure } = setup([unauthorized('INVALID_TOKEN'), unauthorized('INVALID_TOKEN'), ok]);
    const response = await apiFetch('/api/products');
    expect(response.status).toBe(401);
    expect(sent).toHaveLength(2);
    expect(onAuthFailure).toHaveBeenCalledWith('google');
  });

  it('can keep quiet for the connect flow, which shows its own message', async () => {
    const { apiFetch, onAuthFailure } = setup([unauthorized('INVALID_TOKEN'), unauthorized('INVALID_TOKEN')]);
    await apiFetch('/api/apple/auth', { method: 'POST', quietAuthFailure: true });
    expect(onAuthFailure).not.toHaveBeenCalled();
  });
});

describe('apiFetch without a usable key', () => {
  it('answers 401 NOT_CONNECTED without calling the server, and prompts to connect', async () => {
    const { apiFetch, sent, keys, onAuthFailure } = setup([]);
    vi.mocked(keys.getAppleToken).mockRejectedValueOnce(new BrowserKeyError('not_connected', 'No App Store Connect key is stored in this browser. Connect again.'));
    const response = await apiFetch('/api/apple/products');
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('NOT_CONNECTED');
    expect(sent).toHaveLength(0);
    expect(onAuthFailure).toHaveBeenCalledWith('apple');
  });

  it("reports a network failure at Google's token endpoint without the Connect prompt", async () => {
    const { apiFetch, keys, sent, onAuthFailure } = setup([]);
    vi.mocked(keys.getGoogleAccessToken).mockRejectedValueOnce(new BrowserKeyError('network', 'Could not reach Google.'));
    const response = await apiFetch('/api/products');
    expect(response.status).toBe(503);
    expect(sent).toHaveLength(0);
    expect(onAuthFailure).not.toHaveBeenCalled();
  });
});
