import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials } from '@/lib/apple-connect/types';

const appleApiRequest = vi.fn();
vi.mock('@/lib/apple-connect/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apple-connect/client')>();
  return {
    ...actual,
    appleApiRequest: (...args: unknown[]) => appleApiRequest(...args),
    getAppIdForBundleId: vi.fn(async () => {
      throw new Error('not expected');
    }),
  };
});

import { AppleAdapter } from '../apple';
import { FakeAppleServer, SUB_ID } from './fake-apple';
import {
  basePriceOps,
  applyChangeSet,
  buildChangeSet,
  buildUndoChangeSet,
  parseChangeSet,
  serializeChangeSet,
  type ProductPriceState,
  type ProductRef,
} from '@/lib/pricing';
import { RequestBudget } from '@/lib/utils/request-budget';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.app',
};
const product: ProductRef = { platform: 'apple', type: 'subscription', id: SUB_ID, productId: 'com.example.app.pro.annual' };
const app = { bundleId: 'com.example.app' };

let server: FakeAppleServer;
beforeEach(() => {
  server = new FakeAppleServer();
  server.seed('US', '29.99');
  server.seed('GB', '24.99');
  server.seed('DE', '27.99');
  server.seed('DE', '29.99', '2099-06-01');
  appleApiRequest.mockReset();
  appleApiRequest.mockImplementation(server.handle);
});

/** Prices only: drop capture time and Apple's internal price IDs */
function prices(state: ProductPriceState) {
  return Object.fromEntries(
    Object.entries(state.territories).map(([k, t]) => [k, { current: t.current, scheduled: t.scheduled ?? null }])
  );
}

describe('AppleAdapter.fetchState', () => {
  it('reads current and scheduled prices by alpha-2 territory, as decimals', async () => {
    const state = await new AppleAdapter({ credentials }).fetchState(product);
    expect(state.territories.GB.current).toMatchObject({ currency: 'GBP', amount: '24.99', pricePointId: server.point('GB', '24.99') });
    expect(state.territories.DE.scheduled).toMatchObject({ currency: 'EUR', amount: '29.99', startDate: '2099-06-01' });
    expect(state.territories.DE.refs?.scheduledPriceId).toBeTruthy();
    expect(state.territories.US.scheduled).toBeUndefined();
  });

  it('refuses in-app purchases for now', async () => {
    await expect(new AppleAdapter({ credentials }).fetchState({ platform: 'apple', type: 'inapp', id: '1' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });
});

describe('AppleAdapter.fetchState when the store is ambiguous', () => {
  it('reports two future prices in a territory instead of picking one', async () => {
    server.seed('DE', '31.99', '2099-09-01');
    const state = await new AppleAdapter({ credentials }).fetchState(product);
    expect(state.territories.DE.scheduled).toBeUndefined();
    expect(state.territories.DE.problems?.scheduled).toMatch(/2 future prices/);
    expect(state.territories.DE.current?.amount).toBe('27.99');
    expect(state.warnings?.some((w) => w.startsWith('DE scheduled'))).toBe(true);
  });

  it('skips a price without its price point relationship instead of guessing', async () => {
    const gb = server.prices.find((p) => p.alpha2 === 'GB')!;
    server.dropPointRelationship.add(gb.id);
    const adapter = new AppleAdapter({ credentials });
    const state = await adapter.fetchState(product);
    expect(state.territories.GB.current).toBeNull();
    expect(state.territories.GB.problems?.current).toMatch(/has no price point/);
    expect(state.territories.GB.currency).toBe('GBP'); // from Apple, never a USD default
  });
});

describe('AppleAdapter.resolvePricePoints', () => {
  it("snaps each territory to its own live price points, reading several ladders per request", async () => {
    const adapter = new AppleAdapter({ credentials });
    const result = await adapter.resolvePricePoints(product, {
      US: { currency: 'USD', amount: '26.10' },
      GB: { currency: 'GBP', amount: '26.10' },
      DE: { currency: 'EUR', amount: '30.80' },
    });
    expect(result.resolved.US).toMatchObject({ amount: '24.99', pricePointId: server.point('US', '24.99'), target: '26.1', deviation: '-1.11' });
    expect(result.resolved.GB).toMatchObject({ amount: '26.99', deviationRatio: '0.0341' });
    expect(result.resolved.DE).toMatchObject({ amount: '29.99' }); // 0.81 below beats 1.19 above
    const ladderCalls = server.calls.filter((c) => c.endpoint.endsWith('/pricePoints'));
    expect(ladderCalls).toHaveLength(1);
    expect(ladderCalls[0].options.queryParams).toMatchObject({
      'filter[territory]': 'USA,GBR,DEU',
      include: 'territory',
      limit: '8000',
    });
  });

  it('proceeds targets snap on each price point\'s proceeds and report the customer price', async () => {
    // The fake's proceeds are 70% of the customer price: 24.99 -> 17.49, 29.99 -> 20.99
    const result = await new AppleAdapter({ credentials }).resolvePricePoints(product, { US: { currency: 'USD', amount: '17.5' } }, { measure: 'proceeds' });
    expect(result.resolved.US).toMatchObject({ amount: '24.99', proceeds: '17.49', measure: 'proceeds', target: '17.5', deviation: '-0.01', pricePointId: server.point('US', '24.99') });
    const ceil = await new AppleAdapter({ credentials }).resolvePricePoints(product, { US: { currency: 'USD', amount: '17.5' } }, { measure: 'proceeds', mode: 'ceil' });
    expect(Number(ceil.resolved.US.proceeds)).toBeGreaterThanOrEqual(17.5);
  });

  it('supports floor and reports what it cannot resolve', async () => {
    const result = await new AppleAdapter({ credentials }).resolvePricePoints(
      product,
      { US: { currency: 'USD', amount: '26.10' }, GB: { currency: 'EUR', amount: '20' }, XX: { currency: 'USD', amount: '1' } },
      { mode: 'floor' }
    );
    expect(result.resolved.US.amount).toBe('24.99');
    expect(result.unresolved.GB).toMatch(/priced in GBP/);
    expect(result.unresolved.XX).toMatch(/Unknown Apple territory/);
  });
});

async function plan(targets: Record<string, { currency: string; amount: string; startDate?: string }>) {
  const adapter = new AppleAdapter({ credentials });
  const state = await adapter.fetchState(product);
  const resolved = await adapter.resolvePricePoints(product, targets);
  const snapped = Object.fromEntries(
    Object.entries(resolved.resolved).map(([t, r]) => [t, { ...r, ...(targets[t].startDate ? { startDate: targets[t].startDate } : {}) }])
  );
  return parseChangeSet(serializeChangeSet(buildChangeSet({ app, products: [{ state, targets: snapped }] })));
}

describe('AppleAdapter with the executor', () => {
  it('plans, applies, re-applies with no writes, and undoes back to the original prices', async () => {
    const adapter = new AppleAdapter({ credentials });
    const original = prices(await adapter.fetchState(product));

    const changeSet = await plan({
      US: { currency: 'USD', amount: '24.99' },
      GB: { currency: 'GBP', amount: '26.99' },
      DE: { currency: 'EUR', amount: '31.99', startDate: '2099-07-01' },
    });
    expect(basePriceOps(changeSet).map((op) => `${op.kind} ${op.target.territory}`)).toEqual(['schedulePrice DE', 'setPrice GB', 'setPrice US']);

    const run = await applyChangeSet(changeSet, { adapter });
    expect(run.status).toBe('completed');
    const applied = prices(await adapter.fetchState(product));
    expect(applied.GB.current?.amount).toBe('26.99');
    expect(applied.DE.scheduled).toMatchObject({ amount: '31.99', startDate: '2099-07-01' });

    const writes = server.writes().length;
    const again = await applyChangeSet(changeSet, { adapter });
    expect(server.writes().length).toBe(writes);
    expect(again.ops.every((r) => r.status === 'skipped')).toBe(true);

    const undo = buildUndoChangeSet(changeSet, run);
    const undone = await applyChangeSet(undo, { adapter });
    expect(undone.status).toBe('completed');
    expect(prices(await adapter.fetchState(product))).toEqual(original);
  });

  it('creates a replacement scheduled price before deleting the old one', async () => {
    const adapter = new AppleAdapter({ credentials });
    const changeSet = await plan({ DE: { currency: 'EUR', amount: '31.99', startDate: '2099-07-01' } });
    server.calls = [];
    await applyChangeSet(changeSet, { adapter });
    const writes = server.writes();
    expect(writes[0]).toBe('POST /subscriptionPrices');
    expect(writes[1]).toMatch(/^DELETE \/subscriptionPrices\//);
  });

  it('never deletes the old scheduled price when the replacement is refused', async () => {
    const adapter = new AppleAdapter({ credentials });
    const changeSet = await plan({ DE: { currency: 'EUR', amount: '31.99', startDate: '2099-07-01' } });
    server.failCreate.set('DEU', 409);
    server.calls = [];
    const run = await applyChangeSet(changeSet, { adapter });
    expect(run.ops[0]).toMatchObject({ status: 'failed', error: { status: 409 } });
    expect(server.writes()).toEqual(['POST /subscriptionPrices']);
    const state = await adapter.fetchState(product);
    expect(state.territories.DE.scheduled).toMatchObject({ amount: '29.99', startDate: '2099-06-01' });
  });

  it('charges every request to the run budget and stops when it is spent', async () => {
    const budget = new RequestBudget({ limit: 6 });
    const adapter = new AppleAdapter({ credentials, budget });
    const changeSet = await plan({ US: { currency: 'USD', amount: '24.99' }, GB: { currency: 'GBP', amount: '26.99' }, DE: { currency: 'EUR', amount: '19.99' } });
    server.calls = [];
    const run = await applyChangeSet(changeSet, { adapter, budget, concurrency: 1 });
    expect(server.calls.every((c) => c.options.budget === budget)).toBe(true);
    expect(budget.used).toBe(6); // 3 app checks (app, its groups, the subscription's group) + 1 state read + 2 creates
    expect(run.stoppedReason).toBe('BUDGET_EXCEEDED');
    expect(run.ops.map((r) => r.status)).toEqual(['ok', 'ok', 'pending']);
  });

  it('does not start a create-then-delete replacement with only one request left', async () => {
    const budget = new RequestBudget({ limit: 5 }); // 3 app checks + state read + 1
    const adapter = new AppleAdapter({ credentials, budget });
    const changeSet = await plan({ DE: { currency: 'EUR', amount: '31.99', startDate: '2099-07-01' } });
    server.calls = [];
    const run = await applyChangeSet(changeSet, { adapter, budget });
    expect(server.writes()).toEqual([]);
    expect(run.ops[0].status).toBe('pending');
    expect(run.stoppedReason).toBe('BUDGET_EXCEEDED');
  });

  it('stops the run, rather than reporting success, when the budget runs out between create and delete', async () => {
    const budget = new RequestBudget({ limit: 5 }); // 3 app checks + state read + create; the delete is refused
    const adapter = new AppleAdapter({ credentials, budget });
    const changeSet = await plan({ DE: { currency: 'EUR', amount: '31.99', startDate: '2099-07-01' } });
    server.calls = [];
    const run = await applyChangeSet(changeSet, { adapter }); // executor not told about the budget
    expect(server.writes()).toEqual(['POST /subscriptionPrices']);
    expect(run.ops[0]).toMatchObject({ status: 'failed', error: { code: 'BUDGET_EXCEEDED' } });
    expect(run.ops[0].error?.message).toMatch(/two scheduled prices|Delete one of the two/);
    expect(run.stoppedReason).toBe('BUDGET_EXCEEDED');
  });

  it('records a warning when the replaced scheduled price cannot be deleted', async () => {
    const adapter = new AppleAdapter({ credentials });
    const changeSet = await plan({ DE: { currency: 'EUR', amount: '31.99', startDate: '2099-07-01' } });
    server.failDelete = 500;
    const run = await applyChangeSet(changeSet, { adapter });
    expect(run.ops[0].status).toBe('ok');
    expect(run.ops[0].warning).toMatch(/could not be removed/);
  });

  it('on resume after a create that took effect but errored, reports two scheduled prices and sends nothing', async () => {
    const adapter = new AppleAdapter({ credentials });
    const changeSet = await plan({ DE: { currency: 'EUR', amount: '31.99', startDate: '2099-07-01' } });
    server.failCreateAfterWrite.set('DEU', 504);
    const first = await applyChangeSet(changeSet, { adapter });
    expect(first.ops[0]).toMatchObject({ status: 'failed', error: { status: 504 } });
    expect(server.writes()).toEqual(['POST /subscriptionPrices']); // no delete after a failed create

    server.calls = [];
    const resumed = await applyChangeSet(changeSet, { adapter, run: first });
    expect(resumed.ops[0]).toMatchObject({ status: 'failed', error: { code: 'STATE_CHANGED' } });
    expect(resumed.ops[0].error?.message).toMatch(/2 future prices/);
    expect(server.writes()).toEqual([]);
  });

  it('refuses a plan against a territory whose price can only be guessed', async () => {
    const adapter = new AppleAdapter({ credentials });
    const changeSet = await plan({ GB: { currency: 'GBP', amount: '26.99' } });
    const gb = server.prices.find((p) => p.alpha2 === 'GB')!;
    server.dropPointRelationship.add(gb.id);
    server.calls = [];
    const run = await applyChangeSet(changeSet, { adapter });
    expect(run.ops[0]).toMatchObject({ status: 'failed', error: { code: 'STATE_CHANGED' } });
    expect(server.writes()).toEqual([]);
  });

  it('names the scheduled price when Apple refuses an immediate change with 409, deleting nothing', async () => {
    const adapter = new AppleAdapter({ credentials });
    const changeSet = await plan({ DE: { currency: 'EUR', amount: '19.99' } });
    expect(changeSet.warnings?.[0]).toMatchObject({ opId: 'op-0001', message: expect.stringMatching(/also has a scheduled price \(29\.99 EUR/) });
    server.failCreate.set('DEU', 409);
    server.calls = [];
    const run = await applyChangeSet(changeSet, { adapter });
    expect(run.ops[0].error).toMatchObject({ status: 409 });
    expect(run.ops[0].error?.message).toMatch(/scheduled price already exists for DE: 29\.99 EUR .* from 2099-06-01/);
    expect(server.writes()).toEqual(['POST /subscriptionPrices']);
  });

  it('refuses to delete a scheduled price that no longer matches the plan', async () => {
    const adapter = new AppleAdapter({ credentials });
    const changeSet = await plan({ DE: { currency: 'EUR', amount: '31.99', startDate: '2099-07-01' } });
    const run = await applyChangeSet(changeSet, { adapter });
    const undo = buildUndoChangeSet(changeSet, run);
    // Someone replaces the scheduled price before the undo runs
    server.prices = server.prices.filter((p) => !p.startDate);
    server.seed('DE', '19.99', '2099-08-01');
    server.calls = [];
    const undone = await applyChangeSet(undo, { adapter });
    expect(undone.ops[0]).toMatchObject({ status: 'failed', error: { code: 'STATE_CHANGED' } });
    expect(server.writes()).toEqual([]);
  });

  it('records the created Apple price ID in the run log', async () => {
    const adapter = new AppleAdapter({ credentials });
    const changeSet = await plan({ GB: { currency: 'GBP', amount: '26.99' } });
    const run = await applyChangeSet(changeSet, { adapter });
    expect(run.ops[0].response?.createdPriceId).toEqual(expect.any(String));
    expect(appleApiRequest.mock.calls.find((c) => c[2]?.method === 'POST')?.[2].body.data.relationships.territory.data.id).toBe('GBR');
  });
});
