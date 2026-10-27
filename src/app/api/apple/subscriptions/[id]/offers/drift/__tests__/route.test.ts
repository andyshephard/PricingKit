import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { RequestBudget } from '@/lib/utils/request-budget';

vi.mock('@/middleware/auth', () => ({
  getAppleAuthFromCookies: vi.fn(async () => ({
    credentials: { privateKey: 'unused', keyId: 'TESTKEY123', issuerId: 'issuer', bundleId: 'com.example.test' },
    bundleId: 'com.example.test',
  })),
}));

const checkOfferDrift = vi.fn();
const constructed: Array<{ budget?: unknown }> = [];
vi.mock('@/lib/adapters/apple', () => ({
  AppleAdapter: class {
    constructor(options: { budget?: unknown }) {
      constructed.push(options);
    }
    checkOfferDrift = (...args: unknown[]) => checkOfferDrift(...args);
  },
}));

import { GET } from '../route';

function call(id: string, query: string) {
  return GET(new NextRequest(`http://localhost/api/apple/subscriptions/${id}/offers/drift?${query}`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  checkOfferDrift.mockReset();
  constructed.length = 0;
});

describe('GET offers/drift', () => {
  it('passes a validated rule and a fresh budget to the adapter', async () => {
    checkOfferDrift.mockResolvedValue({ kind: 'pricingkit.offerDrift', inSync: true });
    const response = await call('123', 'kind=apple.promo&offer=example_half&percent=50.0&basis=totalOverDuration&snap=floor&threshold=0.1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ report: { kind: 'pricingkit.offerDrift', inSync: true } });
    expect(checkOfferDrift).toHaveBeenCalledWith(
      { platform: 'apple', type: 'subscription', id: '123' },
      {
        kind: 'apple.promo',
        offer: 'example_half',
        rule: { type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'floor' },
        deviationThreshold: '0.1',
      }
    );
    expect(constructed[0].budget).toBeInstanceOf(RequestBudget);
  });

  it('defaults to perPeriod and nearest', async () => {
    checkOfferDrift.mockResolvedValue({});
    await call('123', 'kind=apple.winBack&offer=x&percent=25');
    expect(checkOfferDrift.mock.calls[0][1].rule).toEqual({ type: 'percentOfCurrent', percent: '25', basis: 'perPeriod', snap: 'nearest' });
  });

  it('refuses bad input before reading anything', async () => {
    for (const query of ['kind=apple.promo&offer=x&percent=150', 'kind=play.offer&offer=x&percent=50', 'kind=apple.promo&percent=50', 'kind=apple.promo&offer=x&percent=abc']) {
      expect((await call('123', query)).status).toBe(400);
    }
    expect((await call('com.example.sub', 'kind=apple.promo&offer=x&percent=50')).status).toBe(400);
    expect(checkOfferDrift).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown offer', async () => {
    checkOfferDrift.mockResolvedValue(null);
    expect((await call('123', 'kind=apple.promo&offer=x&percent=50')).status).toBe(404);
  });
});
