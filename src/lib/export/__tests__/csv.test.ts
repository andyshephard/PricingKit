import { describe, it, expect } from 'vitest';
import {
  buildExportFilename,
  escapeCsvCell,
  priceExportToCsv,
  priceExportToJson,
  PRICE_EXPORT_CSV_COLUMNS,
} from '../csv';
import type { PriceExport } from '../types';

const appleExport: PriceExport = {
  schemaVersion: 1,
  exportedAt: '2026-01-15T10:30:00.000Z',
  platform: 'apple',
  app: { bundleId: 'com.example.app' },
  product: { type: 'subscription', id: 'com.example.app.pro', storeId: '1' },
  prices: [
    { territory: 'DE', currency: 'EUR', amount: '9.99', proceeds: '7.14' },
    { territory: 'FR', currency: 'EUR', amount: null, scheduled: [{ amount: '4.99', startDate: '2026-05-01', proceeds: '3.5' }] },
    {
      territory: 'US',
      currency: 'USD',
      amount: '9.99',
      proceeds: '8.49',
      scheduled: [
        { amount: '12.99', startDate: '2026-03-01', proceeds: '11.04' },
        { amount: '14.99', startDate: '2026-09-01', proceeds: '12.74' },
      ],
    },
  ],
};

const googleExport: PriceExport = {
  schemaVersion: 1,
  exportedAt: '2026-01-15T10:30:00.000Z',
  platform: 'google',
  app: { packageName: 'com.example.app' },
  product: { type: 'subscription', id: 'premium', basePlanId: 'monthly-v2' },
  prices: [{ territory: 'US', currency: 'USD', amount: '9.99', availability: 'AVAILABLE' }],
};

describe('escapeCsvCell', () => {
  it('leaves plain values alone', () => {
    expect(escapeCsvCell('9.99')).toBe('9.99');
    expect(escapeCsvCell('com.example.app')).toBe('com.example.app');
    expect(escapeCsvCell('')).toBe('');
  });

  it('quotes commas, quotes and newlines', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvCell('a\r\nb')).toBe('"a\r\nb"');
  });

  it('quotes leading/trailing whitespace', () => {
    expect(escapeCsvCell(' x')).toBe('" x"');
  });

  it('neutralizes formula injection', () => {
    expect(escapeCsvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('@cmd')).toBe("'@cmd");
    expect(escapeCsvCell('-x')).toBe("'-x");
    expect(escapeCsvCell('=1,2')).toBe(`"'=1,2"`);
  });

  it('keeps negative numbers as numbers', () => {
    expect(escapeCsvCell('-1.5')).toBe('-1.5');
  });
});

describe('priceExportToCsv', () => {
  it('writes a header and one row per territory with CRLF endings', () => {
    const csv = priceExportToCsv(appleExport);
    const lines = csv.split('\r\n');
    expect(lines[lines.length - 1]).toBe('');
    expect(lines[0]).toBe(PRICE_EXPORT_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(1 + appleExport.prices.length + 1);
    expect(lines[1]).toBe(
      '1,2026-01-15T10:30:00.000Z,apple,com.example.app,subscription,com.example.app.pro,,DE,EUR,9.99,7.14,,,,'
    );
  });

  it('writes scheduled prices joined with |', () => {
    const lines = priceExportToCsv(appleExport).split('\r\n');
    expect(lines[2]).toBe(
      '1,2026-01-15T10:30:00.000Z,apple,com.example.app,subscription,com.example.app.pro,,FR,EUR,,,,4.99,2026-05-01,3.5'
    );
    expect(lines[3]).toBe(
      '1,2026-01-15T10:30:00.000Z,apple,com.example.app,subscription,com.example.app.pro,,US,USD,9.99,8.49,,12.99|14.99,2026-03-01|2026-09-01,11.04|12.74'
    );
  });

  it('includes base plan id and availability for Google subscriptions', () => {
    const lines = priceExportToCsv(googleExport).split('\r\n');
    expect(lines[1]).toBe(
      '1,2026-01-15T10:30:00.000Z,google,com.example.app,subscription,premium,monthly-v2,US,USD,9.99,,AVAILABLE,,,'
    );
  });

  it('writes amounts verbatim, never reformatted as floats', () => {
    const csv = priceExportToCsv({
      ...googleExport,
      prices: [{ territory: 'JP', currency: 'JPY', amount: '1500' }, { territory: 'KW', currency: 'KWD', amount: '0.001' }],
    });
    expect(csv).toContain(',JP,JPY,1500,');
    expect(csv).toContain(',KW,KWD,0.001,');
  });

  it('escapes hostile identifiers', () => {
    const csv = priceExportToCsv({ ...googleExport, product: { type: 'inapp', id: 'a,"b"' } });
    expect(csv).toContain(',"a,""b""",');
  });
});

describe('priceExportToJson', () => {
  it('round-trips and keeps amounts as strings', () => {
    const parsed = JSON.parse(priceExportToJson(appleExport));
    expect(parsed).toEqual(appleExport);
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.prices[0].amount).toBe('string');
  });
});

describe('buildExportFilename', () => {
  it('builds a safe, timestamped name', () => {
    expect(buildExportFilename(googleExport, 'csv')).toBe(
      'prices-google-subscription-premium-monthly-v2-20260115T103000Z.csv'
    );
    expect(buildExportFilename(appleExport, 'json')).toBe(
      'prices-apple-subscription-com.example.app.pro-20260115T103000Z.json'
    );
  });

  it('replaces unsafe characters', () => {
    expect(
      buildExportFilename({ ...googleExport, product: { type: 'inapp', id: '../x y"' } }, 'json')
    ).toBe('prices-google-inapp-.._x_y_-20260115T103000Z.json');
  });
});
