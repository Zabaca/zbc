#!/usr/bin/env bun
/**
 * The detached ref-event announcer.
 *
 * A separate process, spawned and disowned by `post-receive`, for the same
 * reason `compact-main.ts` is: `post-receive` holds the client's connection
 * open until it exits, so anything awaited in there lands as push latency. An
 * announcement is a network call to the fan-out, and a fan-out that is slow or
 * unreachable would otherwise cost the pusher up to the announce timeout — on
 * the one path this project promises to keep fast, for a feature whose entire
 * purpose is to stop clients spending time on staleness.
 *
 * Failures are logged and swallowed, and there is nothing to retry: the push is
 * already durable and `index.json` already carries the refs this would have
 * announced, so a subscriber's next handshake reads the truth from there
 * regardless. A dropped announcement costs one subscriber one push of
 * freshness, never correctness.
 */

import { announce, announceConfigFromEnv } from './announce'
import type { RefChange } from './wal-index'

const repoId = process.argv[2]
const payload = process.argv[3]
/**
 * What each moved branch merged (docs/adr/0018), computed by `post-receive`
 * where the Cache is and passed down as a third JSON argument. Omitted by a
 * deployment not taking Proposals, and by any caller from before this existed.
 */
const mergedPayload = process.argv[4]

async function main(): Promise<void> {
  if (!repoId || !payload)
    throw new Error('usage: announce-main <repo-id> <changes-json> [merged-json]')
  const config = announceConfigFromEnv()
  // Not an error: the environment can change between the spawn and the start,
  // and a deployment with no stream configured simply has nothing to tell.
  if (!config) return
  const merged = mergedPayload ? (JSON.parse(mergedPayload) as Record<string, string[]>) : {}
  await announce(config, repoId, JSON.parse(payload) as RefChange[], fetch, merged)
}

main().catch((err) => {
  process.stderr.write(`walgit: ref-event announce failed: ${(err as Error).message}\n`)
})
