import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppleConnectCredentials, AppleProductPrice } from '../types';
import { appleKeyConnection } from '../../key-token-source';
import { ApiError } from '@/lib/utils/api-error';

// No network: every Apple call goes through this mock
const appleApiRequest = vi.fn();
vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return {
    ...actual,
    appleApiRequest: (...args: unknown[]) => appleApiRequest(...args),
    getAppIdForBundleId: vi.fn(async () => '1234567890'),
  };
});

import { AppleApiError } from '../client';
import {
  applySubscriptionPriceChanges,
  getSubscription,
  getSubscriptionById,
  getSubscriptionPricePoints,
  getSubscriptionPrices,
  toAppleTerritoryId,
  updateSubscriptionPrice,
} from '../subscriptions';

const credentials: AppleConnectCredentials = {
  privateKey: 'unused',
  keyId: 'TESTKEY123',
  issuerId: '00000000-0000-0000-0000-000000000000',
  bundleId: 'com.example.test',
};
const connection = appleKeyConnection(credentials);

type Call = { endpoint: string; method: string; body?: unknown };

function recordCalls(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  appleApiRequest.mockImplementation(
    async (_creds: unknown, endpoint: string, options: { method?: string; body?: unknown } = {}) => {
      const call = { endpoint, method: options.method ?? 'GET', body: options.body };
      calls.push(call);
      return handler(call);
    }
  );
  return calls;
}

function territoryOf(call: Call): string | undefined {
  const body = call.body as {
    data?: { relationships?: { territory?: { data?: { id?: string } } } };
  };
  return body?.data?.relationships?.territory?.data?.id;
}

function pricePointOf(call: Call): string | undefined {
  const body = call.body as {
    data?: { relationships?: { subscriptionPricePoint?: { data?: { id?: string } } } };
  };
  return body?.data?.relationships?.subscriptionPricePoint?.data?.id;
}

const scheduledFR: AppleProductPrice = {
  territoryCode: 'FR',
  currency: 'EUR',
  customerPrice: '4.99',
  proceeds: '3.50',
  pricePointId: 'old-pp-fr',
  subscriptionPriceId: 'old-price-fr',
  startDate: '2099-01-01',
};

const noDelay = { rateLimit: { delayBetweenBatches: 0 } };

beforeEach(() => {
  appleApiRequest.mockReset();
});

describe('Apple subscription reads surface errors', () => {
  it('getSubscriptionPrices throws ApiError instead of returning empty prices', async () => {
    recordCalls(() => {
      throw new AppleApiError(500, 'UNEXPECTED_ERROR', 'Server error', 'Something broke');
    });

    const promise = getSubscriptionPrices(connection, 'sub-1');
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 500, platform: 'apple' });
  });

  it('getSubscriptionPricePoints throws ApiError instead of returning []', async () => {
    recordCalls(() => {
      throw new AppleApiError(429, 'RATE_LIMIT_EXCEEDED', 'Rate limited', 'Too many requests');
    });

    await expect(getSubscriptionPricePoints(connection, 'sub-1', 'USA')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('getSubscriptionPricePoints converts non-ApiError failures', async () => {
    recordCalls(() => {
      throw new TypeError('fetch failed');
    });

    await expect(getSubscriptionPricePoints(connection, 'sub-1', 'USA')).rejects.toBeInstanceOf(
      ApiError
    );
  });

  it('getSubscriptionById returns null only for a genuine 404', async () => {
    recordCalls(() => {
      throw new AppleApiError(404, 'NOT_FOUND', 'Not found', 'No such subscription');
    });
    await expect(getSubscriptionById(connection, '999')).resolves.toBeNull();

    recordCalls(() => {
      throw new AppleApiError(403, 'FORBIDDEN', 'Forbidden', 'Not allowed');
    });
    await expect(getSubscriptionById(connection, '999')).rejects.toMatchObject({ status: 403 });
  });

  it('getSubscription throws when listing subscription groups fails', async () => {
    recordCalls(() => {
      throw new AppleApiError(401, 'NOT_AUTHORIZED', 'Unauthorized', 'Bad token');
    });

    await expect(getSubscription(connection, 'com.example.monthly')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('getSubscription returns null when the product genuinely does not exist', async () => {
    recordCalls((call) => {
      if (call.endpoint.endsWith('/subscriptionGroups')) {
        return { data: [{ id: 'g1', attributes: { referenceName: 'Group' } }], links: {} };
      }
      return { data: [], links: {} };
    });

    await expect(getSubscription(connection, 'com.example.missing')).resolves.toBeNull();
  });
});

describe('toAppleTerritoryId', () => {
  it('converts alpha-2 to alpha-3 and passes alpha-3 through', () => {
    expect(toAppleTerritoryId('US')).toBe('USA');
    expect(toAppleTerritoryId('fr')).toBe('FRA');
    expect(toAppleTerritoryId('GBR')).toBe('GBR');
  });

  it('throws a 400 ApiError for unknown territories', () => {
    expect(() => toAppleTerritoryId('XX')).toThrow(ApiError);
    try {
      toAppleTerritoryId('ZZZ');
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'INVALID_TERRITORY' });
    }
  });
});

describe('updateSubscriptionPrice', () => {
  it('POSTs alpha-3 territory IDs even when given alpha-2', async () => {
    const calls = recordCalls(() => ({}));

    await updateSubscriptionPrice(connection, 'sub-1', 'pp-1', 'DE', '2099-01-01');

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(territoryOf(calls[0])).toBe('DEU');
  });
});

describe('applySubscriptionPriceChanges', () => {
  it('creates a price when no scheduled price exists', async () => {
    const calls = recordCalls(() => ({}));

    const outcomes = await applySubscriptionPriceChanges(
      connection,
      'sub-1',
      { FR: { pricePointId: 'new-pp-fr', startDate: '2099-02-01' } },
      {},
      noDelay
    );

    expect(outcomes).toEqual([{ territoryCode: 'FR', status: 'created' }]);
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('creates the replacement before deleting the old scheduled price', async () => {
    const calls = recordCalls(() => ({}));

    const outcomes = await applySubscriptionPriceChanges(
      connection,
      'sub-1',
      { FR: { pricePointId: 'new-pp-fr', startDate: '2099-02-01' } },
      { FR: scheduledFR },
      noDelay
    );

    expect(outcomes[0]).toMatchObject({ territoryCode: 'FR', status: 'replaced' });
    expect(calls.map((c) => `${c.method} ${c.endpoint}`)).toEqual([
      'POST /subscriptionPrices',
      'DELETE /subscriptionPrices/old-price-fr',
    ]);
  });

  it('leaves the old scheduled price untouched when the create fails', async () => {
    const calls = recordCalls((call) => {
      if (call.method === 'POST') {
        throw new AppleApiError(500, 'UNEXPECTED_ERROR', 'Server error', 'Apple is down');
      }
      return {};
    });

    const outcomes = await applySubscriptionPriceChanges(
      connection,
      'sub-1',
      { FR: { pricePointId: 'new-pp-fr', startDate: '2099-02-01' } },
      { FR: scheduledFR },
      noDelay
    );

    expect(outcomes[0]).toMatchObject({
      territoryCode: 'FR',
      status: 'failed',
      errorStatus: 500,
      error: 'Apple is down',
      previousScheduled: { subscriptionPriceId: 'old-price-fr', pricePointId: 'old-pp-fr' },
    });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('never deletes anything on a 409, and names the scheduled price to clear', async () => {
    const calls = recordCalls((call) => {
      if (call.method === 'POST') {
        throw new AppleApiError(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', 'Invalid', 'Some validation error');
      }
      return {};
    });

    const outcomes = await applySubscriptionPriceChanges(
      connection,
      'sub-1',
      { FR: { pricePointId: 'new-pp-fr', startDate: '2099-02-01' } },
      { FR: scheduledFR },
      noDelay
    );

    // Exactly one create, no delete and no retry
    expect(calls.map((c) => c.method)).toEqual(['POST']);
    expect(pricePointOf(calls[0])).toBe('new-pp-fr');
    expect(outcomes[0]).toMatchObject({
      territoryCode: 'FR',
      status: 'failed',
      errorStatus: 409,
      previousScheduled: {
        subscriptionPriceId: 'old-price-fr',
        pricePointId: 'old-pp-fr',
        startDate: '2099-01-01',
        customerPrice: '4.99',
        currency: 'EUR',
      },
    });
    expect(outcomes[0].error).toMatch(/^Some validation error/);
    expect(outcomes[0].error).toMatch(/4\.99 EUR from 2099-01-01/);
    expect(outcomes[0].error).toMatch(/clear the scheduled price first/);
  });

  it('names the scheduled price on a 409 for an immediate change too, and deletes nothing', async () => {
    const calls = recordCalls((call) => {
      if (call.method === 'POST') {
        throw new AppleApiError(409, 'ENTITY_ERROR', 'Conflict', 'Rejected');
      }
      return {};
    });

    const outcomes = await applySubscriptionPriceChanges(
      connection,
      'sub-1',
      { FR: { pricePointId: 'new-pp-fr' } },
      { FR: scheduledFR },
      noDelay
    );

    expect(calls.map((c) => c.method)).toEqual(['POST']);
    expect(outcomes[0]).toMatchObject({ status: 'failed', errorStatus: 409 });
    expect(outcomes[0].error).toMatch(/4\.99 EUR from 2099-01-01/);
  });

  it('leaves a scheduled price in place when an immediate change succeeds', async () => {
    const calls = recordCalls(() => ({}));
    const outcomes = await applySubscriptionPriceChanges(
      connection,
      'sub-1',
      { FR: { pricePointId: 'new-pp-fr' } },
      { FR: scheduledFR },
      noDelay
    );
    expect(calls.map((c) => c.method)).toEqual(['POST']);
    expect(outcomes).toEqual([{ territoryCode: 'FR', status: 'created' }]);
  });

  it('reports a plain 409 when no scheduled price exists', async () => {
    const calls = recordCalls((call) => {
      if (call.method === 'POST') {
        throw new AppleApiError(409, 'ENTITY_ERROR', 'Conflict', 'Rejected');
      }
      return {};
    });

    const outcomes = await applySubscriptionPriceChanges(
      connection,
      'sub-1',
      { FR: { pricePointId: 'new-pp-fr', startDate: '2099-02-01' } },
      {},
      noDelay
    );

    expect(calls.map((c) => c.method)).toEqual(['POST']);
    expect(outcomes).toEqual([
      { territoryCode: 'FR', status: 'failed', error: 'Rejected', errorStatus: 409 },
    ]);
  });

  it('keeps the old price and warns when it cannot be deleted after a successful create', async () => {
    recordCalls((call) => {
      if (call.method === 'DELETE') {
        throw new AppleApiError(500, 'UNEXPECTED_ERROR', 'Server error', 'Down');
      }
      return {};
    });

    const outcomes = await applySubscriptionPriceChanges(
      connection,
      'sub-1',
      { FR: { pricePointId: 'new-pp-fr', startDate: '2099-02-01' } },
      { FR: scheduledFR },
      noDelay
    );

    expect(outcomes[0].status).toBe('created');
    expect(outcomes[0].warning).toMatch(/could not be removed/);
  });

  it('reports a separate outcome per territory', async () => {
    recordCalls((call) => {
      if (call.method === 'POST' && territoryOf(call) === 'DEU') {
        throw new AppleApiError(422, 'ENTITY_ERROR', 'Invalid', 'Bad price point');
      }
      return {};
    });

    const outcomes = await applySubscriptionPriceChanges(
      connection,
      'sub-1',
      {
        FR: { pricePointId: 'pp-fr' },
        DE: { pricePointId: 'pp-de' },
      },
      {},
      noDelay
    );

    expect(outcomes).toEqual([
      { territoryCode: 'FR', status: 'created' },
      expect.objectContaining({ territoryCode: 'DE', status: 'failed', error: 'Bad price point' }),
    ]);
  });
});
