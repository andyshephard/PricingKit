import { describe, it, expect } from 'vitest';
import { AttemptLimiter, clientKeyFromHeaders } from '../attempt-limiter';

describe('AttemptLimiter', () => {
  it('allows `limit` attempts per key per window, then reports Retry-After', () => {
    let now = 0;
    const limiter = new AttemptLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    expect(limiter.attempt('a').allowed).toBe(true);
    expect(limiter.attempt('a').allowed).toBe(true);
    expect(limiter.attempt('a')).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.attempt('b').allowed).toBe(true);
    now = 30_000;
    expect(limiter.attempt('a')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    now = 60_000;
    expect(limiter.attempt('a').allowed).toBe(true);
  });

  it('enforces a global cap across keys', () => {
    const limiter = new AttemptLimiter({ limit: 10, globalLimit: 3, windowMs: 1000, now: () => 0 });
    expect(['a', 'b', 'c'].map((k) => limiter.attempt(k).allowed)).toEqual([true, true, true]);
    expect(limiter.attempt('d').allowed).toBe(false);
  });

  it('caps the number of tracked keys', () => {
    const limiter = new AttemptLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, now: () => 0 });
    limiter.attempt('a');
    limiter.attempt('b');
    limiter.attempt('c'); // evicts 'a'
    expect(limiter.attempt('a').allowed).toBe(true);
  });
});

describe('clientKeyFromHeaders', () => {
  it('prefers Cloudflare, then the first forwarded address', () => {
    expect(clientKeyFromHeaders(new Headers({ 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '198.51.100.1' }))).toBe('203.0.113.1');
    expect(clientKeyFromHeaders(new Headers({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }))).toBe('198.51.100.1');
    expect(clientKeyFromHeaders(new Headers())).toBe('unknown');
  });
});
