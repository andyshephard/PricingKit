// Google Play price conversion (monetization.convertRegionPrices).
// Read-only: it changes nothing on the store, though it is a POST.

import { googlePlayFetch } from './client';
import type { Money, ServiceAccountCredentials } from './types';
import type { RequestContext } from '../utils/request-budget';

export interface ConvertedRegionPrice {
  regionCode: string;
  /** Converted price, tax inclusive */
  price: Money;
  /** Tax included in `price` */
  taxAmount?: Money;
}

export interface ConvertRegionPricesResponse {
  convertedRegionPrices?: Record<string, ConvertedRegionPrice>;
  convertedOtherRegionsPrice?: { usdPrice?: Money; eurPrice?: Money };
  regionVersion?: { version?: string };
}

/**
 * Ask Play what `price` (tax exclusive) becomes in every region, using
 * today's exchange rates and Play's per-country pricing patterns.
 * POST /androidpublisher/v3/applications/{packageName}/pricing:convertRegionPrices
 */
export async function convertRegionPrices(
  credentials: ServiceAccountCredentials,
  packageName: string,
  price: Money,
  ctx: RequestContext = {}
): Promise<ConvertRegionPricesResponse> {
  return googlePlayFetch<ConvertRegionPricesResponse>(
    credentials,
    `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/pricing:convertRegionPrices`,
    {
      method: 'POST',
      body: { price: { currencyCode: price.currencyCode, units: price.units, ...(price.nanos ? { nanos: price.nanos } : {}) } },
      budget: ctx.budget,
    }
  );
}
