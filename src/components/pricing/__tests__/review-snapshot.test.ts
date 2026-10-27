import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isReviewStale, selectedRegionPrices, selectedTierTargets, takeReviewSnapshot } from '../review-snapshot';

const money = (currencyCode: string, units: string, nanos = 0) => ({ currencyCode, units, nanos });

describe('review snapshot', () => {
  it('sends what the review showed even when the live preview changes afterwards', () => {
    const preview = [
      { regionCode: 'US', price: money('USD', '9', 990000000) },
      { regionCode: 'GB', price: money('GBP', '8', 990000000) },
    ];
    const snapshot = takeReviewSnapshot(selectedRegionPrices(preview, new Set(['US', 'GB'])));

    // A late exchange-rate fetch recalculates GB in place
    preview[1].price.units = '7';
    preview[1].price.nanos = 490000000;

    expect(snapshot.prices.GB).toEqual(money('GBP', '8', 990000000));
    expect(snapshot.regions).toEqual(['GB', 'US']);
    expect(isReviewStale(snapshot, selectedRegionPrices(preview, new Set(['US', 'GB'])))).toBe(true);
  });

  it('is stale when a region is added or dropped, or a frozen option changes; not when nothing changed', () => {
    const live = { US: money('USD', '9', 990000000), GB: money('GBP', '8', 990000000) };
    const snapshot = takeReviewSnapshot(live, { startDate: '2030-06-01' as string | null });
    expect(isReviewStale(snapshot, { GB: live.GB, US: live.US }, { startDate: '2030-06-01' })).toBe(false);
    expect(isReviewStale(snapshot, { ...live, DE: money('EUR', '9', 990000000) }, { startDate: '2030-06-01' })).toBe(true);
    expect(isReviewStale(snapshot, { US: live.US }, { startDate: '2030-06-01' })).toBe(true);
    expect(isReviewStale(snapshot, live, { startDate: null })).toBe(true);
    expect(isReviewStale(null, live)).toBe(false);
  });

  it('is frozen: the snapshot itself cannot be changed', () => {
    const snapshot = takeReviewSnapshot({ US: money('USD', '1') });
    expect(() => {
      (snapshot.prices as Record<string, unknown>).GB = money('GBP', '1');
    }).toThrow();
  });

  it('selected regions: never a flagged price; the App Store base territory always', () => {
    const preview = [
      { regionCode: 'US', price: money('USD', '10') },
      { regionCode: 'GB', price: money('GBP', '0'), error: 'MISSING_EXCHANGE_RATE' },
      { regionCode: 'DE', price: money('EUR', '9') },
      { regionCode: 'FR', price: money('EUR', '9') },
    ];
    expect(Object.keys(selectedRegionPrices(preview, new Set(['GB', 'DE'])))).toEqual(['DE']);
    expect(Object.keys(selectedRegionPrices(preview, new Set(['DE']), 'US')).sort()).toEqual(['DE', 'US']);
  });

  it('App Store tier targets: selected territories with a tier and no error only', () => {
    const preview = [
      { territoryCode: 'US', tierPrice: 9.99, currency: 'USD', tier: { id: 't1' } },
      { territoryCode: 'GB', tierPrice: 0, currency: 'GBP', error: 'MISSING_EXCHANGE_RATE' },
      { territoryCode: 'DE', tierPrice: 9.99, currency: 'EUR', noTierData: true },
      { territoryCode: 'FR', tierPrice: 8.99, currency: 'EUR', tier: { id: 't2' } },
    ];
    expect(selectedTierTargets(preview, new Set(['US', 'GB', 'DE']))).toEqual({ US: { targetPrice: 9.99, currency: 'USD' } });
  });
});

describe('bulk pricing dialogs apply the snapshot', () => {
  const files = [
    'products/bulk-pricing-modal.tsx',
    'subscriptions/bulk-pricing-modal.tsx',
    'subscriptions/apple-subscription-bulk-pricing-modal.tsx',
  ];
  it.each(files)('%s: executeApply sends only the review snapshot, and a stale review cannot apply', (file) => {
    const source = readFileSync(join(__dirname, '../..', file), 'utf8');
    const start = source.indexOf('const executeApply = async () => {');
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf('\n  };\n', start);
    const body = source.slice(start, end);
    expect(body).toMatch(/updateSummary\.snapshot|const \{ snapshot \} = updateSummary/);
    expect(body).toMatch(/if \(!updateSummary \|\| reviewStale\)/);
    // Never rebuilt from the live preview or selection
    expect(body).not.toMatch(/previewPrices|selectedRegions|filterApplicablePrices/);
    expect(source).toContain('applyDisabled={reviewStale}');
  });
});
