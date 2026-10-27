import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '../types';
import { appleKeyConnection } from '../../token-source';

const appleApiRequest = vi.fn();
vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return { ...actual, appleApiRequest: (...args: unknown[]) => appleApiRequest(...args) };
});

import { appleListAll, appleListPages, appleNextLinkToEndpoint } from '../pagination';
import { RequestBudget } from '@/lib/utils/request-budget';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.test',
};
const connection = appleKeyConnection(credentials);

beforeEach(() => {
  appleApiRequest.mockReset();
});

describe('appleNextLinkToEndpoint', () => {
  it('keeps the cursor and the API version', () => {
    expect(
      appleNextLinkToEndpoint('https://api.appstoreconnect.apple.com/v1/apps/1/subscriptionGroups?cursor=abc&limit=200')
    ).toEqual({ endpoint: '/apps/1/subscriptionGroups?cursor=abc&limit=200', apiVersion: 'v1' });
    expect(
      appleNextLinkToEndpoint('https://api.appstoreconnect.apple.com/v2/inAppPurchases/9/pricePoints?cursor=x')
    ).toEqual({ endpoint: '/inAppPurchases/9/pricePoints?cursor=x', apiVersion: 'v2' });
    expect(appleNextLinkToEndpoint('/relative')).toEqual({ endpoint: '/relative' });
  });
});

describe('appleListAll', () => {
  it('sends query params once, then follows links.next exactly', async () => {
    appleApiRequest
      .mockResolvedValueOnce({
        data: [{ id: 'a' }],
        included: [{ id: 't1', type: 'territories' }],
        links: { self: 's', next: 'https://api.appstoreconnect.apple.com/v1/things?cursor=2' },
      })
      .mockResolvedValueOnce({ data: [{ id: 'b' }], links: { self: 's' } });

    const budget = new RequestBudget({ limit: 10 });
    const result = await appleListAll(connection, '/things', { queryParams: { limit: '200' }, budget });

    expect(result.data.map((d) => (d as { id: string }).id)).toEqual(['a', 'b']);
    expect(result.included).toHaveLength(1);
    expect(appleApiRequest.mock.calls[0][1]).toBe('/things');
    expect(appleApiRequest.mock.calls[0][2]).toMatchObject({ queryParams: { limit: '200' }, budget });
    expect(appleApiRequest.mock.calls[1][1]).toBe('/things?cursor=2');
    expect(appleApiRequest.mock.calls[1][2]).toMatchObject({ queryParams: undefined, apiVersion: 'v1', budget });
  });

  it('stops when Apple repeats a link', async () => {
    const page = { data: [{ id: 'x' }], links: { self: 's', next: 'https://api.appstoreconnect.apple.com/v1/things?cursor=1' } };
    appleApiRequest.mockResolvedValue(page);
    const result = await appleListAll(connection, '/things');
    expect(appleApiRequest).toHaveBeenCalledTimes(2);
    expect(result.data).toHaveLength(2);
  });

  it('fails instead of returning a truncated list', async () => {
    let n = 0;
    appleApiRequest.mockImplementation(async () => ({
      data: [{ id: String(n) }],
      links: { self: 's', next: `https://api.appstoreconnect.apple.com/v1/things?cursor=${++n}` },
    }));
    await expect(appleListAll(connection, '/things', { maxPages: 3 })).rejects.toMatchObject({
      code: 'PAGINATION_LIMIT',
    });
  });

  it('yields pages lazily', async () => {
    appleApiRequest.mockResolvedValue({ data: [1], links: { self: 's', next: 'https://api.appstoreconnect.apple.com/v1/n?cursor=1' } });
    const pages = appleListPages(connection, '/n');
    await pages.next();
    expect(appleApiRequest).toHaveBeenCalledTimes(1);
  });
});
