/**
 * Run `fn` over `items` with at most `limit` calls in flight at once.
 * Results are returned in input order. One rejecting item does not abort the
 * rest — every item runs; the lowest-index rejection is rethrown once all
 * have settled (its result slot is left empty).
 *
 * Used to parallelize GLB template fetches that were previously awaited one
 * at a time — a single serial chain turns a high-latency client's object
 * load from minutes into seconds.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  const max = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let firstErrorIndex = Infinity;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (i < firstErrorIndex) {
          firstErrorIndex = i;
          firstError = e;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: max }, () => worker()));
  if (firstErrorIndex !== Infinity) throw firstError;
  return results;
}
