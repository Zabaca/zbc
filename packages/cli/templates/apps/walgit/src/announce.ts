/**
 * Telling subscribers that a push landed.
 *
 * The rule this file exists to keep: an announcement is published only after
 * the push is durable. `reference-transaction prepared` is where the
 * compare-and-swap on `index.json` happens, and a push that loses it is
 * rejected — git never runs `post-receive` for it — so announcing from
 * `post-receive` means a client can never be told about a push that then lost.
 * That is the ordering docs/adr/0007 makes load-bearing, reused rather than
 * re-derived.
 *
 * The other rule: this must never be able to fail a push. `post-receive` runs
 * after the ref transaction has committed, so nothing it does can unmake the
 * push — and every failure here is caught, logged and swallowed. A subscriber
 * that misses an announcement is a subscriber that learns the state on its next
 * handshake; a push that failed because a notification could not be delivered
 * would be a git host that stops working when a side channel does.
 *
 * The wire types and the change-to-event mapping come from `worker/events.ts`,
 * which is where the protocol lives — one definition, so the two ends cannot
 * disagree about what a deletion looks like.
 */

import { eventsFromChanges } from '../worker/events'
import type { RefChange } from './wal-index'

export interface AnnounceConfig {
  /** The deployment's own public origin — the Worker in front of this container. */
  url: string
  /** The shared secret proving this is walgit's push path (`WALGIT_EVENTS_TOKEN`). */
  token: string
}

/**
 * How long the push path will wait for the announcement to be accepted.
 *
 * Bounded because `post-receive` holds the client's connection open until it
 * exits: an unreachable endpoint must cost the pusher a couple of seconds at
 * the very worst, not a hung push. Short enough to be invisible next to the
 * pack upload that preceded it.
 */
const ANNOUNCE_TIMEOUT_MS = 2_000

/**
 * The stream's configuration, or null when this deployment has none.
 *
 * Both halves are required: a URL without a secret would be rejected at the
 * door, and a secret without a URL has nowhere to go. Off unless configured,
 * like every other optional policy here.
 */
export function announceConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AnnounceConfig | null {
  const url = (env.WALGIT_EVENTS_URL ?? '').trim()
  const token = (env.WALGIT_EVENTS_TOKEN ?? '').trim()
  if (!url || !token) return null
  return { url: url.replace(/\/+$/, ''), token }
}

/**
 * Publish one push's ref changes. Never throws.
 *
 * `fetchImpl` is injected for the same reason `runBackend` is in src/http.ts:
 * the decision to announce, and the shape of what is announced, are testable
 * without a network.
 */
export async function announce(
  config: AnnounceConfig,
  repoId: string,
  changes: readonly RefChange[],
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const events = eventsFromChanges(repoId, changes)
  if (events.length === 0) return false
  try {
    const response = await fetchImpl(`${config.url}/_walgit/announce`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(ANNOUNCE_TIMEOUT_MS),
    })
    if (!response.ok) {
      // Logged rather than retried: the push is already acknowledged, and the
      // state the announcement carries is in `index.json` regardless — a
      // subscriber's next handshake reads it there.
      process.stderr.write(`walgit: ref-event announce refused (${response.status})\n`)
      return false
    }
    return true
  } catch (err) {
    process.stderr.write(`walgit: ref-event announce failed: ${(err as Error).message}\n`)
    return false
  }
}
