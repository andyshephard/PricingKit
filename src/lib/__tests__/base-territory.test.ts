import { describe, it, expect } from 'vitest';
import { inAppBaseTerritory, pickBasePrice, productBaseKey } from '../base-territory';

describe('per-product base territory (web app)', () => {
  it('keys a remembered base territory by app and product, so products and apps never share one', () => {
    expect(productBaseKey('com.example.app', 'annual')).toBe('com.example.app/annual');
    expect(productBaseKey('com.example.app', 'annual')).not.toBe(productBaseKey('com.example.app', 'monthly'));
    expect(productBaseKey('com.example.app', 'annual')).not.toBe(productBaseKey('com.example.other', 'annual'));
  });

  it("shows a product's base price in its own base territory before the app-wide display default", () => {
    const prices = { US: 'usd', GB: 'gbp', DE: 'eur' };
    expect(pickBasePrice(prices, ['GB', 'US', 'US'])).toEqual({ region: 'GB', price: 'gbp' });
    expect(pickBasePrice(prices, [undefined, 'DE', 'US'])).toEqual({ region: 'DE', price: 'eur' });
    // A remembered territory the product isn't sold in falls through
    expect(pickBasePrice(prices, ['JP', null, 'US'])).toEqual({ region: 'US', price: 'usd' });
    expect(pickBasePrice({ FR: 'eur' }, ['US'])).toEqual({ region: 'FR', price: 'eur' });
    expect(pickBasePrice({}, ['US'])).toBeNull();
    expect(pickBasePrice(undefined, ['US'])).toBeNull();
  });

  it("starts in-app purchase bulk pricing from the product's own schedule base territory, not the app's", () => {
    expect(inAppBaseTerritory('GBR', 'USA')).toBe('GBR');
    expect(inAppBaseTerritory(undefined, 'DEU')).toBe('DEU');
    expect(inAppBaseTerritory(null, null)).toBe('USA');
  });
});
