import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAuthFromCookies } from '@/middleware/auth';
import { GoogleKeyTokenSource } from '@/lib/token-source';
import { PlayAdapter } from '@/lib/adapters/play';
import { getErrorStatus, toApiError } from '@/lib/utils/api-error';
import { RequestBudget } from '@/lib/utils/request-budget';
import { googlePlayBasePlanIdSchema, validateAndDecodeSku, ValidationError } from '@/lib/validation';

// GET /api/subscriptions/[id]/offers?basePlanId=...
// Read-only: the Google Play offers of one base plan (or, without
// basePlanId, of every base plan of the subscription) with their state,
// eligibility, tags and each phase's price per region. Offers Play returned
// in a shape PricingKit can't read exactly carry `problems`. The app is the
// session's app; every request gets its own request budget.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getGoogleAuthFromCookies();
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const tokens = new GoogleKeyTokenSource(auth.credentials);

    const { id } = await params;
    let productId: string;
    try {
      productId = validateAndDecodeSku(id);
    } catch (error) {
      if (error instanceof ValidationError) return NextResponse.json({ error: error.message, details: error.details }, { status: 400 });
      throw error;
    }
    const basePlanParam = request.nextUrl.searchParams.get('basePlanId');
    if (basePlanParam !== null && !googlePlayBasePlanIdSchema.safeParse(basePlanParam).success) {
      return NextResponse.json({ error: 'Invalid basePlanId' }, { status: 400 });
    }

    const adapter = new PlayAdapter({ tokens, packageName: auth.packageName, budget: new RequestBudget() });
    const offers = basePlanParam
      ? await adapter.fetchOffers({ platform: 'google', type: 'subscription', productId, basePlanId: basePlanParam })
      : await adapter.fetchSubscriptionOffers(productId);
    return NextResponse.json({ offers });
  } catch (error) {
    console.error('Error fetching Play subscription offers:', error);
    const status = getErrorStatus(error);
    if (status === 401 || status === 403 || status === 404 || status === 429) {
      return NextResponse.json({ error: toApiError(error, 'google').message }, { status });
    }
    return NextResponse.json({ error: 'Failed to fetch offers' }, { status: 500 });
  }
}
