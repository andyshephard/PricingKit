// In-memory cache for short-lived API tokens (Apple JWTs, Google access tokens).
//
// Shared hosted instances serve many users from one process, so entries are keyed
// on a SHA-256 of the full credential (including the private key). Two credentials
// that share a key ID / client email but carry different private keys never share
// a token. Uses Web Crypto so it works on Node.js and Cloudflare Workers.

export const TOKEN_CACHE_MAX_ENTRIES = 50;

export interface CachedToken {
  token: string;
  expiresAt: number; // unix seconds
}

/**
 * Hash the given credential fields into a cache key. Fields are JSON-encoded as an
 * array so field boundaries can't be shifted to produce a collision.
 */
export async function hashCredentialFields(fields: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(fields))
  );
  return Buffer.from(digest).toString('hex');
}

/**
 * Small LRU keyed by credential hash. Map preserves insertion order, so the first
 * key is always the least recently used.
 */
export class TokenCache {
  private entries = new Map<string, CachedToken>();

  constructor(private readonly maxEntries = TOKEN_CACHE_MAX_ENTRIES) {}

  /** Returns the token if it is still valid for at least `marginSeconds`. */
  get(key: string, marginSeconds: number): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt - now <= marginSeconds) {
      this.entries.delete(key);
      return null;
    }

    // Refresh recency
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.token;
  }

  set(key: string, entry: CachedToken): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
