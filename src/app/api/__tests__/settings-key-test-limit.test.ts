import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCookieStore, type TestCookieStore } from './helpers';

let cookieStore: TestCookieStore;
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

const hasSession = vi.fn();
vi.mock('@/lib/session', () => ({ hasAuthenticatedSession: () => hasSession() }));

import { POST } from '../settings/exchange-rates/route';

function keyTest(ip: string) {
  return POST(
    new Request('http://localhost/api/settings/exchange-rates', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ apiKey: 'test-key-0000' }),
    })
  );
}

describe('POST /api/settings/exchange-rates key test', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    cookieStore = createCookieStore();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('with a trusted IP header, limits each anonymous client to 5 key tests per window, without contacting the upstream', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', 'cf-connecting-ip');
    hasSession.mockResolvedValue(false);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await keyTest('192.0.2.10')).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const limited = await keyTest('192.0.2.10');
    expect(limited.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('ignores client IP headers unless trusted, so forging them gains nothing beyond the instance cap', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', '');
    hasSession.mockResolvedValue(false);
    const statuses = [];
    // A new forged address on every request: without a trusted header they all share one cap
    for (let i = 0; i < 52; i++) statuses.push((await keyTest(`198.51.100.${i}`)).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(50);
  });

  it('does not limit signed-in users', async () => {
    hasSession.mockResolvedValue(true);
    for (let i = 0; i < 7; i++) expect((await keyTest('192.0.2.20')).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
});
