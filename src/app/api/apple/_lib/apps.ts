import { appleApiRequest } from '@/lib/apple-connect/client';
import type { AppleApiListResponse, AppleConnection } from '@/lib/apple-connect/types';

interface AppleAppListItem {
  id: string;
  type: 'apps';
  attributes: {
    name: string;
    bundleId: string;
    sku?: string;
  };
}

export interface AppleAppSummary {
  id: string;
  name: string;
  bundleId: string;
  sku: string | null;
}

/** The apps this App Store Connect key can see (one read-only call, up to 200) */
export async function listAppleApps(connection: AppleConnection): Promise<AppleAppSummary[]> {
  const response = await appleApiRequest<AppleApiListResponse<AppleAppListItem>>(connection, '/apps', {
    queryParams: {
      'fields[apps]': 'name,bundleId,sku',
      limit: '200',
    },
  });
  return (response.data ?? []).map((app) => ({
    id: app.id,
    name: app.attributes.name,
    bundleId: app.attributes.bundleId,
    sku: app.attributes.sku ?? null,
  }));
}
