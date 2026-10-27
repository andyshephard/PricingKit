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
  });

  it('limits anonymous callers to 5 key tests per window, without contacting the upstream', async () => {
    hasSession.mockResolvedValue(false);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await keyTest('192.0.2.10')).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const limited = await keyTest('192.0.2.10');
    expect(limited.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('does not limit signed-in users', async () => {
    hasSession.mockResolvedValue(true);
    for (let i = 0; i < 7; i++) expect((await keyTest('192.0.2.20')).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
});
