#!/usr/bin/env bun
/**
 * Keep local clones current without ever asking whether they are.
 *
 * This is the whole client. There is no SDK to install and nothing here is
 * imported from walgit — it is one WebSocket and one `git fetch`, written out
 * so that an agent can read it, understand the protocol from it, and paste a
 * changed version rather than depend on this file.
 *
 *   bun watch.ts my-thing=/path/to/clone other-repo=/path/to/other
 *
 * Run it in the background and forget it: `nohup bun watch.ts … &`, a tmux
 * pane, or whatever your harness uses for long-lived processes. It holds one
 * socket for every repository named, because the subscription is a list.
 *
 * WHAT IT DOES ON AN EVENT, and what it deliberately does not: `git fetch`,
 * which advances `origin/<ref>` and touches nothing else. Your branch, your
 * working tree and any work in progress are left alone — a watcher that moved
 * branches under a working agent would be a menace. "Current" here means
 * `origin/main` is fresh without anyone having asked for it; merging or
 * rebasing stays a decision its owner makes.
 *
 * WHAT IT DOES NOT NEED, which is the point: no cursor, no state file, no
 * keepalive, no config. Events are latest state, so a reconnect's handshake IS
 * the recovery — a client that was offline for an hour is correct one round
 * trip after it comes back, with nothing remembered in between.
 *
 * Measured against agentgit: an event lands under a second after the push, the
 * fetch it triggers takes about another, and a socket idle for six minutes
 * receives the next push without a keepalive of any kind.
 */

/** `repo=dir` pairs, and optionally `--ref refs/heads/whatever` (repeatable). */
function parseArgs(argv: readonly string[]): {
  targets: Map<string, string>
  refs: string[]
} {
  const targets = new Map<string, string>()
  const refs: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--ref') {
      const value = argv[i + 1]
      if (!value) throw new Error('--ref needs a ref name')
      refs.push(value)
      i += 1
      continue
    }
    const split = arg.indexOf('=')
    if (split < 1) throw new Error(`expected repo=dir, got ${JSON.stringify(arg)}`)
    targets.set(arg.slice(0, split), arg.slice(split + 1))
  }
  if (targets.size === 0) {
    throw new Error('usage: bun watch.ts <repo>=<dir> [<repo>=<dir> …] [--ref refs/heads/main]')
  }
  // Watching `refs/heads/main` unless told otherwise, rather than the whole
  // repository: fetching on every tag and every side branch is noise for the
  // one question this answers. Pass `--ref` more than once for more refs.
  return { targets, refs: refs.length > 0 ? refs : ['refs/heads/main'] }
}

const { targets, refs } = parseArgs(process.argv.slice(2))
const host = process.env.WALGIT_HOST ?? 'agentgit.zabaca.com'
// Only needed where the instance requires a credential; a public one takes none.
const token = process.env.WALGIT_TOKEN ?? ''

const log = (...parts: unknown[]) => console.log(new Date().toISOString(), ...parts)

/** Fetch the ref that moved, and say whether the clone now agrees with the event. */
function fetchRef(repo: string, ref: string, sha: string | null): void {
  const dir = targets.get(repo)
  if (!dir) return
  if (sha === null) {
    // A deleted ref is not a reason to fetch: nothing new exists to download,
    // and pruning somebody's ref out from under a working clone is a decision
    // for its owner, not for a watcher.
    log(`${repo} ${ref} deleted upstream; leaving ${dir} alone`)
    return
  }
  const short = ref.replace(/^refs\/heads\//, '')
  const result = Bun.spawnSync(['git', '-C', dir, 'fetch', '--quiet', 'origin', short])
  if (result.exitCode !== 0) {
    log(`${repo} ${short}: fetch failed (${result.exitCode})`, result.stderr.toString().trim())
    return
  }
  const local = Bun.spawnSync(['git', '-C', dir, 'rev-parse', `origin/${short}`])
    .stdout.toString()
    .trim()
  log(`${repo} ${short}: origin/${short} is ${local.slice(0, 8)}`, local === sha ? '' : '(behind)')
}

let attempt = 0

function connect(): void {
  const ws = new WebSocket(
    `wss://${host}/_walgit/events`,
    token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  )

  ws.onopen = () => {
    attempt = 0
    ws.send(JSON.stringify({ watch: [...targets.keys()].map((repo) => ({ repo, refs })) }))
  }

  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    // A refusal names what it refused — an unknown repository, a watch list
    // over the cap — and is worth reading rather than retrying blindly.
    if (message.error) return log('refused:', message.error)
    if (message.ok) {
      // The handshake: current state for everything watched, before any event
      // can fire. Fetching it here is what makes a freshly started watcher
      // correct rather than merely subscribed.
      log(`watching ${targets.size} repo(s); catching up`)
      for (const state of message.refs) fetchRef(state.repo, state.ref, state.sha)
      return
    }
    fetchRef(message.repo, message.ref, message.sha)
  }

  // Reconnect with a backoff, and nothing else: whatever moved while the socket
  // was down is in the next handshake, so there is nothing to replay and
  // nothing to remember.
  ws.onclose = (event) => {
    const wait = Math.min(30_000, 500 * 2 ** attempt)
    attempt += 1
    log(`disconnected (${event.code}); reconnecting in ${wait}ms`)
    setTimeout(connect, wait)
  }

  ws.onerror = () => {
    // Reported, not acted on: a close always follows, and reconnecting from
    // both would open two sockets.
    log('socket error')
  }
}

log(`${host}: watching ${[...targets.keys()].join(', ')} for ${refs.join(', ')}`)
connect()
