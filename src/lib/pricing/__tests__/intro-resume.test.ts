// A resumed introductory offer create claims only territories this run sent.
// An identical intro offer someone else made in another territory must never
// be adopted into createdIds, or undo (with --force-delete) would delete it.
import { describe, it, expect } from 'vitest';
import { applyChangeSet, buildUndoChangeSet, planOfferChanges, type ApplyRun, type OfferOp, type PlatformAdapter } from '..';

const product = { platform: 'apple', type: 'subscription', id: '9200000001' } as const;
const app = { bundleId: 'com.example.app' };
const NOW = '2030-01-01T00:00:00Z';
const base = {
  product,
  capturedAt: NOW,
  territories: {
    US: { territory: 'US', currency: 'USD', current: { currency: 'USD', amount: '59.99', pricePointId: 'us-5999' } },
    GB: { territory: 'GB', currency: 'GBP', current: { currency: 'GBP', amount: '49.99', pricePointId: 'gb-4999' } },
  },
};
const ladders = {
  US: { currency: 'USD', points: [{ id: 'us-2999', customerPrice: '29.99' }, { id: 'us-5999', customerPrice: '59.99' }] },
  GB: { currency: 'GBP', points: [{ id: 'gb-2499', customerPrice: '24.99' }, { id: 'gb-4999', customerPrice: '49.99' }] },
};

function introPlan() {
  return planOfferChanges({
    app,
    createdAt: NOW,
    id: 'p',
    today: '2030-01-01',
    inputs: [
      {
        spec: {
          id: 'intro',
          productRef: product,
          kind: 'apple.intro',
          mode: 'PAY_UP_FRONT',
          duration: 'P1Y',
          pricing: { type: 'percentOfCurrent', percent: '50', basis: 'totalOverDuration', snap: 'nearest' },
          territories: 'all',
          syncWithBase: false,
        } as never,
        billingPeriod: 'P1Y',
        base: base as never,
        ladders: ladders as never,
        existing: [],
      },
    ],
  });
}

/** An in-memory store of intro offers (one resource per territory) behind a minimal adapter */
function fakeStore(op: OfferOp, behaviour: { refuseFirst?: string; tookEffectThenFailed?: string }) {
  const store: Array<Record<string, unknown>> = [];
  const resource = (territory: string, id: string) => ({
    kind: 'apple.intro',
    storeId: id,
    key: op.target.offer.key,
    mode: op.after!.mode,
    duration: op.after!.duration,
    periods: op.after!.periods,
    schedule: op.after!.schedule ?? {},
    prices: { [territory]: op.after!.prices[territory] },
    storeRefs: { [territory]: id },
  });
  let sends = 0;
  const sent: string[][] = [];
  const adapter = {
    platform: 'apple',
    fetchState: async () => base,
    resolvePricePoints: async () => ({ resolved: {}, unresolved: {} }),
    apply: async () => ({}),
    inverse: () => ({ notReversible: 'x' }),
    fetchOffers: async () => store,
    applyOffer: async (_op: unknown, ctx: { pending?: string[] }) => {
      const pending = ctx.pending ?? [];
      sent.push(pending);
      sends++;
      if (sends === 1 && behaviour.refuseFirst) throw Object.assign(new Error('Apple refused (409)'), { status: 409 });
      const created: Record<string, string> = {};
      for (const t of pending) {
        store.push(resource(t, `NEW-${t}`));
        created[t] = `NEW-${t}`;
      }
      if (sends === 1 && behaviour.tookEffectThenFailed) throw Object.assign(new Error('timed out'), { status: 504 });
      return { territories: pending.length, createdIds: created };
    },
  } as unknown as PlatformAdapter;
  return { store, adapter, sent, resource };
}

describe('resuming an introductory offer create', () => {
  it("doesn't adopt an identical intro offer someone else made in a territory this run never sent; undo leaves it alone", async () => {
    const { changeSet, hash } = introPlan();
    const op = changeSet.ops[0] as OfferOp;
    expect(Object.keys(op.after!.prices).sort()).toEqual(['GB', 'US']);
    const { store, adapter, sent, resource } = fakeStore(op, { refuseFirst: 'US' });
    // After planning, someone made an identical GB intro offer by hand
    store.push(resource('GB', 'PRE-GB'));

    const pass1 = await applyChangeSet(changeSet, { adapter, confirm: hash, now: () => NOW });
    expect(pass1.ops[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(sent).toEqual([['US']]);
    expect(pass1.ops[0].response?.sentTerritories).toEqual(['US']);

    const pass2 = await applyChangeSet(changeSet, { adapter, confirm: hash, run: pass1 as ApplyRun, now: () => NOW });
    expect(pass2.ops[0].status).toBe('ok');
    expect(pass2.ops[0].response?.createdIds).toEqual({ US: 'NEW-US' });
    expect(pass2.ops[0].response?.foundOnResume).toBeUndefined();
    expect(pass2.ops[0].response?.sentTerritories).toEqual(['US']);

    const undo = buildUndoChangeSet(changeSet, pass2, { createdAt: '2030-01-02T00:00:00Z' });
    const refs = undo.ops.map((o) => (o as OfferOp).before?.storeRefs);
    expect(JSON.stringify(refs)).not.toContain('PRE-GB');
    expect(refs).toEqual([{ US: 'NEW-US' }]);
    expect(undo.notReversible?.map((n) => n.reason).join(' ')).toMatch(/GB/);
  });

  it('still adopts a territory it sent that took effect before the request failed', async () => {
    const { changeSet, hash } = introPlan();
    const op = changeSet.ops[0] as OfferOp;
    const { adapter, sent } = fakeStore(op, { tookEffectThenFailed: 'all' });

    const pass1 = await applyChangeSet(changeSet, { adapter, confirm: hash, now: () => NOW });
    expect(pass1.ops[0].status).toBe('failed');
    expect(sent).toEqual([['GB', 'US']]);
    expect(pass1.ops[0].response?.createdIds).toBeUndefined();

    const pass2 = await applyChangeSet(changeSet, { adapter, confirm: hash, run: pass1 as ApplyRun, now: () => NOW });
    expect(pass2.ops[0].status).toBe('ok');
    expect(pass2.ops[0].response?.createdIds).toEqual({ GB: 'NEW-GB', US: 'NEW-US' });
    expect(pass2.ops[0].response?.foundOnResume).toEqual(['GB', 'US']);
    const undo = buildUndoChangeSet(changeSet, pass2, { createdAt: '2030-01-02T00:00:00Z' });
    expect(undo.ops.map((o) => (o as OfferOp).before?.storeRefs)).toEqual([{ GB: 'NEW-GB', US: 'NEW-US' }]);
  });
});
