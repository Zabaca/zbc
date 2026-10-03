/**
 * How long the container stays up after the last request it served.
 *
 * Every request that reaches the container buys this much awake time — the
 * container and the Durable Object in front of it — so on a quiet deployment it
 * is most of the bill. Shorter costs cold starts instead: the first request
 * after a sleep waits for boot, then for its repository to be materialized from
 * the log. Which trade is right depends on the traffic, so it is the
 * instance's choice (`WALGIT_SLEEP_AFTER`), and the default is the cautious one.
 *
 * Edge-only: the Durable Object reads it and the container never needs to, so
 * it is not on `CONTAINER_ENV` and changing it restarts nothing.
 */
export const DEFAULT_SLEEP_AFTER = '20m'

/** `@cloudflare/containers`' duration syntax: a number and one unit. */
const DURATION = /^[1-9][0-9]*(s|m|h)$/

/** A value the library would misread is ignored for the default, not obeyed. */
export function sleepAfterFrom(env: { WALGIT_SLEEP_AFTER?: string }): string {
  const value = (env.WALGIT_SLEEP_AFTER ?? '').trim()
  return DURATION.test(value) ? value : DEFAULT_SLEEP_AFTER
}
