#!/usr/bin/env bun
/**
 * The smart-HTTP process — the only front door, and the container's only
 * process.
 *
 * It serves the bare repos under WALGIT_REPOS_DIR and goes through src/repo.ts
 * to decide which repo a request means. There used to be a second door (sshd
 * running a forced command), which is what put walgit on a Fly machine with a
 * dedicated IPv4: SSH needs raw inbound TCP. Dropping it is what let the app
 * move onto a Cloudflare Container, where the Worker in worker/index.ts proxies
 * straight to this port.
 */

import { capabilitiesFrom } from '../shared/capabilities'
import { parseTokens } from '../shared/credentials'
import { ensureBareRepo } from './cache'
import { configuredExpiryMs, expireRepos } from './expire'
import { createHttpHandler } from './http'
import { runGitHttpBackend } from './git-backend'
import type { ObjectStore } from './store'
import { storeFromEnv } from './store-env'
import { syncRepo } from './sync'
import { loadIndex } from './wal-index'

const reposDir = process.env.WALGIT_REPOS_DIR ?? '/srv/walgit/repos'
const port = Number(process.env.PORT ?? 8080)

// Comma-separated so one deployment can rotate a credential without a window
// where neither the old nor the new token works. Read through the same parser
// the Worker uses for the event stream's tokens: a credential accepted by one
// door and not the other would be indistinguishable, from the client, from a
// wrong token.
const tokens = parseTokens(process.env.WALGIT_HTTP_TOKENS)

/**
 * What this deployment offers, and therefore what `GET /` is allowed to
 * promise. One read of one derivation (`shared/capabilities.ts`), which
 * `pre-receive` takes its caps from and the two edge documents state
 * themselves from — so the page cannot state a rule the push path does not
 * hold. Unset means unenforced, and unenforced limits are simply not
 * mentioned.
 *
 * Read once at boot rather than per request, and that is a property rather
 * than an oversight: a running process's environment is fixed, so re-reading
 * would not make it fresher. The Worker's `reconcileEnv` is what replaces this
 * container when a deploy changes a variable (shared/container-env.ts).
 */
const caps = capabilitiesFrom(process.env)

/**
 * Open to anyone, deliberately. This is the public service's whole shape: with
 * writes open there is nothing a credential could prove, so demanding one only
 * costs an agent a step. It is an explicit opt-in and NOT the absence of
 * tokens — `createHttpHandler` refuses to serve when neither is configured, so
 * a deployment that loses its secrets fails closed instead of opening to the
 * world. Off unless set, so every existing deployment is unchanged.
 *
 * The GATE reads the same field `GET /` states it from, rather than its own
 * `WALGIT_PUBLIC === '1'`. Those two spellings differed — `flagEnabled` takes
 * `1` or `true` (docs/adr/0010), the gate took only `1` — so a deployment
 * spelling it `true` had a front door demanding a credential under a page
 * saying none was needed. Which spelling is right is settled by `flagEnabled`
 * existing at all: it is there precisely so both halves read a boolean-ish
 * variable the same way.
 */
const isPublic = caps.publicAccess

const store = storeFromEnv()
if (!store) {
  // Warned, not fatal: reads still work off the local cache, and a push is
  // refused by the hooks themselves rather than by guessing here.
  console.error(
    'walgit: no object store configured — pushes will be REFUSED (see src/store-env.ts)',
  )
}

/**
 * The window, read once at boot from the same variable `GET /` renders its
 * retention promise from — so the page and the sweeper can never disagree.
 */
const expiryMs = configuredExpiryMs()

/**
 * What this process actually booted with, printed once.
 *
 * The policy above is read at boot, and that is correct for a process — but the
 * variables come from the WORKER (worker/index.ts forwards them), and the
 * Worker picks up a deploy the moment it lands while the container keeps the
 * environment it started with until it is restarted. A deploy that only
 * changes an env var therefore changes nothing in here, exits 0, and leaves the
 * edge stating a policy this process does not enforce: on 2026-08-29 the
 * landing page promised a 24-hour window while the container still had expiry
 * off and answered 404 to every sweep.
 *
 * There is no way to make one deploy reach both halves at once from in here.
 * What there is, is the difference between a drift that is visible and one that
 * is not — so the process says what it believes on the way up, and `wrangler
 * tail` answers "does the container agree with the page?" in one line instead
 * of by inference from a missing paragraph.
 */
console.log(
  `walgit boot: public=${isPublic} appendOnly=${caps.appendOnly} ` +
    `retentionHours=${caps.retentionHours ?? 'off'} ` +
    `maxPush=${caps.maxPushBytes ?? 'unset'} maxRepo=${caps.maxRepoBytes ?? 'unset'} ` +
    `store=${store ? 'configured' : 'MISSING'}`,
)

/**
 * One sweep, for real. `--yes` is the CLI's opt-in because a human at a
 * terminal should have to ask; a scheduled sweep IS the asking, and a dry run
 * on a timer would collect nothing forever while looking healthy.
 *
 * Logged as well as returned: the Worker's scheduled handler prints the report
 * too, but this line is the one that survives in the container's own log when
 * the question is what the sweeper actually did.
 */
async function runSweep(logStore: ObjectStore, windowMs: number) {
  const result = await expireRepos(logStore, { windowMs, dryRun: false, reposDir })
  console.log(
    `walgit expire: collected ${result.collected.length}, retained ${result.retained.length}`,
  )
  return {
    collected: result.collected.map((o) => ({ repoId: o.repoId, reason: o.decision.reason })),
    retained: result.retained.length,
    windowMs: result.windowMs,
  }
}

let handler
try {
  handler = createHttpHandler({
    reposDir,
    tokens,
    public: isPublic,
    ensureRepo: ensureBareRepo,
    syncRepo: (repo) => syncRepo(store, repo),
    runBackend: runGitHttpBackend,
    capabilities: caps,
    // Only when there is both a log to sweep and a window to sweep by. An
    // instance with no retention configured has expiry off entirely, and the
    // endpoint should not exist for it — `expireRepos` would return an empty
    // report either way, but a deployment that cannot collect anything should
    // not answer as though it might.
    sweep: store && expiryMs !== null ? () => runSweep(store, expiryMs) : undefined,
    // Answered from the Index, so a ref-event handshake states what is
    // published rather than what this node's disk happens to hold. Absent
    // without a store, in which case there is nothing authoritative to read
    // and the endpoint should not exist.
    readRefs: store ? async (repoId) => (await loadIndex(store, repoId)).index.refs : undefined,
    // Who signed the pushes that put those refs where they are (docs/adr/0011),
    // and which keys the repository's Signer List names (docs/adr/0012). Both
    // absent when the Index has neither, which is every repository on a
    // deployment where nobody signs and nobody claims — the fields are optional
    // precisely so such an instance's index.json is unchanged, and this is
    // where that costs the reader nothing: `?? {}` for the map, and a `claim`
    // that stays undefined all the way out to a response that omits it.
    readProvenance: store
      ? async (repoId) => {
          const { index } = await loadIndex(store, repoId)
          return { provenance: index.provenance ?? {}, claim: index.claim }
        }
      : undefined,
  })
} catch (err) {
  // Refusing to boot beats booting a half-configured git host — either an open
  // one, or one that answers every request with a 401 nobody can satisfy.
  console.error((err as Error).message)
  process.exit(1)
}

Bun.serve({ port, idleTimeout: 0, fetch: handler })
console.log(`walgit smart-HTTP listening on :${port} (repos: ${reposDir})`)
