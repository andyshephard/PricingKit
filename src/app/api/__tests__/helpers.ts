// Minimal stand-in for next/headers' cookie store, for route handler tests.
export function createCookieStore(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  return {
    jar,
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  };
}

export type TestCookieStore = ReturnType<typeof createCookieStore>;
