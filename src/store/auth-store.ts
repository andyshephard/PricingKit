import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Platform = 'google' | 'apple' | null;

interface GoogleAuthData {
  packageName: string;
  projectId: string;
  clientEmail: string;
}

interface AppleAuthData {
  bundleId: string;
  keyId: string;
  issuerId: string;
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

  // Legacy compatibility
  setAuthenticated: (packageName: string, projectId: string, clientEmail: string) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
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

      // Legacy compatibility - computed in each action
      isAuthenticated: false,

      // Set Google authentication
      setGoogleAuthenticated: ({ packageName, projectId, clientEmail }) =>
        set((state) => ({
          isGoogleAuthenticated: true,
          isAuthenticated: true,
          packageName,
          projectId,
          clientEmail,
          // Auto-switch to Google if no platform selected
          platform: state.platform ?? 'google',
        })),

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
    }),
    {
      name: 'auth-storage',
    }
  )
);
