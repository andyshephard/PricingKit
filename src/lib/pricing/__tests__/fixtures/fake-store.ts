// In-memory store behind the PlatformAdapter interface, for executor tests.
// Every read and write consumes one unit of the optional RequestBudget, like
// the real clients do.
import type { ApplyContext, OpResponse, PlatformAdapter, ResolveResult } from '../../adapter';
import { opSlot, type BasePriceOp } from '../../changeset';
import { invertOp } from '../../inverse';
import { productKey, type Platform, type ProductPriceState, type ProductRef } from '../../model';
import { RequestBudget } from '@/lib/utils/request-budget';

export interface FakeFailure {
  /** Fail this many times, then succeed */
  times: number;
  /** Apply the change but still throw (a create that answered 5xx) */
  afterWrite?: boolean;
  error: () => unknown;
}

export class FakeStore implements PlatformAdapter {
  readonly products = new Map<string, ProductPriceState>();
  readonly writes: string[] = [];
  reads = 0;
  inFlight = 0;
  peakInFlight = 0;
  failures = new Map<string, FakeFailure>(); // key: territory
  applyMany?: PlatformAdapter['applyMany'];
  batchKey?: PlatformAdapter['batchKey'];

  constructor(readonly platform: Platform, states: ProductPriceState[], private readonly budget?: RequestBudget) {
    for (const state of states) this.products.set(productKey(state.product), structuredClone(state));
  }

  /** Make applyMany write all ops of one product in one request, like a Google PATCH */
  enableBatching(): this {
    this.batchKey = (op) => productKey(op.target.product);
    this.applyMany = async (ops: BasePriceOp[], contexts: ApplyContext[]) => {
      this.budget?.consume(this.platform);
      this.writes.push(`batch:${ops.map((op) => op.target.territory).join(',')}`);
      return ops.map((op, i) => {
        try {
          this.write(op, contexts[i]);
          return { response: { batched: true } };
        } catch (error) {
          return { error };
        }
      });
    };
    return this;
  }

  state(product: ProductRef): ProductPriceState {
    return this.products.get(productKey(product))!;
  }

  async fetchState(product: ProductRef): Promise<ProductPriceState> {
    this.budget?.consume(this.platform);
    this.reads++;
    await new Promise((r) => setTimeout(r, 0));
    return structuredClone(this.state(product));
  }

  async resolvePricePoints(): Promise<ResolveResult> {
    return { resolved: {}, unresolved: {} };
  }

  private write(op: BasePriceOp, _context: ApplyContext): void {
    const state = this.state(op.target.product);
    const t = op.target.territory;
    const failure = this.failures.get(t);
    if (failure && failure.times > 0 && !failure.afterWrite) {
      failure.times--;
      throw failure.error();
    }
    const territory = (state.territories[t] ??= { territory: t, currency: (op.after ?? op.before)!.currency, current: null });
    if (op.kind === 'removePrice') delete state.territories[t];
    else if (opSlot(op.kind) === 'scheduled') territory.scheduled = op.after;
    else territory.current = op.after;
    if (failure && failure.times > 0 && failure.afterWrite) {
      failure.times--;
      throw failure.error();
    }
  }

  async apply(op: BasePriceOp, context: ApplyContext): Promise<OpResponse> {
    this.budget?.consume(this.platform);
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      this.writes.push(`${op.kind}:${op.target.territory}`);
      this.write(op, context);
      return { wrote: op.idempotencyKey };
    } finally {
      this.inFlight--;
    }
  }

  inverse(op: BasePriceOp) {
    return invertOp(op);
  }
}
