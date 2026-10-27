// Regenerating the static tier table: pure build logic with an injected
// source (no network, no credentials). The script that wires it to the live
// API is scripts/fetch-apple-price-tiers.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPriceTierData, decodePricePointTier, serializeTierData, TierBuildError, updateTierModuleDate, type TierBuildSource } from '../price-tier-build';

const id = (territory: string, tier: string | number) => Buffer.from(JSON.stringify({ s: '6400000000', t: territory, p: tier })).toString('base64');

function source(points: Record<string, Array<[string, string]>>, territories = [
  { id: 'USA', currency: 'USD' },
  { id: 'AUT', currency: 'EUR' },
  { id: 'DEU', currency: 'EUR' },
  { id: 'JPN', currency: 'JPY' },
]): TierBuildSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    listTerritories: async () => territories,
    listPricePoints: async (territory) => {
      reads.push(territory);
      return (points[territory] ?? []).map(([price, tier]) => ({ id: id(territory, tier), customerPrice: price }));
    },
  };
}

const LADDERS: Record<string, Array<[string, string]>> = {
  USA: [['0.99', '10010'], ['0.29', '10001'], ['1.99', '10023']],
  AUT: [['0.99', '10010'], ['0.29', '10001']],
  DEU: [['1.09', '10010'], ['0.39', '10001']],
  JPN: [['160', '10010'], ['50', '10001']],
};

describe('price tier regeneration', () => {
  it('decodes the tier of an Apple price point ID, and nothing else', () => {
    expect(decodePricePointTier(id('USA', '10010'))).toBe('10010');
    expect(decodePricePointTier(id('USA', 10010))).toBe('10010');
    expect(decodePricePointTier(id('USA', 'abc'))).toBeUndefined();
    expect(decodePricePointTier('not-base64-json')).toBeUndefined();
  });

  it('builds one sorted ladder per currency from the first territory, or the preferred one', async () => {
    const s = source(LADDERS);
    const { data, territories } = await buildPriceTierData(s);
    expect(data).toEqual({
      USD: [[0.29, '10001'], [0.99, '10010'], [1.99, '10023']],
      EUR: [[0.29, '10001'], [0.99, '10010']],
      JPY: [[50, '10001'], [160, '10010']],
    });
    expect(territories).toEqual({ USD: 'USA', EUR: 'AUT', JPY: 'JPN' });
    expect(s.reads.sort()).toEqual(['AUT', 'JPN', 'USA']);

    const preferred = await buildPriceTierData(source(LADDERS), { prefer: { EUR: 'DEU' } });
    expect(preferred.data.EUR).toEqual([[0.39, '10001'], [1.09, '10010']]);
    // The committed file format: compact JSON, [price, tier] tuples
    expect(serializeTierData(preferred.data)).toBe('{"USD":[[0.29,"10001"],[0.99,"10010"],[1.99,"10023"]],"EUR":[[0.39,"10001"],[1.09,"10010"]],"JPY":[[50,"10001"],[160,"10010"]]}');
  });

  it('builds nothing when an ID does not decode, a currency has no prices, or a preference is wrong', async () => {
    const bad = source({ ...LADDERS, JPN: [] });
    await expect(buildPriceTierData(bad)).rejects.toThrow(/JPN \(JPY\): no price points/);
    const undecodable: TierBuildSource = { ...source(LADDERS), listPricePoints: async () => [{ id: 'opaque', customerPrice: '1.00' }] };
    await expect(buildPriceTierData(undecodable)).rejects.toBeInstanceOf(TierBuildError);
    await expect(buildPriceTierData(source(LADDERS), { prefer: { EUR: 'USA' } })).rejects.toThrow(/USA bills in USD/);
    await expect(buildPriceTierData(source(LADDERS), { prefer: { EUR: 'XXX' } })).rejects.toThrow(/no such territory/);
  });

  it('updates the generated date in price-tier-data.ts and price-tier-meta.ts', () => {
    const when = new Date('2031-04-05T06:07:08.000Z');
    expect(updateTierModuleDate(readFileSync(join(__dirname, '../price-tier-data.ts'), 'utf8'), when)).toContain('// Generated: 2031-04-05T06:07:08.000Z');
    expect(updateTierModuleDate(readFileSync(join(__dirname, '../price-tier-meta.ts'), 'utf8'), when)).toContain("export const PRICE_TIER_DATA_GENERATED_AT = '2031-04-05';");
    expect(() => updateTierModuleDate('nothing here', new Date())).toThrow(TierBuildError);
  });

  it('the committed table has the shape the build writes', () => {
    const data = JSON.parse(readFileSync(join(__dirname, '../price-tier-data.json'), 'utf8')) as Record<string, Array<[number, string]>>;
    for (const rows of Object.values(data)) {
      for (const [price, tier] of rows) {
        expect(typeof price).toBe('number');
        expect(tier).toMatch(/^\d+$/);
      }
    }
  });
});
