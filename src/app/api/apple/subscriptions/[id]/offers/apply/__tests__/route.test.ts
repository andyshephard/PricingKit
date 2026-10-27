import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { planOfferChanges, type ChangeSet, type OfferPlanInput } from '@/lib/pricing';

const session = {
  credentials: { privateKey: 'unused', keyId: 'TESTKEY123', issuerId: 'issuer', bundleId: 'com.example.test' },
  bundleId: 'com.example.test',
};
const getAppleAuthFromCookies = vi.fn();
vi.mock('@/middleware/auth', () => ({ getAppleAuthFromCookies: () => getAppleAuthFromCookies() }));

const applyOffer = vi.fn();
const fetchOffers = vi.fn();
vi.mock('@/lib/adapters/apple', () => ({
  AppleAdapter: class {
    platform = 'apple';
    fetchOffers = (...args: unknown[]) => fetchOffers(...args);
    applyOffer = (...args: unknown[]) => applyOffer(...args);
    fetchState = async () => {
      throw new Error('not expected');
    };
    apply = async () => {
      throw new Error('not expected');
    };
    resolvePricePoints = async () => ({ resolved: {}, unresolved: {} });
    inverse = () => ({ notReversible: 'n/a' });
  },
}));

import { POST } from '../route';

function makePlan(id = '123', bundleId = 'com.example.test') {
  const product = { platform: 'apple' as const, type: 'subscription' as const, id };
  const input: OfferPlanInput = {
    spec: {
      id: 'example_half',
      productRef: product,
      kind: 'apple.promo',
      mode: 'PAY_UP_FRONT',
      duration: 'P1Y',
      pricing: { type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'nearest' },
      territories: 'all',
      syncWithBase: true,
    },
    billingPeriod: 'P1Y',
    base: { product, capturedAt: 'x', territories: { US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '59.99' } } } },
    ladders: { US: { currency: 'USD', points: [{ id: 'us-2999', customerPrice: '29.99' }] } },
    existing: [],
  };
  return planOfferChanges({ app: { bundleId }, inputs: [input], createdAt: '2030-01-01T00:00:00Z' });
}

const call = (body: unknown, id = '123') =>
  POST(new NextRequest(`http://localhost/api/apple/subscriptions/${id}/offers/apply`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  getAppleAuthFromCookies.mockReset();
  getAppleAuthFromCookies.mockResolvedValue(session);
  applyOffer.mockReset();
  applyOffer.mockResolvedValue({ createdOfferId: 'promo-1' });
  fetchOffers.mockReset();
  fetchOffers.mockResolvedValue([]);
});

describe('POST offers/apply', () => {
  it('returns 401 without a session and sends nothing', async () => {
    getAppleAuthFromCookies.mockResolvedValue(null);
    const plan = makePlan();
    expect((await call({ changeSet: plan.changeSet, confirm: plan.hash })).status).toBe(401);
    expect(fetchOffers).not.toHaveBeenCalled();
    expect(applyOffer).not.toHaveBeenCalled();
  });

  it('applies the confirmed plan and returns the run log', async () => {
    const plan = makePlan();
    const response = await call({ changeSet: plan.changeSet, confirm: plan.hash });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.run).toMatchObject({ kind: 'pricingkit.applyRun', status: 'completed' });
    expect(body.summary).toMatchObject({ ok: 1 });
    expect(applyOffer).toHaveBeenCalledTimes(1);
  });

  it('refuses a plan whose confirm hash does not match', async () => {
    const plan = makePlan();
    const response = await call({ changeSet: plan.changeSet, confirm: 'ffffffffffffffff' });
    expect(response.status).toBe(409);
    expect(applyOffer).not.toHaveBeenCalled();
    expect((await call({ changeSet: plan.changeSet })).status).toBe(400);
  });

  it('refuses plans for another subscription or app, and ops the web app does not apply', async () => {
    const other = makePlan('456');
    expect((await call({ changeSet: other.changeSet, confirm: other.hash })).status).toBe(400);
    const otherApp = makePlan('123', 'com.example.other');
    expect((await call({ changeSet: otherApp.changeSet, confirm: otherApp.hash })).status).toBe(409);
    const plan = makePlan();
    const op = plan.changeSet.ops[0] as ChangeSet['ops'][number] & { kind: string };
    const deletePlan = { ...plan.changeSet, ops: [{ ...op, kind: 'deleteOffer' }] };
    expect((await call({ changeSet: deletePlan, confirm: plan.hash })).status).toBe(400);
    expect(applyOffer).not.toHaveBeenCalled();
  });
});
