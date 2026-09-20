/**
 * Run a task over a list with a bounded number in flight.
 *
 * It lives in the Shared Kernel because both halves fan out over the same
 * thing — one `index.json` per repository — and neither may own the pool:
 * `src/usage.ts` reads every Index to report what the bucket holds, and
 * `shared/repo-list.ts` reads a page of them at the edge to render the list
 * (docs/adr/0010). It was written twice, docstring included, which is exactly
 * the drift that ADR keeps naming: nothing here touches a runtime, so there is
 * no reason for a second copy.
 *
 * Bounded rather than `Promise.all` over everything: a thousand simultaneous
 * GETs against the object store is a burst that gets a deployment rate-limited
 * for a read-only page.
 *
 * Order is the INPUT's, not completion order — every caller here pairs results
 * back up with the names it asked about.
 */
export async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await task(items[i]!)
  })
  await Promise.all(workers)
  return results
}
