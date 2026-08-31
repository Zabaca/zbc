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

import { parseTokens } from '../shared/credentials'
import { positiveNumber } from '../shared/policy'
import { announceConfigFromEnv } from './announce'
import { ensureBareRepo } from './cache'
import { configuredExpiryMs, expireRepos } from './expire'
import { createHttpHandler } from './http'
import { runGitHttpBackend } from './git-backend'
import type { InstructionsPolicy } from './instructions'
import { limitsFromEnv } from './limits'
import { signedPushEnabled } from './push-cert'
import { signerListsEnabled } from './signers'
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
 * Open to anyone, deliberately. This is the public service's whole shape: with
 * writes open there is nothing a credential could prove, so demanding one only
 * costs an agent a step. It is an explicit opt-in and NOT the absence of
 * tokens — `createHttpHandler` refuses to serve when neither is configured, so
 * a deployment that loses its secrets fails closed instead of opening to the
 * world. Off unless set, so every existing deployment is unchanged.
 */
const isPublic = process.env.WALGIT_PUBLIC === '1'

/**
 * What `GET /` is allowed to promise. Each limit is read from the same env var
 * that enforces it, so the page states the deployment's real behaviour rather
 * than a copy of it that can drift. Unset means unenforced, and unenforced
 * limits are simply not mentioned.
 */
const limits = limitsFromEnv()
const instructions: InstructionsPolicy = {
  publicAccess: isPublic,
  appendOnly: process.env.WALGIT_APPEND_ONLY === '1',
  retentionHours: positiveNumber(process.env.WALGIT_RETENTION_HOURS) ?? undefined,
  // Not re-parsed here: `limitsFromEnv` is the function `pre-receive` enforces
  // with, so the page cannot state a cap the hook does not hold.
  maxPushBytes: limits.maxPushBytes ?? undefined,
  maxRepoBytes: limits.maxRepoBytes ?? undefined,
  // The same configuration the push path announces down, so the text can only
  // describe a stream this deployment actually publishes to. `post-receive`
  // announcing nowhere and `GET /` promising a socket would be the same defect
  // as a stated cap nothing enforces.
  events: announceConfigFromEnv() !== null,
  // The seed IS the capability (src/push-cert.ts): with none, `receive-pack`
  // never advertises `push-cert` and a client asking to sign is refused by its
  // own git. So the same read that turns it on is the one the page speaks
  // from, and an instance without a seed says nothing about signing at all.
  signedPushes: signedPushEnabled(),
  // The same predicate `pre-receive` gates the refusal on, so the page cannot
  // promise that nothing is refused for being unsigned while the hook refuses
  // it (src/signers.ts).
  signerLists: signerListsEnabled(),
}

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
  `walgit boot: public=${isPublic} appendOnly=${instructions.appendOnly} ` +
    `retentionHours=${instructions.retentionHours ?? 'off'} ` +
    `maxPush=${limits.maxPushBytes ?? 'unset'} maxRepo=${limits.maxRepoBytes ?? 'unset'} ` +
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
    instructions,
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
