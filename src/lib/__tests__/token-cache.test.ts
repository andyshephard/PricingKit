import { describe, it, expect, vi, afterEach } from 'vitest';
import { TokenCache, TOKEN_CACHE_MAX_ENTRIES, hashCredentialFields } from '../token-cache';

const FAR_FUTURE = () => Math.floor(Date.now() / 1000) + 3600;

describe('hashCredentialFields', () => {
  it('is stable for the same fields', async () => {
    const a = await hashCredentialFields(['kid', 'iss', 'key']);
    const b = await hashCredentialFields(['kid', 'iss', 'key']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when only the private key changes', async () => {
    const a = await hashCredentialFields(['kid', 'iss', 'key-A']);
    const b = await hashCredentialFields(['kid', 'iss', 'key-B']);
    expect(a).not.toBe(b);
  });

  it('does not collide when field boundaries shift', async () => {
    const a = await hashCredentialFields(['ab', 'c']);
    const b = await hashCredentialFields(['a', 'bc']);
    expect(a).not.toBe(b);
  });
});

describe('TokenCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a cached token until it is within the refresh margin', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cache = new TokenCache();
    const now = Math.floor(Date.now() / 1000);
    cache.set('k', { token: 't', expiresAt: now + 120 });

    expect(cache.get('k', 60)).toBe('t');

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect(cache.get('k', 60)).toBeNull();
    expect(cache.has('k')).toBe(false);
  });

  it(`is bounded to ${TOKEN_CACHE_MAX_ENTRIES} entries by default`, () => {
    const cache = new TokenCache();
    for (let i = 0; i < TOKEN_CACHE_MAX_ENTRIES + 10; i++) {
      cache.set(`k${i}`, { token: `t${i}`, expiresAt: FAR_FUTURE() });
    }
    expect(cache.size).toBe(TOKEN_CACHE_MAX_ENTRIES);
    // Oldest 10 were evicted
    expect(cache.has('k0')).toBe(false);
    expect(cache.has('k9')).toBe(false);
    expect(cache.has('k10')).toBe(true);
  });

  it('evicts the least recently used entry, not the oldest inserted', () => {
    const cache = new TokenCache(3);
    cache.set('a', { token: 'A', expiresAt: FAR_FUTURE() });
    cache.set('b', { token: 'B', expiresAt: FAR_FUTURE() });
    cache.set('c', { token: 'C', expiresAt: FAR_FUTURE() });

    // Touch 'a' so 'b' becomes least recently used
    expect(cache.get('a', 60)).toBe('A');
    cache.set('d', { token: 'D', expiresAt: FAR_FUTURE() });

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });
});
