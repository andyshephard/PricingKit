import { describe, it, expect } from 'vitest';
import {
  fixedPricesFromCsv,
  offerPricesFromCsv,
  parseCsvRecords,
  parsePricesCsv,
  priceExportToPricesCsv,
  PRICES_CSV_COLUMNS,
  PRICES_CSV_HEADER_LINE,
  PricesCsvError,
  pricesCsvRowsFromOffers,
  pricesCsvRowsFromState,
  serializePricesCsv,
  type ProductPriceState,
  type ProductRef,
  type StoreOffer,
} from '..';

const APP = { bundleId: 'com.example.app' };
const PLAY = { packageName: 'com.example.app' };
const appleSub: ProductRef = { platform: 'apple', type: 'subscription', id: '9700000001' };
const playPlan: ProductRef = { platform: 'google', type: 'subscription', productId: 'com.example.pro', basePlanId: 'annual' };

const csv = (...rows: string[]) => [PRICES_CSV_HEADER_LINE, PRICES_CSV_COLUMNS.join(','), ...rows].join('\n');

function issuesOf(text: string): string[] {
  try {
    parsePricesCsv(text);
  } catch (error) {
    expect(error).toBeInstanceOf(PricesCsvError);
    return (error as PricesCsvError).issues;
  }
  throw new Error('expected the CSV to be refused');
}

const appleState: ProductPriceState = {
  product: appleSub,
  capturedAt: '2030-01-01T00:00:00Z',
  territories: {
    US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '49.99', pricePointId: 'p1', proceeds: '42.49' } },
    GB: { territory: 'GB', currency: 'GBP', current: { currency: 'GBP', amount: '44.99', pricePointId: 'p2' } },
    DE: { territory: 'DE', currency: 'EUR', current: null },
    JP: { territory: 'JP', currency: 'JPY', current: null, problems: { current: 'two prices' } },
  },
};

describe('prices CSV: writing', () => {
  it('writes the format line, the header and one row per priced territory, sorted', () => {
    const { rows, skipped } = pricesCsvRowsFromState(APP, appleState);
    expect(skipped).toEqual([{ territory: 'JP', reason: expect.stringMatching(/two prices/) }]);
    const text = serializePricesCsv(rows);
    expect(text.split('\r\n')).toEqual([
      '# pricingkit.prices v1',
      'app,platform,product,base_plan,offer_kind,offer_key,territory,currency,price,proceeds',
      'com.example.app,apple,9700000001,,,,GB,GBP,44.99,',
      'com.example.app,apple,9700000001,,,,US,USD,49.99,42.49',
      '',
    ]);
  });

  it('round-trips: what it writes parses back to the same prices', () => {
    const text = serializePricesCsv(pricesCsvRowsFromState(APP, appleState).rows);
    const rows = parsePricesCsv(text);
    expect(fixedPricesFromCsv(rows, APP, appleSub)).toEqual({
      prices: { GB: { amount: '44.99', currency: 'GBP' }, US: { amount: '49.99', currency: 'USD' } },
      lines: { GB: 3, US: 4 },
    });
  });

  it('guards cells against spreadsheet formulas', () => {
    const text = serializePricesCsv([{ app: 'com.example.app', platform: 'apple', product: '1', offerKind: 'apple.promo', offerKey: '=HYPERLINK("x")', territory: 'GB', currency: 'GBP', price: '1' }]);
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('exports App Store offers per territory and single-phase Play offers per region, listing what it leaves out', () => {
    const apple: StoreOffer[] = [
      { kind: 'apple.promo', storeId: 's1', key: 'retention', mode: 'PAY_UP_FRONT', duration: 'P1Y', prices: { GB: { currency: 'GBP', amount: '22.99', pricePointId: 'x' }, US: { currency: 'USD', amount: '24.99', proceeds: '21.24' } }, territoryProblems: { JP: 'no price point' } },
      { kind: 'apple.offerCode', storeId: 's2', key: 'broken', mode: null, duration: null, prices: {}, problems: ['unknown mode'] },
    ];
    const out = pricesCsvRowsFromOffers(APP, appleSub, apple);
    expect(out.rows.map((r) => [r.offerKind, r.offerKey, r.territory, r.price])).toEqual([
      ['apple.promo', 'retention', 'GB', '22.99'],
      ['apple.promo', 'retention', 'US', '24.99'],
    ]);
    expect(out.skipped.map((s) => [s.offer, s.territory ?? '-'])).toEqual([
      ['apple.offerCode broken', '-'],
      ['apple.promo retention', 'JP'],
    ]);

    const playOffer = (phases: unknown[]): StoreOffer => ({
      kind: 'play.offer',
      storeId: 'o',
      key: 'half',
      mode: null,
      duration: null,
      prices: {},
      play: { productId: 'com.example.pro', basePlanId: 'annual', offer: { phases } as never },
    });
    const single = pricesCsvRowsFromOffers(PLAY, playPlan, [
      playOffer([{ duration: 'P1Y', recurrenceCount: 1, regions: { US: { type: 'price', currency: 'USD', amount: '29.99' }, GB: { type: 'relativeDiscount', fraction: '0.5' } } }]),
    ]);
    expect(single.rows).toEqual([expect.objectContaining({ platform: 'google', product: 'com.example.pro', basePlan: 'annual', offerKind: 'play.offer', offerKey: 'half', territory: 'US', price: '29.99' })]);
    expect(single.skipped).toEqual([{ offer: 'play.offer half', territory: 'GB', reason: expect.stringMatching(/relativeDiscount/) }]);
    const twoPhases = pricesCsvRowsFromOffers(PLAY, playPlan, [playOffer([{}, {}])]);
    expect(twoPhases.rows).toEqual([]);
    expect(twoPhases.skipped[0].reason).toMatch(/2 phases/);
  });

  it('turns a web export (Phase 0 PriceExport) into the same CSV', () => {
    const text = priceExportToPricesCsv({
      schemaVersion: 1,
      exportedAt: '2030-01-01T00:00:00Z',
      platform: 'apple',
      app: APP,
      product: { type: 'subscription', id: 'com.example.app.annual', storeId: '9700000001' },
      prices: [{ territory: 'GB', currency: 'GBP', amount: '44.99' }],
    });
    expect(text.split('\r\n')[2]).toBe('com.example.app,apple,9700000001,,,,GB,GBP,44.99,');
  });
});

describe('prices CSV: reading', () => {
  it('reads base and offer rows, in any column order, with quoting, CRLF and trailing cells on the format line', () => {
    const text = [
      '# pricingkit.prices v1,,,',
      'territory,price,currency,platform,app,product,base_plan,offer_kind,offer_key',
      'GB,44.99,GBP,apple,com.example.app,9700000001,,,',
      '"US","49.990",USD,apple,com.example.app,9700000001,,apple.promo,"retention, 50%"',
      'GB,49.99,GBP,google,com.example.app,com.example.pro,annual,,',
    ].join('\r\n');
    const rows = parsePricesCsv(text);
    expect(rows).toEqual([
      expect.objectContaining({ line: 3, territory: 'GB', price: '44.99', platform: 'apple' }),
      expect.objectContaining({ line: 4, territory: 'US', price: '49.99', offerKind: 'apple.promo', offerKey: 'retention, 50%' }),
      expect.objectContaining({ line: 5, platform: 'google', basePlan: 'annual' }),
    ]);
    expect(Object.keys(fixedPricesFromCsv(rows, APP, appleSub).prices)).toEqual(['GB']);
    expect(offerPricesFromCsv(rows, APP, appleSub, { kind: 'apple.promo', key: 'retention, 50%' }).prices).toEqual({ US: { amount: '49.99', currency: 'USD' } });
    expect(fixedPricesFromCsv(rows, PLAY, playPlan).prices).toEqual({ GB: { amount: '49.99', currency: 'GBP' } });
    // Rows of another app or store never match
    expect(fixedPricesFromCsv(rows, { bundleId: 'com.other.app' }, appleSub).prices).toEqual({});
    expect(fixedPricesFromCsv(rows, PLAY, { platform: 'google', type: 'subscription', productId: 'com.example.pro', basePlanId: 'monthly' }).prices).toEqual({});
  });

  it('needs the format line and a known version', () => {
    expect(issuesOf('app,platform\n')).toEqual(['line 1: the first line must be "# pricingkit.prices v1"']);
    expect(issuesOf('# pricingkit.prices v2\napp\n')[0]).toMatch(/newer PricingKit/);
    expect(issuesOf('')).toEqual(['the file is empty']);
    expect(issuesOf(PRICES_CSV_HEADER_LINE)).toEqual(['line 2: the column header is missing']);
  });

  it('checks the header: required columns, no unknown or repeated ones (named by position, never by their text)', () => {
    const issues = issuesOf(`${PRICES_CSV_HEADER_LINE}\napp,platform,product,territory,currency,price,price,SECRET-COLUMN-NAME\n`);
    expect(issues).toEqual(['line 2: column "price" appears twice', 'line 2: column 8 is not a pricingkit.prices v1 column (app, platform, product, base_plan, offer_kind, offer_key, territory, currency, price, proceeds)']);
    expect(issuesOf(`${PRICES_CSV_HEADER_LINE}\napp,platform,territory,currency\n`)).toEqual(['line 2: the column "product" is missing', 'line 2: the column "price" is missing']);
  });

  it('reports every bad cell by line and column, never quoting a cell', () => {
    const secret = 'SECRETCELL';
    const text = csv(
      `com.example.app,apple,${secret},,,,GB,GBP,44.99,`,
      `com.example.app,${secret},9700000001,,,,GB,GBP,44.99,`,
      `com.example.app,apple,9700000001,${secret},,,${secret},${secret},-1,${secret}`,
      `com.example.app,google,com.example.pro,,play.offer,,GB,GBP,1,`,
      `com.example.app,apple,9700000001,,play.offer,x,GB,GBP,1,`,
      `com.example.app,apple,9700000001,,,${secret},GB,GBP,1,`,
      `${secret} with spaces,apple,9700000001,,,,GB,GBP,1,`,
      `com.example.app,apple,9700000001,,apple.promo,x,GB,GBP,1.5e3,`,
      `com.example.app,apple,9700000001,,,,GB,GBP,1,,${secret}`
    );
    const issues = issuesOf(text);
    expect(issues.join('\n')).not.toContain(secret);
    expect(issues).toEqual([
      'line 3, column "product": must be the numeric App Store Connect subscription ID',
      'line 4, column "platform": must be apple or google',
      'line 5, column "base_plan": must be empty for an App Store product',
      'line 5, column "territory": must be ISO 3166-1 alpha-2, e.g. GB',
      'line 5, column "currency": must be ISO 4217, e.g. EUR',
      'line 5, column "price": must be a plain non-negative decimal such as 4.99',
      'line 5, column "proceeds": must be empty or a plain decimal',
      'line 6, column "base_plan": a Play offer row needs its base plan',
      'line 6, column "offer_key": an offer row needs the offer key',
      'line 7, column "offer_kind": an App Store row takes an apple.* offer kind',
      'line 8, column "offer_key": a base price row has no offer key (or give offer_kind)',
      'line 9, column "app": must be a bundle ID or package name (letters, digits, ".", "_", "-")',
      'line 10, column "price": must be a plain non-negative decimal such as 4.99',
      'line 11: more cells than the header has columns',
    ]);
  });

  it('refuses the same product and territory twice, naming both lines', () => {
    const issues = issuesOf(csv('com.example.app,apple,9700000001,,,,GB,GBP,44.99,', 'com.example.app,apple,9700000001,,,,US,USD,49.99,', 'com.example.app,apple,9700000001,,,,GB,GBP,45.99,'));
    expect(issues).toEqual(['line 5: the same product and territory as line 3']);
    // The same territory for an offer of that product is a different row
    expect(parsePricesCsv(csv('com.example.app,apple,9700000001,,,,GB,GBP,44.99,', 'com.example.app,apple,9700000001,,apple.promo,r,GB,GBP,22.99,'))).toHaveLength(2);
  });

  it('gives the line of an unterminated quote, counting lines inside quoted fields', () => {
    expect(parseCsvRecords('a,"b\nc",d\ne,f').map((r) => r.line)).toEqual([1, 3]);
    expect(issuesOf(csv('com.example.app,apple,9700000001,,,,GB,GBP,"44.99,'))).toEqual(['line 3: a quoted field is not closed']);
  });

  it('caps the problems listed in the message', () => {
    const rows = Array.from({ length: 60 }, () => 'com.example.app,apple,9700000001,,,,gb,GBP,1,');
    const error = (() => {
      try {
        parsePricesCsv(csv(...rows));
      } catch (e) {
        return e as PricesCsvError;
      }
    })()!;
    expect(error.issues).toHaveLength(60);
    expect(error.message).toMatch(/and 10 more$/);
  });

  it('needs at least one row', () => {
    expect(issuesOf(csv())).toEqual(['the file has no price rows']);
  });
});
