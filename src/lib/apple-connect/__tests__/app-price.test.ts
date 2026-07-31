import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppleApiError,
  appleApiRequest,
  getAppIdForBundleId,
} from '../client';
import { getAppPrices } from '../app-price';
import type { AppleConnectCredentials } from '../types';

vi.mock('../client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../client')>();
  return {
    ...original,
    appleApiRequest: vi.fn(),
    getAppIdForBundleId: vi.fn(),
  };
});

const credentials = {} as AppleConnectCredentials;

describe('getAppPrices', () => {
  beforeEach(() => {
    vi.mocked(appleApiRequest).mockReset();
    vi.mocked(getAppIdForBundleId).mockReset();
    vi.mocked(getAppIdForBundleId).mockResolvedValue('6796097644');
  });

  it('treats Apple null-resource price collections as an empty free-app schedule', async () => {
    vi.mocked(appleApiRequest).mockImplementation(
      async (_credentials, endpoint) => {
        if (endpoint === '/apps/6796097644/appPriceSchedule') {
          return {
            data: {
              id: '6796097644',
              type: 'appPriceSchedules',
              relationships: {
                baseTerritory: {
                  data: { id: 'IND', type: 'territories' },
                },
              },
            },
          };
        }

        throw new AppleApiError(
          404,
          'NOT_FOUND',
          'The specified resource does not exist',
          "There is no resource of type 'null' with id '6796097644'"
        );
      }
    );

    await expect(getAppPrices(credentials)).resolves.toEqual({
      manual: {},
      automatic: {},
      baseTerritory: 'IND',
    });
  });

  it('does not hide unrelated Apple API failures', async () => {
    vi.mocked(appleApiRequest).mockImplementation(
      async (_credentials, endpoint) => {
        if (endpoint === '/apps/6796097644/appPriceSchedule') {
          return {
            data: {
              id: '6796097644',
              type: 'appPriceSchedules',
              relationships: {
                baseTerritory: {
                  data: { id: 'IND', type: 'territories' },
                },
              },
            },
          };
        }

        throw new AppleApiError(
          403,
          'FORBIDDEN_ERROR',
          'Forbidden',
          'The API key cannot access app pricing.'
        );
      }
    );

    await expect(getAppPrices(credentials)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN_ERROR',
    });
  });
});
