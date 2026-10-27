import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import { AppleAdapter } from '@/lib/adapters/apple';
import { RequestBudget } from '@/lib/utils/request-budget';
import {
  applyChangeSet,
  ChangeSetValidationError,
  ConfirmationRequiredError,
  isOfferOp,
  parseChangeSet,
  parseRun,
  RunValidationError,
  summarizeRun,
} from '@/lib/pricing';
import { appleErrorResponse } from '../../../../_lib/error-response';

const bodySchema = z
  .object({
    changeSet: z.unknown(),
    /** changeSetHash of the plan the user reviewed */
    confirm: z.string().regex(/^[0-9a-f]{16}$/),
    /** A previous run of this plan, to resume */
    run: z.unknown().optional(),
  })
  .strict();

/** What the web app may apply. Ending and deleting offers stay library/CLI-only for now. */
const ALLOWED_KINDS = new Set(['createOffer', 'updateOfferPrices']);

// POST /api/apple/subscriptions/[id]/offers/apply
// Applies an offer plan made by .../offers/plan. Every op must be an offer op
// on this subscription in the signed-in app, and `confirm` must be the plan's
// hash. Each op is checked against App Store Connect before anything is sent;
// the response is the run log (pricingkit.applyRun).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { id } = await params;
    if (!/^\d+$/.test(id)) {
      return NextResponse.json({ error: 'Use the numeric App Store Connect subscription ID' }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, { status: 400 });
    }
    const changeSet = parseChangeSet(parsed.data.changeSet);
    const run = parsed.data.run === undefined ? undefined : parseRun(parsed.data.run);

    if (!('bundleId' in changeSet.app) || changeSet.app.bundleId !== auth.bundleId) {
      return NextResponse.json({ error: 'This plan is for a different app than the one you are signed in to' }, { status: 409 });
    }
    for (const op of changeSet.ops) {
      if (!isOfferOp(op) || !ALLOWED_KINDS.has(op.kind)) {
        return NextResponse.json({ error: `op ${op.id}: only offer creates and price updates can be applied here` }, { status: 400 });
      }
      if (op.target.product.platform !== 'apple' || op.target.product.id !== id) {
        return NextResponse.json({ error: `op ${op.id} is for another subscription` }, { status: 400 });
      }
    }

    const budget = new RequestBudget();
    const adapter = new AppleAdapter({ credentials: auth.credentials, budget });
    const result = await applyChangeSet(changeSet, { adapter, budget, confirm: parsed.data.confirm, verify: true, ...(run ? { run } : {}) });
    return NextResponse.json({ run: result, summary: summarizeRun(result) });
  } catch (error) {
    if (error instanceof ConfirmationRequiredError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof ChangeSetValidationError || error instanceof RunValidationError) {
      return NextResponse.json({ error: error.issues.join('; ') }, { status: 400 });
    }
    console.error('Error applying offer plan:', error);
    return appleErrorResponse(error, 'Failed to apply the offer plan');
  }
}
