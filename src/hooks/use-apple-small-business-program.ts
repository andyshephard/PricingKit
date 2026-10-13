'use client';

import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'pricingkit.apple.small-business-program';
const CHANGE_EVENT = 'pricingkit:apple-small-business-program-change';

function subscribe(onStoreChange: () => void) {
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(CHANGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
  };
}

function getSnapshot(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function getServerSnapshot(): boolean {
  return false;
}

export function useAppleSmallBusinessProgram() {
  const enabled = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  const setEnabled = useCallback((value: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } catch {
      // Ignore persistence failures.
    }
  }, []);

  return [enabled, setEnabled] as const;
}
