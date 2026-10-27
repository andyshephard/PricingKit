import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppleAuthFromCookies } from '@/middleware/auth';
import { AppleAdapter } from '@/lib/adapters/apple';
import { RequestBudget } from '@/lib/utils/request-budget';
import { APPLE_OFFER_KINDS, InvalidOfferSpecError, OfferRuleError, parsePercentOfCurrentRule } from '@/lib/pricing';
import { appleErrorResponse } from '../../../../_lib/error-response';

const querySchema = z.object({
  kind: z.enum(APPLE_OFFER_KINDS),
  offer: z.string().min(1).max(200),
  percent: z.string().min(1).max(20),
  basis: z.enum(['perPeriod', 'totalOverDuration']).default('perPeriod'),
  snap: z.enum(['nearest', 'floor', 'ceil']).default('nearest'),
  threshold: z
    .string()
    .regex(/^(0(\.\d{1,4})?|1)$/, 'threshold is a fraction between 0 and 1, e.g. 0.05')
    .optional(),
});

// GET /api/apple/subscriptions/[id]/offers/drift?kind=apple.promo&offer=<id or key>&percent=50&basis=perPeriod&snap=nearest
// Read-only: compares one offer's prices with "percent of each territory's
// current price, snapped to its price points" and returns an OfferDriftReport.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAppleAuthFromCookies();
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { id } = await params;
    if (!/^\d+$/.test(id)) {
      return NextResponse.json({ error: 'Use the numeric App Store Connect subscription ID' }, { status: 400 });
    }
    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
    }
    const { kind, offer, percent, basis, snap, threshold } = parsed.data;
    let rule;
    try {
      rule = parsePercentOfCurrentRule({ type: 'percentOfCurrent', percent, basis, snap });
    } catch (error) {
      if (error instanceof InvalidOfferSpecError) return NextResponse.json({ error: error.problems.join('; ') }, { status: 400 });
      throw error;
    }

    const adapter = new AppleAdapter({ credentials: auth.credentials, budget: new RequestBudget() });
    const report = await adapter.checkOfferDrift(
      { platform: 'apple', type: 'subscription', id },
      { kind, offer, rule, ...(threshold ? { deviationThreshold: threshold } : {}) }
    );
    if (!report) return NextResponse.json({ error: 'Offer not found' }, { status: 404 });
    return NextResponse.json({ report });
  } catch (error) {
    if (error instanceof OfferRuleError) return NextResponse.json({ error: error.message }, { status: 422 });
    console.error('Error checking offer drift:', error);
    return appleErrorResponse(error, 'Failed to check offer');
  }
}
