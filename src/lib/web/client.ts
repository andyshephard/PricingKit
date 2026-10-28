// Browser wiring: the one BrowserKeys instance, saved preferences, and the
// apiFetch every page and hook uses for /api calls.

import { BrowserKeys, type KeyPlatform } from '@/lib/browser-keys';
import { useAuthStore } from '@/store/auth-store';
import { createApiFetch, type ApiFetch, type ApiFetchDeps, type ApiFetchInit, type TokenProvider } from './api-fetch';
import type { ConnectDeps } from './connect';
import { connectKeyChannel, openKeyChannel } from './key-channel';

let keys: BrowserKeys | null = null;

/** Another tab forgot a key or signed out: this tab follows */
function otherTabSignedOut(platform: KeyPlatform | 'all'): void {
  const store = useAuthStore.getState();
  if (platform === 'all') store.signOut();
  else if (platform === 'apple') store.clearAppleAuth();
  else store.clearGoogleAuth();
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  const inApp = path.startsWith('/dashboard') || path.startsWith('/setup/apple');
  const { isAppleAuthenticated, isGoogleAuthenticated } = useAuthStore.getState();
  if (!inApp) return;
  // A full page load on purpose: it also drops this tab's cached store data (React Query)
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  if (!isAppleAuthenticated && !isGoogleAuthenticated) window.location.assign('/setup');
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  else if (platform !== 'all' && path.startsWith(`/dashboard/${platform}`)) window.location.assign('/dashboard');
}

/**
 * The browser's store keys (IndexedDB). One instance per page, so tokens are
 * shared; other tabs hear about saves and forgets (key-channel.ts).
 */
export function browserKeys(): BrowserKeys {
  if (!keys) {
    const onChange = connectKeyChannel(openKeyChannel(), {
      dropCached: (platform) => keys?.dropCached(platform),
      signedOut: otherTabSignedOut,
    });
    keys = new BrowserKeys({ onChange });
  }
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

const baseDeps: Omit<ApiFetchDeps, 'keys'> = {
  fetch: (input, init) => fetch(input, init),
  activeApp: (platform) => {
    const state = useAuthStore.getState();
    return platform === 'apple' ? state.bundleId : state.packageName;
  },
  activePlatform: () => useAuthStore.getState().platform,
  oerKey: getOerKey,
  onAuthFailure,
};

const fetchWithKeys = createApiFetch({ ...baseDeps, keys: browserKeys });

/** An apiFetch signing with other keys (a staged key being proved); never opens the Connect prompt */
export function apiFetchWith(keys: TokenProvider): ApiFetch {
  return createApiFetch({ ...baseDeps, keys: () => keys, onAuthFailure: () => {} });
}

/** What the connect flow needs: the real key store, and apiFetch for a staged key */
export function connectDeps(): ConnectDeps {
  return { keys: browserKeys(), apiFetchWith };
}

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
