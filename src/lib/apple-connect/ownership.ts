// Which app does a subscription belong to?
//
// App Store Connect API keys are team-wide: a subscription ID from one app
// (say production) works with the same key while the session or plan names
// another app (say staging). Before PricingKit writes to a subscription it
// checks that the subscription's group is one of the app's groups.
//
// OpenAPI 4.5.1 has no subscriptionGroup -> app relationship, so the check
// reads the subscription's `group` (GET /subscriptions/{id}?include=group)
// and the app's groups (GET /apps/{appId}/subscriptionGroups), with the app
// found by exact bundle ID (GET /apps?filter[bundleId]=...).

import { appleApiRequest } from './client';
import { appleListAll } from './pagination';
import type { AppleConnection } from './types';
import type { RequestContext } from '../utils/request-budget';
import { ApiError, toApiError } from '../utils/api-error';

export const APP_MISMATCH = 'APP_MISMATCH';

function mismatch(message: string): ApiError {
  return new ApiError(message, { status: 409, code: APP_MISMATCH, platform: 'apple', retryable: false });
}

/** The App Store Connect app ID for an exact bundle ID, or null */
export async function findAppIdByBundleId(connection: AppleConnection, bundleId: string, ctx: RequestContext = {}): Promise<string | null> {
  const response = await appleApiRequest<{ data?: Array<{ id: string; attributes?: { bundleId?: string } }> }>(connection, '/apps', {
    queryParams: { 'filter[bundleId]': bundleId, 'fields[apps]': 'bundleId', limit: '200' },
    budget: ctx.budget,
  });
  // The filter can match prefixes; only an exact match counts
  return response.data?.find((app) => app.attributes?.bundleId === bundleId)?.id ?? null;
}

/** IDs of every subscription group of an app */
export async function listAppSubscriptionGroupIds(connection: AppleConnection, appId: string, ctx: RequestContext = {}): Promise<Set<string>> {
  const groups = await appleListAll<{ id: string }>(connection, `/apps/${encodeURIComponent(appId)}/subscriptionGroups`, {
    queryParams: { 'fields[subscriptionGroups]': 'referenceName', limit: '200' },
    budget: ctx.budget,
  });
  return new Set(groups.data.map((g) => g.id));
}

/** The subscription group a subscription belongs to */
export async function getSubscriptionGroupId(connection: AppleConnection, subscriptionId: string, ctx: RequestContext = {}): Promise<string> {
  const response = await appleApiRequest<{
    data?: { relationships?: { group?: { data?: { id?: string } | null } } };
    included?: Array<{ type?: string; id?: string }>;
  }>(connection, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    queryParams: { include: 'group', 'fields[subscriptions]': 'group', 'fields[subscriptionGroups]': 'referenceName' },
    budget: ctx.budget,
  });
  const id = response.data?.relationships?.group?.data?.id ?? response.included?.find((i) => i.type === 'subscriptionGroups')?.id;
  if (!id) {
    throw new ApiError(`App Store Connect didn't say which group subscription ${subscriptionId} is in, so its app can't be checked`, {
      status: 422,
      code: 'GROUP_UNKNOWN',
      platform: 'apple',
      retryable: false,
    });
  }
  return id;
}

/**
 * Checks subscriptions belong to one app. Keeps the app's group list for
 * its lifetime (one run or request), so checking several subscriptions
 * costs one group read each plus one app lookup.
 */
export class SubscriptionOwnership {
  private groups?: Promise<Set<string>>;
  private readonly verified = new Set<string>();

  constructor(
    private readonly connection: AppleConnection,
    private readonly bundleId: string,
    private readonly ctx: RequestContext = {}
  ) {}

  private appGroups(): Promise<Set<string>> {
    this.groups ??= (async () => {
      if (!this.bundleId) throw mismatch('No app is selected, so the subscription can\'t be checked against it');
      const appId = await findAppIdByBundleId(this.connection, this.bundleId, this.ctx);
      if (!appId) throw new ApiError(`No app with bundle ID ${this.bundleId} for this API key`, { status: 404, code: 'APP_NOT_FOUND', platform: 'apple', retryable: false });
      return listAppSubscriptionGroupIds(this.connection, appId, this.ctx);
    })();
    // A failed lookup isn't cached: the next check tries again
    this.groups.catch(() => (this.groups = undefined));
    return this.groups;
  }

  /** Throws APP_MISMATCH (409) unless the subscription is in one of the app's groups */
  async assert(subscriptionId: string): Promise<void> {
    if (this.verified.has(subscriptionId)) return;
    try {
      const [groups, groupId] = await Promise.all([this.appGroups(), getSubscriptionGroupId(this.connection, subscriptionId, this.ctx)]);
      if (!groups.has(groupId)) {
        throw mismatch(`Subscription ${subscriptionId} doesn't belong to ${this.bundleId}. API keys work across a team's apps, so PricingKit refuses to touch another app's subscription.`);
      }
    } catch (error) {
      throw toApiError(error, 'apple');
    }
    this.verified.add(subscriptionId);
  }
}

/** One-off check for routes: the subscription must be in the selected app (X-PK-App) */
export async function assertSubscriptionInApp(connection: AppleConnection, subscriptionId: string, ctx: RequestContext = {}): Promise<void> {
  await new SubscriptionOwnership(connection, connection.bundleId, ctx).assert(subscriptionId);
}
