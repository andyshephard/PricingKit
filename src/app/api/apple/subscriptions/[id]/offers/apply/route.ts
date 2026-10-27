import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import { appleKeyConnection } from '@/lib/key-token-source';
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
  confirmHashSchema,
} from '@/lib/pricing';
import { appleErrorResponse } from '../../../../_lib/error-response';
import { rejectCrossSite, readJsonBody, LARGE_BODY_LIMIT } from '@/lib/request-guard';

const bodySchema = z
  .object({
    changeSet: z.unknown(),
    /** changeSetHash of the plan the user reviewed */
    confirm: confirmHashSchema,
    /** A previous run of this plan, to resume */
    run: z.unknown().optional(),
  })
  .strict();

/**
 * What the web app may apply: promotional offer creates and price updates,
 * the two things its UI plans. Everything else (intro offers, offer codes,
 * win-back offers, ending and deleting) is library/CLI-only.
 */
const ALLOWED_KINDS = new Set(['createOffer', 'updateOfferPrices']);
const ALLOWED_OFFER_KINDS = new Set(['apple.promo']);

// POST /api/apple/subscriptions/[id]/offers/apply
// Applies an offer plan made by .../offers/plan. Every op must be an offer op
// on this subscription in the signed-in app, and `confirm` must be the plan's
// hash. Each op is checked against App Store Connect before anything is sent;
// the response is the run log (pricingkit.applyRun).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const connection = appleKeyConnection(auth.credentials);

    const { id } = await params;
    if (!/^\d+$/.test(id)) {
      return NextResponse.json({ error: 'Use the numeric App Store Connect subscription ID' }, { status: 400 });
    }
    const read = await readJsonBody(request, LARGE_BODY_LIMIT);
    if (!read.ok) return read.response;
    const parsed = bodySchema.safeParse(read.body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, { status: 400 });
    }
    const changeSet = parseChangeSet(parsed.data.changeSet);
    const run = parsed.data.run === undefined ? undefined : parseRun(parsed.data.run);

    if (!('bundleId' in changeSet.app) || changeSet.app.bundleId !== auth.bundleId) {
      return NextResponse.json({ error: 'This plan is for a different app than the one you are signed in to' }, { status: 409 });
    }
    for (const op of changeSet.ops) {
      if (!isOfferOp(op) || !ALLOWED_KINDS.has(op.kind) || !ALLOWED_OFFER_KINDS.has(op.target.offer.kind)) {
        return NextResponse.json({ error: `op ${op.id}: only promotional offer creates and price updates can be applied here` }, { status: 400 });
      }
      if (op.target.product.platform !== 'apple' || op.target.product.id !== id) {
        return NextResponse.json({ error: `op ${op.id} is for another subscription` }, { status: 400 });
      }
    }

    const budget = new RequestBudget();
    const adapter = new AppleAdapter({ ...connection, budget });
    // API keys reach every app of a team: the subscription must be in the session's app
    // (APP_MISMATCH otherwise). The executor checks again before reading or writing.
    if (changeSet.ops.length > 0) await adapter.verifyProduct(changeSet.ops[0].target.product);
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
