/**
 * How long the container stays up after the last request it served.
 *
 * Every request that reaches the container buys this much container time, so
 * on a quiet deployment it is most of the bill. The Durable Object in front of
 * it no longer pays the same: it sleeps between requests and wakes once, on an
 * alarm, to stop the container (`WalgitDurableContainer`, worker/durable-container.ts).
 * Shorter costs cold starts instead: the first request after a sleep waits for
 * boot, then for its repository to be materialized from the log — or, with
 * `WALGIT_SNAPSHOTS` on, for a re-sync against a restored disk. Which trade is
 * right depends on the traffic, so it is the instance's choice
 * (`WALGIT_SLEEP_AFTER`), and the default is the cautious one.
 *
 * Edge-only: the Durable Object reads it and the container never needs to, so
 * it is not on `CONTAINER_ENV` and changing it restarts nothing.
 */
export const DEFAULT_SLEEP_AFTER = '20m'

/**
 * A number and one unit — the syntax `@cloudflare/containers` read when its
 * `Container` class ran the idle stop. Kept after the class went, because it
 * is instance configuration: a deployment that wrote `5m` must not have to
 * learn a second spelling for the same knob.
 */
const DURATION = /^[1-9][0-9]*(s|m|h)$/

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 } as const

/** A value that does not parse is ignored for the default, not obeyed. */
export function sleepAfterFrom(env: { WALGIT_SLEEP_AFTER?: string }): string {
  const value = (env.WALGIT_SLEEP_AFTER ?? '').trim()
  return DURATION.test(value) ? value : DEFAULT_SLEEP_AFTER
}

/**
 * The same choice, in milliseconds — what the Durable Object's alarm is armed
 * with. Derived from `sleepAfterFrom` rather than parsed beside it, so the two
 * cannot accept different spellings.
 */
export function sleepAfterMsFrom(env: { WALGIT_SLEEP_AFTER?: string }): number {
  const value = sleepAfterFrom(env)
  const unit = value.slice(-1) as keyof typeof UNIT_MS
  return Number(value.slice(0, -1)) * UNIT_MS[unit]
}
