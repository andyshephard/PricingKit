'use client';

import { useSyncExternalStore } from 'react';
import { THEME_STORAGE_KEY, type ThemeChoice } from './theme-script';

const listeners = new Set<() => void>();

function readStored(): ThemeChoice | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(theme: ThemeChoice) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

function emit() {
  for (const listener of listeners) listener();
}

/** Re-reads the stored choice (or the system setting) and applies it. */
function sync() {
  apply(readStored() ?? (systemPrefersDark() ? 'dark' : 'light'));
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', sync);
    window.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.matchMedia?.('(prefers-color-scheme: dark)').removeEventListener?.('change', sync);
      window.removeEventListener('storage', onStorage);
    }
  };
}

function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === THEME_STORAGE_KEY) sync();
}

function getSnapshot(): ThemeChoice {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function getServerSnapshot(): ThemeChoice | null {
  return null;
}

/** Remembers the choice (when storage is available) and applies it. */
export function setTheme(theme: ThemeChoice) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked: the choice still applies to this page.
  }
  apply(theme);
  emit();
}

/**
 * The theme in effect. It is null during server rendering and hydration, so
 * markup that depends on it does not mismatch; it settles on the next render.
 */
export function useResolvedTheme(): ThemeChoice | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
