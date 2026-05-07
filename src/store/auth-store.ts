import { useState, useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Platform = 'google' | 'apple' | null;

interface GoogleAuthData {
  packageName: string;
  projectId: string;
  clientEmail: string;
}

interface AppleAuthData {
  bundleId: string | null;
  keyId: string;
  issuerId: string;
}

export interface GoogleAppHistoryEntry {
  packageName: string;
  projectId: string;
  clientEmail: string;
  addedAt: number; // unix ms
}

interface AuthState {
  // Current active platform
  platform: Platform;

  // Google Play auth data
  isGoogleAuthenticated: boolean;
  packageName: string | null;
  projectId: string | null;
  clientEmail: string | null;

  // Apple App Store auth data
  isAppleAuthenticated: boolean;
  bundleId: string | null;
  keyId: string | null;
  issuerId: string | null;
  appleBaseCountry: string;

  // Google app history (multi-app switcher)
  googleAppHistory: GoogleAppHistoryEntry[];

  // Legacy compatibility - returns true if any platform is authenticated
  isAuthenticated: boolean;

  // Actions
  setGoogleAuthenticated: (data: GoogleAuthData) => void;
  setAppleAuthenticated: (data: AppleAuthData) => void;
  setPlatform: (platform: Platform) => void;
  clearGoogleAuth: () => void;
  clearAppleAuth: () => void;
  clearAuth: () => void;
  setAppleBaseCountry: (country: string) => void;

  addGoogleAppToHistory: (entry: Omit<GoogleAppHistoryEntry, 'addedAt'>) => void;
  removeGoogleAppFromHistory: (packageName: string, clientEmail: string) => void;

  setActivePackageName: (packageName: string) => void;
  setActiveBundleId: (bundleId: string) => void;

  // Legacy compatibility
  setAuthenticated: (packageName: string, projectId: string, clientEmail: string) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      // Current platform
      platform: null,

      // Google auth state
      isGoogleAuthenticated: false,
      packageName: null,
      projectId: null,
      clientEmail: null,

      // Apple auth state
      isAppleAuthenticated: false,
      bundleId: null,
      keyId: null,
      issuerId: null,
      appleBaseCountry: 'US',

      googleAppHistory: [],

      // Legacy compatibility - computed in each action
      isAuthenticated: false,

      // Set Google authentication
      setGoogleAuthenticated: ({ packageName, projectId, clientEmail }) =>
        set((state) => {
          const filtered = state.googleAppHistory.filter(
            (entry) =>
              !(
                entry.packageName === packageName &&
                entry.clientEmail === clientEmail
              )
          );
          return {
            isGoogleAuthenticated: true,
            isAuthenticated: true,
            packageName,
            projectId,
            clientEmail,
            platform: state.platform ?? 'google',
            googleAppHistory: [
              ...filtered,
              {
                packageName,
                projectId,
                clientEmail,
                addedAt: Date.now(),
              },
            ],
          };
        }),

      // Set Apple authentication
      setAppleAuthenticated: ({ bundleId, keyId, issuerId }) =>
        set((state) => ({
          isAppleAuthenticated: true,
          isAuthenticated: true,
          bundleId,
          keyId,
          issuerId,
          // Auto-switch to Apple if no platform selected
          platform: state.platform ?? 'apple',
        })),

      // Switch active platform
      setPlatform: (platform) => set({ platform }),

      // Clear Google auth
      clearGoogleAuth: () =>
        set((state) => ({
          isGoogleAuthenticated: false,
          packageName: null,
          projectId: null,
          clientEmail: null,
          // Update isAuthenticated based on remaining auth
          isAuthenticated: state.isAppleAuthenticated,
          // Switch to Apple if it's authenticated, otherwise null
          platform: state.platform === 'google'
            ? state.isAppleAuthenticated ? 'apple' : null
            : state.platform,
        })),

      // Clear Apple auth
      clearAppleAuth: () =>
        set((state) => ({
          isAppleAuthenticated: false,
          bundleId: null,
          keyId: null,
          issuerId: null,
          // Update isAuthenticated based on remaining auth
          isAuthenticated: state.isGoogleAuthenticated,
          // Switch to Google if it's authenticated, otherwise null
          platform: state.platform === 'apple'
            ? state.isGoogleAuthenticated ? 'google' : null
            : state.platform,
        })),

      // Clear all auth
      clearAuth: () =>
        set({
          platform: null,
          isGoogleAuthenticated: false,
          isAppleAuthenticated: false,
          isAuthenticated: false,
          packageName: null,
          projectId: null,
          clientEmail: null,
          bundleId: null,
          keyId: null,
          issuerId: null,
        }),

      // Legacy compatibility - maps to setGoogleAuthenticated
      setAuthenticated: (packageName, projectId, clientEmail) =>
        set((state) => ({
          isGoogleAuthenticated: true,
          isAuthenticated: true,
          packageName,
          projectId,
          clientEmail,
          platform: state.platform ?? 'google',
        })),

      // Set Apple base country for price display
      setAppleBaseCountry: (country) => set({ appleBaseCountry: country }),

      addGoogleAppToHistory: ({ packageName, projectId, clientEmail }) =>
        set((state) => {
          const filtered = state.googleAppHistory.filter(
            (entry) =>
              !(
                entry.packageName === packageName &&
                entry.clientEmail === clientEmail
              )
          );
          return {
            googleAppHistory: [
              ...filtered,
              {
                packageName,
                projectId,
                clientEmail,
                addedAt: Date.now(),
              },
            ],
          };
        }),

      removeGoogleAppFromHistory: (packageName, clientEmail) =>
        set((state) => ({
          googleAppHistory: state.googleAppHistory.filter(
            (entry) =>
              !(
                entry.packageName === packageName &&
                entry.clientEmail === clientEmail
              )
          ),
        })),

      setActivePackageName: (packageName) =>
        set({ packageName }),

      setActiveBundleId: (bundleId) =>
        set({ bundleId }),
    }),
    {
      name: 'auth-storage',
    }
  )
);

export const useHasHydrated = () => {
  const [hasHydrated, setHasHydrated] = useState(
    useAuthStore.persist?.hasHydrated() ?? false
  );

  useEffect(() => {
    const unsub = useAuthStore.persist?.onFinishHydration(() =>
      setHasHydrated(true)
    );
    return unsub;
  }, []);

  return hasHydrated;
};
