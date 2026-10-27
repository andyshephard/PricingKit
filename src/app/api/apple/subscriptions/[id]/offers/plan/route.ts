import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import { appleKeyConnection } from '@/lib/token-source';
import { AppleAdapter } from '@/lib/adapters/apple';
import { RequestBudget } from '@/lib/utils/request-budget';
import {
  ChangeSetValidationError,
  InvalidOfferSpecError,
  OfferRuleError,
  parseOfferSpec,
  type OfferSpec,
  type ProductRef,
} from '@/lib/pricing';
import { appleErrorResponse } from '../../../../_lib/error-response';
import { rejectCrossSite, readJsonBody, LARGE_BODY_LIMIT } from '@/lib/request-guard';

const rule = {
  percent: z.string().min(1).max(20),
  basis: z.enum(['perPeriod', 'totalOverDuration']),
  snap: z.enum(['nearest', 'floor', 'ceil']).default('nearest'),
};

const bodySchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      offerCode: z.string().trim().min(1).max(64),
      name: z.string().trim().min(1).max(64),
      mode: z.enum(['PAY_UP_FRONT', 'PAY_AS_YOU_GO']),
      duration: z.enum(['P3D', 'P1W', 'P2W', 'P1M', 'P2M', 'P3M', 'P6M', 'P1Y']),
      periods: z.number().int().min(1).max(12).optional(),
      ...rule,
    })
    .strict(),
  z.object({ action: z.literal('updatePrices'), offer: z.string().min(1).max(200), ...rule }).strict(),
]);

// POST /api/apple/subscriptions/[id]/offers/plan
// Dry run: plans creating a promotional offer from a percent-of-current rule,
// or re-pricing an existing one to its rule. Reads only; returns the plan
// (pricingkit.changeset), its hash (what an apply must confirm) and the
// per-territory preview.
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
    const body = parsed.data;
    const product: ProductRef = { platform: 'apple', type: 'subscription', id };
    const adapter = new AppleAdapter({ ...connection, budget: new RequestBudget() });
    // API keys reach every app of a team: the subscription must be in the session's app (APP_MISMATCH otherwise)
    await adapter.verifyProduct(product);
    const pricing = { type: 'percentOfCurrent' as const, percent: body.percent, basis: body.basis, snap: body.snap };

    let spec: OfferSpec;
    if (body.action === 'create') {
      spec = {
        id: body.offerCode,
        name: body.name,
        productRef: product,
        kind: 'apple.promo',
        mode: body.mode,
        duration: body.duration,
        ...(body.mode === 'PAY_AS_YOU_GO' && body.periods ? { periods: body.periods } : {}),
        pricing,
        territories: 'all',
        syncWithBase: true,
      };
    } else {
      const existing = await adapter.fetchOffer(product, 'apple.promo', body.offer);
      if (!existing) return NextResponse.json({ error: 'Offer not found' }, { status: 404 });
      if (!existing.mode || !existing.duration) return NextResponse.json({ error: 'The offer has an unknown mode or duration' }, { status: 422 });
      spec = {
        id: existing.key,
        ...(existing.name ? { name: existing.name } : {}),
        productRef: product,
        kind: 'apple.promo',
        mode: existing.mode,
        duration: existing.duration,
        ...(existing.periods ? { periods: existing.periods } : {}),
        pricing,
        territories: 'all',
        syncWithBase: true,
      };
    }
    try {
      spec = parseOfferSpec(spec);
    } catch (error) {
      if (error instanceof InvalidOfferSpecError) return NextResponse.json({ error: error.problems.join('; ') }, { status: 400 });
      throw error;
    }

    const plan = await adapter.planOffers({ app: { bundleId: auth.bundleId }, offers: [spec] });
    return NextResponse.json({ changeSet: plan.changeSet, hash: plan.hash, entry: plan.entries[0] });
  } catch (error) {
    if (error instanceof OfferRuleError) return NextResponse.json({ error: error.message }, { status: 422 });
    if (error instanceof ChangeSetValidationError) return NextResponse.json({ error: error.issues.join('; ') }, { status: 422 });
    console.error('Error planning offer:', error);
    return appleErrorResponse(error, 'Failed to plan the offer');
  }
}
