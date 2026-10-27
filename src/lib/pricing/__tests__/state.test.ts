import { describe, it, expect } from 'vitest';
import { createStateSnapshot, parseStateSnapshot, serializeStateSnapshot, StateValidationError } from '../state';
import type { PriceExport } from '@/lib/export/types';
import { APPLE_APP, appleState } from './fixtures/plan-fixtures';

describe('price state snapshots', () => {
  it('round-trips through JSON', () => {
    const snapshot = createStateSnapshot(APPLE_APP, [appleState()], '2030-01-01T00:00:00.000Z');
    expect(parseStateSnapshot(serializeStateSnapshot(snapshot))).toEqual(snapshot);
  });

  it('imports a Phase 0 price export', () => {
    const exp: PriceExport = {
      schemaVersion: 1,
      exportedAt: '2030-01-01T00:00:00.000Z',
      platform: 'apple',
      app: { bundleId: 'com.example.app' },
      product: { type: 'subscription', id: 'com.example.app.pro.annual', storeId: '9000000001' },
      prices: [
        { territory: 'DE', currency: 'EUR', amount: '27.99', proceeds: '19.8', scheduled: [{ amount: '29.99', startDate: '2030-06-01' }] },
        { territory: 'FR', currency: 'EUR', amount: null, scheduled: [{ amount: '29.99', startDate: '2030-06-01' }] },
      ],
    };
    const snapshot = parseStateSnapshot(JSON.stringify(exp));
    expect(snapshot.app).toEqual({ bundleId: 'com.example.app' });
    const [product] = snapshot.products;
    expect(product.product).toEqual({ platform: 'apple', type: 'subscription', id: '9000000001', productId: 'com.example.app.pro.annual' });
    expect(product.territories.DE).toEqual({
      territory: 'DE',
      currency: 'EUR',
      current: { currency: 'EUR', amount: '27.99', proceeds: '19.8' },
      scheduled: { currency: 'EUR', amount: '29.99', startDate: '2030-06-01' },
    });
    expect(product.territories.FR.current).toBeNull();
  });

  it('imports several Google exports for one app and refuses mixed apps', () => {
    const base = {
      schemaVersion: 1 as const,
      exportedAt: '2030-01-01T00:00:00.000Z',
      platform: 'google' as const,
      app: { packageName: 'com.example.app' },
      prices: [{ territory: 'GB', currency: 'GBP', amount: '24.99', availability: 'AVAILABLE' }],
    };
    const snapshot = parseStateSnapshot([
      { ...base, product: { type: 'subscription', id: 'pro', basePlanId: 'annual' } },
      { ...base, product: { type: 'inapp', id: 'coins', purchaseOptionId: 'default' } },
    ]);
    expect(snapshot.products.map((p) => p.product)).toEqual([
      { platform: 'google', type: 'subscription', productId: 'pro', basePlanId: 'annual' },
      { platform: 'google', type: 'inapp', productId: 'coins', purchaseOptionId: 'default' },
    ]);
    expect(() =>
      parseStateSnapshot([
        { ...base, product: { type: 'inapp', id: 'a' } },
        { ...base, app: { packageName: 'com.example.other' }, product: { type: 'inapp', id: 'b' } },
      ])
    ).toThrow(StateValidationError);
  });

  it('rejects malformed snapshots', () => {
    const snapshot = JSON.parse(serializeStateSnapshot(createStateSnapshot(APPLE_APP, [appleState()])));
    snapshot.products[0].territories.US.current.amount = 29.99;
    expect(() => parseStateSnapshot(snapshot)).toThrow(StateValidationError);
  });
});
