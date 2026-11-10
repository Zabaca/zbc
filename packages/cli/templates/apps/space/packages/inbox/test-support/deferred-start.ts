/**
 * A Durable Object context's `blockConcurrencyWhile` as workerd runs it: the callback is called AFTER the constructor has returned (not inside it), and the object takes no request until it is done. A fake that calls the callback at
 * once hides every start-up that reads the store in the constructor body, which in workerd runs before the migrations (proved under miniflare 4.20260714: `no such table` and a constructor that throws on every start).
 *
 * `started()` is what a test awaits after constructing the object, as the runtime holds its first request.
 */
export function deferredStart() {
  const pending: Promise<unknown>[] = []
  return {
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = Promise.resolve().then(fn)
      pending.push(run)
      return run
    },
    started: async (): Promise<void> => {
      await Promise.all(pending)
    },
  }
}
