// Bounded-concurrency map. Framework-free; used by the executor and by store
// helpers that would otherwise fire an unbounded Promise.all.

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Results keep the
 * input order. On the first rejection no new calls start; the in-flight ones
 * are allowed to settle, then the first error is thrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => worker()));
  if (failed) throw firstError;
  return results;
}
