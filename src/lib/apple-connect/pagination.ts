// One pagination loop for App Store Connect list endpoints.
//
// Apple returns `links.next` as an absolute URL that already carries every
// query parameter (including the cursor). The first request uses the caller's
// queryParams; every later request follows `links.next` exactly.

import type { AppleApiListResponse, AppleConnection, AppleIncludedItem } from './types';
import { appleApiRequest, type AppleApiRequestOptions } from './client';
import { ApiError } from '../utils/api-error';

export const DEFAULT_APPLE_MAX_PAGES = 100;

export interface AppleListOptions
  extends Pick<AppleApiRequestOptions, 'apiVersion' | 'budget' | 'retry' | 'onRateLimit'> {
  queryParams?: Record<string, string>;
  /** Stop with an error after this many pages (default 100); never return a silently truncated list */
  maxPages?: number;
}

/**
 * Turn an absolute `links.next` URL into an endpoint for appleApiRequest:
 * strip the host and the /v1 or /v2 prefix, keep the query string.
 */
export function appleNextLinkToEndpoint(next: string): { endpoint: string; apiVersion?: 'v1' | 'v2' } {
  if (!next.startsWith('http')) return { endpoint: next };
  const url = new URL(next);
  const match = /^\/(v[12])(\/.*)$/.exec(url.pathname);
  if (!match) return { endpoint: `${url.pathname}${url.search}` };
  return { endpoint: `${match[2]}${url.search}`, apiVersion: match[1] as 'v1' | 'v2' };
}

/** Yield every page of an Apple list endpoint, following links.next. */
export async function* appleListPages<T>(
  connection: AppleConnection,
  path: string,
  options: AppleListOptions = {}
): AsyncGenerator<AppleApiListResponse<T>> {
  const { queryParams, maxPages = DEFAULT_APPLE_MAX_PAGES, ...requestOptions } = options;
  const seen = new Set<string>();
  let next: string | undefined = path;
  let first = true;
  let pages = 0;

  while (next) {
    if (seen.has(next)) return; // Apple repeated a link: nothing new to read
    seen.add(next);
    if (++pages > maxPages) {
      throw new ApiError(`Stopped reading ${path} after ${maxPages} pages`, {
        status: 502,
        code: 'PAGINATION_LIMIT',
        platform: 'apple',
        retryable: false,
      });
    }

    const { endpoint, apiVersion } = first ? { endpoint: next, apiVersion: undefined } : appleNextLinkToEndpoint(next);
    const response: AppleApiListResponse<T> = await appleApiRequest<AppleApiListResponse<T>>(
      connection,
      endpoint,
      {
        ...requestOptions,
        ...(apiVersion ? { apiVersion } : {}),
        queryParams: first ? queryParams : undefined,
      }
    );
    first = false;
    yield response;
    next = response.links?.next ?? undefined;
  }
}

/** Read every page and merge `data` and `included`. */
export async function appleListAll<T>(
  connection: AppleConnection,
  path: string,
  options: AppleListOptions = {}
): Promise<{ data: T[]; included: AppleIncludedItem[] }> {
  const data: T[] = [];
  const included: AppleIncludedItem[] = [];
  for await (const page of appleListPages<T>(connection, path, options)) {
    data.push(...(page.data ?? []));
    if (page.included) included.push(...page.included);
  }
  return { data, included };
}
