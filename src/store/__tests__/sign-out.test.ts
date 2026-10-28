import { describe, it, expect, vi } from 'vitest';

describe('auth store sign-out', () => {
  it('clears the app history and base country as well as the connection state; clearAuth keeps them', async () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    const { useAuthStore } = await import('../auth-store');
    const store = useAuthStore.getState();
    store.setGoogleAuthenticated({ packageName: 'com.example.app', projectId: 'p', clientEmail: 'robot@p.iam.gserviceaccount.com' });
    store.setAppleAuthenticated({ bundleId: 'com.example.ios', keyId: 'ABC123DEF4', issuerId: 'issuer' });
    store.setAppleBaseCountry('GB');

    useAuthStore.getState().clearAuth();
    expect(useAuthStore.getState()).toMatchObject({ isGoogleAuthenticated: false, bundleId: null, appleBaseCountry: 'GB' });
    expect(useAuthStore.getState().googleAppHistory).toHaveLength(1);

    useAuthStore.getState().signOut();
    expect(useAuthStore.getState()).toMatchObject({
      platform: null,
      isGoogleAuthenticated: false,
      isAppleAuthenticated: false,
      packageName: null,
      bundleId: null,
      keyId: null,
      clientEmail: null,
      googleAppHistory: [],
      appleBaseCountry: 'US',
      appleProductBaseTerritories: {},
    });
    // And what is persisted in localStorage
    expect(JSON.parse(data.get('auth-storage')!).state).toMatchObject({ googleAppHistory: [], appleBaseCountry: 'US', packageName: null });
    vi.unstubAllGlobals();
  });
});
