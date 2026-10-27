import { describe, it, expect } from 'vitest';
import {
  basePriceOps,
  buildChangeSet,
  changeSetHash,
  ChangeSetValidationError,
  diffPrices,
  invertOp,
  parseChangeSet,
  serializeChangeSet,
  type BasePriceOp,
  type ChangeSet,
} from '..';
import { APPLE_APP, GOOGLE_APP, appleState, googleState } from './fixtures/plan-fixtures';

function applePlan(): ChangeSet {
  return buildChangeSet({
    app: APPLE_APP,
    description: 'Raise annual price in GB, schedule DE',
    createdAt: '2030-01-02T03:04:05.000Z',
    products: [
      {
        state: appleState(),
        targets: {
          US: { currency: 'USD', amount: '29.99', pricePointId: 'pp-us-2999' },
          GB: { currency: 'GBP', amount: '26.99', pricePointId: 'pp-gb-2699', note: 'target 27.10, snapped' },
          DE: { currency: 'EUR', amount: '31.99', pricePointId: 'pp-de-3199', startDate: '2030-07-01' },
        },
      },
    ],
  });
}

describe('diffPrices', () => {
  it('produces ops only for territories that change, and says why the rest were skipped', () => {
    const plan = applePlan();
    expect(basePriceOps(plan).map((op) => [op.id, op.kind, op.target.territory])).toEqual([
      ['op-0001', 'schedulePrice', 'DE'],
      ['op-0002', 'setPrice', 'GB'],
    ]);
    expect(plan.skipped).toEqual([
      { product: appleState().product, territory: 'US', reason: 'ALREADY_AT_TARGET' },
    ]);
    const gb = basePriceOps(plan)[1];
    expect(gb.before).toEqual({ currency: 'GBP', amount: '24.99', pricePointId: 'pp-gb-2499' });
    expect(gb.after).toEqual({ currency: 'GBP', amount: '26.99', pricePointId: 'pp-gb-2699' });
    expect(gb.options).toEqual({ preserveCurrentPrice: true });
    expect(gb.note).toBe('target 27.10, snapped');
    // The scheduled op records the scheduled price it replaces
    expect(plan.ops[0].before).toMatchObject({ pricePointId: 'pp-de-2999', startDate: '2030-06-01' });
  });

  it('never launches a territory without a current price unless asked', () => {
    const result = diffPrices(googleState(), { FR: { currency: 'EUR', amount: '27.99' } });
    expect(result.ops).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ territory: 'FR', reason: 'NOT_CONFIGURED' });
    const allowed = diffPrices(googleState(), { FR: { currency: 'EUR', amount: '27.99' } }, { allowNewTerritories: true });
    expect(allowed.ops[0]).toMatchObject({ kind: 'setPrice', before: null });
  });

  it('compares Google prices by exact decimal value', () => {
    const result = diffPrices(googleState(), {
      US: { currency: 'USD', amount: '29.990' },
      JP: { currency: 'JPY', amount: '4200' },
    });
    expect(result.ops.map((op) => op.target.territory)).toEqual(['JP']);
    expect(result.skipped.map((s) => [s.territory, s.reason])).toEqual([['US', 'ALREADY_AT_TARGET']]);
  });

  it('refuses unresolved Apple targets, wrong currencies and bad amounts', () => {
    const result = diffPrices(appleState(), {
      US: { currency: 'USD', amount: '19.99' },
      GB: { currency: 'EUR', amount: '19.99', pricePointId: 'x' },
      DE: { currency: 'EUR', amount: '1e3', pricePointId: 'y' },
    });
    expect(result.ops).toEqual([]);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(['CURRENCY_MISMATCH', 'INVALID_TARGET', 'UNRESOLVED_PRICE_POINT']);
  });
});

describe('dates, ambiguity and reviewer warnings', () => {
  it('takes start dates as YYYY-MM-DD, normalising timestamps and refusing anything else', () => {
    const ok = diffPrices(appleState(), { GB: { currency: 'GBP', amount: '26.99', pricePointId: 'p', startDate: '2030-09-01T00:00:00Z' } });
    expect(ok.ops[0].after?.startDate).toBe('2030-09-01');
    const bad = diffPrices(appleState(), { GB: { currency: 'GBP', amount: '26.99', pricePointId: 'p', startDate: 'next week' } });
    expect(bad.skipped[0]).toMatchObject({ reason: 'INVALID_TARGET' });

    const file = JSON.parse(serializeChangeSet(applePlan()));
    file.ops[0].after.startDate = '2030-07-01T00:00:00Z';
    expect(() => parseChangeSet(file)).toThrow(/YYYY-MM-DD/);
  });

  it('compares scheduled prices by date, whatever the timestamp form', () => {
    const state = appleState();
    state.territories.DE.scheduled!.startDate = '2030-06-01T00:00:00.000Z';
    const result = diffPrices(state, { DE: { currency: 'EUR', amount: '29.99', pricePointId: 'pp-de-2999', startDate: '2030-06-01' } });
    expect(result.skipped[0]).toMatchObject({ reason: 'ALREADY_AT_TARGET' });
  });

  it('refuses to plan against a slot the adapter could not read', () => {
    const state = appleState();
    state.territories.DE.problems = { scheduled: '2 future prices' };
    const result = diffPrices(state, {
      DE: { currency: 'EUR', amount: '31.99', pricePointId: 'x', startDate: '2030-07-01' },
    });
    expect(result.ops).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: 'AMBIGUOUS_STATE', detail: expect.stringMatching(/2 future prices/) });
  });

  it('flags an immediate change in a territory that has a scheduled price', () => {
    const plan = buildChangeSet({
      app: APPLE_APP,
      products: [{ state: appleState(), targets: { DE: { currency: 'EUR', amount: '19.99', pricePointId: 'pp-de-1999' } } }],
    });
    expect(plan.warnings).toEqual([{ opId: 'op-0001', message: expect.stringMatching(/scheduled price \(29\.99 EUR .*from 2030-06-01\).*still takes effect/) }]);
    expect(parseChangeSet(serializeChangeSet(plan)).warnings).toEqual(plan.warnings);
  });
});

describe('ChangeSet files', () => {
  it('round-trips through JSON and keeps its hash', () => {
    const plan = applePlan();
    const text = serializeChangeSet(plan);
    expect(text.endsWith('\n')).toBe(true);
    const parsed = parseChangeSet(text);
    expect(parsed).toEqual(plan);
    expect(changeSetHash(parsed)).toBe(changeSetHash(plan));
    expect(plan.id).toMatch(/^cs-20300102030405-[0-9a-f]{8}$/);
  });

  it('gives the same change the same idempotency key', () => {
    const a = applePlan();
    const b = applePlan();
    expect(a.ops.map((op) => op.idempotencyKey)).toEqual(b.ops.map((op) => op.idempotencyKey));
    expect(a.ops[1].idempotencyKey).toBe('setPrice|apple:subscription:9000000001|GB|GBP 26.99 pp-gb-2699 ');
  });

  it('hash ignores description and ids but not ops', () => {
    const plan = applePlan();
    expect(changeSetHash({ ...plan, description: 'x', id: 'other' } as ChangeSet)).toBe(changeSetHash(plan));
    const edited = { ...plan, ops: [plan.ops[0]] };
    expect(changeSetHash(edited)).not.toBe(changeSetHash(plan));
  });

  it('normalises amounts on parse and rejects floats', () => {
    const plan = JSON.parse(serializeChangeSet(applePlan()));
    plan.ops[1].after.amount = '26.990';
    expect(basePriceOps(parseChangeSet(plan))[1].after?.amount).toBe('26.99');
    plan.ops[1].after.amount = 26.99;
    expect(() => parseChangeSet(plan)).toThrow(ChangeSetValidationError);
  });

  it('rejects a hand edit that breaks the rules', () => {
    const plan = JSON.parse(serializeChangeSet(applePlan()));
    plan.ops[1].after.amount = '99.99'; // key no longer matches
    expect(() => parseChangeSet(plan)).toThrow(/idempotencyKey doesn't match/);

    const twoOnOneSlot = JSON.parse(serializeChangeSet(applePlan()));
    twoOnOneSlot.ops.push({ ...twoOnOneSlot.ops[1], id: 'op-0003' });
    expect(() => parseChangeSet(twoOnOneSlot)).toThrow(/another op already changes GB current price/);

    const missingPoint = JSON.parse(serializeChangeSet(applePlan()));
    delete missingPoint.ops[1].after.pricePointId;
    expect(() => parseChangeSet(missingPoint)).toThrow(/must name a price point/);

    const wrongApp = { ...JSON.parse(serializeChangeSet(applePlan())), app: GOOGLE_APP };
    expect(() => parseChangeSet(wrongApp)).toThrow(/apple op in a change set for a google app/);
  });

  it('reserves availability and cohort kinds without accepting them yet', () => {
    const plan = JSON.parse(serializeChangeSet(applePlan()));
    plan.ops[0].kind = 'setAvailability';
    expect(() => parseChangeSet(plan)).toThrow(/reserved for a later phase/);
  });

  it('validates an offer kind against the offer op shape', () => {
    const plan = JSON.parse(serializeChangeSet(applePlan()));
    plan.ops[0].kind = 'createOffer';
    expect(() => parseChangeSet(plan)).toThrow(/ops\.0\.target\.offer/);
  });

  it('never quotes malformed input back (plan, state and run files)', async () => {
    const { parseRun, parseStateSnapshot } = await import('@/lib/pricing');
    const input = 'SECRET_VALUE=do-not-echo-this-text';
    for (const parse of [parseChangeSet, parseStateSnapshot, parseRun]) {
      let message = '';
      try {
        parse(input);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/not valid JSON$/);
      expect(message).not.toContain('do-not-echo');
      expect(message).not.toContain('SECRET_VALUE');
    }
  });

  it('rejects unknown fields and malformed JSON', () => {
    expect(() => parseChangeSet('{nope')).toThrow(/not valid JSON/);
    const plan = JSON.parse(serializeChangeSet(applePlan()));
    plan.surprise = true;
    expect(() => parseChangeSet(plan)).toThrow(ChangeSetValidationError);
  });
});

describe('invertOp', () => {
  const plan = applePlan();
  const [scheduleDE, setGB] = basePriceOps(plan);

  it('swaps before and after for a price change', () => {
    const result = invertOp(setGB);
    expect('op' in result && result.op).toMatchObject({ kind: 'setPrice', before: setGB.after, after: setGB.before, note: 'undo of op-0002' });
  });

  it('restores a replaced scheduled price, or deletes a new one', () => {
    expect('op' in invertOp(scheduleDE) && (invertOp(scheduleDE) as { op: BasePriceOp }).op).toMatchObject({
      kind: 'schedulePrice',
      after: scheduleDE.before,
    });
    const fresh: BasePriceOp = { ...scheduleDE, before: null };
    expect((invertOp(fresh) as { op: BasePriceOp }).op).toMatchObject({ kind: 'deleteScheduled', before: scheduleDE.after, after: null });
  });

  it('removes a Google region it added, but cannot remove an Apple current price', () => {
    const google = diffPrices(googleState(), { FR: { currency: 'EUR', amount: '27.99' } }, { allowNewTerritories: true }).ops[0];
    expect((invertOp({ id: 'op-0001', ...google }) as { op: BasePriceOp }).op).toMatchObject({ kind: 'removePrice', after: null });
    const apple: BasePriceOp = { ...setGB, before: null };
    expect(invertOp(apple)).toMatchObject({ notReversible: expect.stringMatching(/can't remove the current price/) });
  });

  it('round-trips: inverting twice gives the original change', () => {
    const once = (invertOp(setGB) as { op: BasePriceOp }).op;
    const twice = (invertOp({ ...once, id: 'x' }) as { op: BasePriceOp }).op;
    expect([twice.kind, twice.before, twice.after, twice.idempotencyKey]).toEqual([setGB.kind, setGB.before, setGB.after, setGB.idempotencyKey]);
  });
});
