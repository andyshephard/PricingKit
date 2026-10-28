// Browser wiring: the one BrowserKeys instance, saved preferences, and the
// apiFetch every page and hook uses for /api calls.

import { BrowserKeys, type KeyPlatform } from '@/lib/browser-keys';
import { useAuthStore } from '@/store/auth-store';
import { createApiFetch, type ApiFetchInit } from './api-fetch';

let keys: BrowserKeys | null = null;

/** The browser's store keys (IndexedDB). One instance per page, so tokens are shared. */
export function browserKeys(): BrowserKeys {
  if (!keys) keys = new BrowserKeys();
  return keys;
}

// ---------------------------------------------------------------------------
// Preferences in localStorage. Storage can be unavailable (private windows,
// blocked site data), so every access is guarded and failures read as unset.

const OER_KEY_STORAGE = 'pricingkit.oerKey';

function readStorage(name: string): string | null {
  try {
    return window.localStorage.getItem(name);
  } catch {
    return null;
  }
}

function writeStorage(name: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, value);
    return true;
  } catch {
    return false;
  }
}

/** The user's own Open Exchange Rates app ID, if saved in this browser */
export function getOerKey(): string | null {
  return readStorage(OER_KEY_STORAGE);
}

/** Save (or with null, remove) the Open Exchange Rates app ID; false when storage is unavailable */
export function setOerKey(value: string | null): boolean {
  return writeStorage(OER_KEY_STORAGE, value);
}

// ---------------------------------------------------------------------------

/** Fired when a store keeps refusing this browser's token, or no key is stored; the dialog in Providers listens */
export const AUTH_ERROR_EVENT = 'auth:unauthorized';

function onAuthFailure(platform: KeyPlatform): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AUTH_ERROR_EVENT, { detail: { platform } }));
}

const fetchWithKeys = createApiFetch({
  keys: browserKeys,
  fetch: (input, init) => fetch(input, init),
  activeApp: (platform) => {
    const state = useAuthStore.getState();
    return platform === 'apple' ? state.bundleId : state.packageName;
  },
  activePlatform: () => useAuthStore.getState().platform,
  oerKey: getOerKey,
  onAuthFailure,
});

/** fetch() for this app's /api routes, with the headers each route needs (see api-fetch.ts) */
export function apiFetch(input: string, init?: ApiFetchInit): Promise<Response> {
  return fetchWithKeys(input, init);
}

/**
 * Sign out on this browser: delete both stored keys and their tokens. Throws
 * if the keys could not be deleted (they are still stored); callers must say so.
 */
export async function forgetAllKeys(): Promise<void> {
  await browserKeys().forgetAll();
}
