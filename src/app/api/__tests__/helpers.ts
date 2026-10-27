// Minimal stand-in for next/headers' cookie store, for route handler tests.
// A cookie set with maxAge 0 (how src/lib/session.ts expires one) is removed.
export function createCookieStore(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  return {
    jar,
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  };
}

export type TestCookieStore = ReturnType<typeof createCookieStore>;

/** A valid ENCRYPTION_KEY for tests: base64 of 32 bytes */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/** A session cookie value as the login routes write it */
export async function sessionCookieValue(kind: 'google' | 'apple', credentials: unknown): Promise<string> {
  const { sealSession } = await import('@/lib/session-envelope');
  return (await sealSession(kind, credentials)).value;
}
