import { describe, expect, it } from 'vitest';
import {
  findPreferredTierIndex,
  findSmartTierForCurrency,
} from '../price-tier-selection';

describe('findPreferredTierIndex', () => {
  it('17.9955 -> 17.99', () => {
    const prices = [17.49, 17.99, 18, 18.49];
    expect(findPreferredTierIndex(prices, 17.9955, 'USD')).toBe(1);
  });

  it('18.00 -> 17.99', () => {
    const prices = [17.99, 18, 18.49];
    expect(findPreferredTierIndex(prices, 18, 'USD')).toBe(0);
  });

  it('31.20 -> 31.19', () => {
    const prices = [31.19, 31.20, 31.49];
    expect(findPreferredTierIndex(prices, 31.20, 'USD')).toBe(0);
  });

  it('31.50 -> 31.49', () => {
    const prices = [31.49, 31.50, 31.90];
    expect(findPreferredTierIndex(prices, 31.50, 'USD')).toBe(0);
  });

  it('31.80 -> 31.79', () => {
    const prices = [31.79, 31.80, 31.90];
    expect(findPreferredTierIndex(prices, 31.80, 'USD')).toBe(0);
  });

  it('31.90 -> 31.99', () => {
    const prices = [31.89, 31.90, 31.99, 32];
    expect(findPreferredTierIndex(prices, 31.90, 'USD')).toBe(2);
  });

  it('31.95 -> 31.99', () => {
    const prices = [31.90, 31.95, 31.99, 32];
    expect(findPreferredTierIndex(prices, 31.95, 'USD')).toBe(2);
  });

  it('keeps an existing .99 ending', () => {
    const prices = [31.90, 31.99, 32];
    expect(findPreferredTierIndex(prices, 31.99, 'USD')).toBe(1);
  });

  it('keeps an existing .49 ending', () => {
    const prices = [31.49, 31.50, 31.99];
    expect(findPreferredTierIndex(prices, 31.49, 'USD')).toBe(0);
  });

  it('does not apply Western charm rules to CHF', () => {
    const prices = [31.19, 31.20, 31.49];
    expect(findPreferredTierIndex(prices, 31.20, 'CHF')).toBe(1);
  });

  it('does not move beyond the 1 percent guardrail', () => {
    const prices = [0.89, 0.90, 0.99];
    expect(findPreferredTierIndex(prices, 0.90, 'USD')).toBe(1);
  });

  it('returns null for empty prices', () => {
    expect(findPreferredTierIndex([], 18, 'USD')).toBeNull();
  });
});

describe('findSmartTierForCurrency', () => {
  it('returns a valid USD Apple tier', () => {
    const result = findSmartTierForCurrency(17.9955, 'USD');

    expect(result).not.toBeNull();
    expect(result!.price).toBeGreaterThan(0);
    expect(result!.tier.length).toBeGreaterThan(0);
  });

  it('returns null for unsupported currency', () => {
    expect(findSmartTierForCurrency(10, 'XYZ')).toBeNull();
  });
});
