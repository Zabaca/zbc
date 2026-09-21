/**
 * One socket, and what to do with what comes down it.
 *
 * The protocol is latest state, not a log (docs/adr/0009): the reply to a
 * `watch` is the current sha of everything named, and after that one message
 * per ref that moves. There is no cursor, no replay and no keepalive, so there
 * is no state file here and nothing to resume — a reconnect's handshake IS the
 * recovery, which is why a watcher that was offline for an hour is correct one
 * round trip after it comes back.
 */

import { spawnSync } from 'node:child_process'

import type { Authorize } from './credential'
import { type FfOutcome, fastForwardOnClean } from './ff'
import { git, shortRef } from './git'
import { type CredentialProblems, credentialProblems } from './problem'
import { conflictPaths } from './remote'

/** Where a subscriber connects. Frozen by the ADR above; not derived from the server. */
const EVENTS_PATH = '/_walgit/events'

/**
 * Where a subscriber connects, derived from the one origin it was given.
 *
 * The scheme rides across because a deployment served over plain http — a
 * self-hosted node, a test — has a plain-ws event stream, and a subscriber
 * that assumed TLS against it never connects. The hostname comes from the same
 * string for the reason the separate `host` field is gone: two fields that must
 * agree are two fields an edit can make disagree, and one of them signing a
 * Read Challenge for a host nobody was talking to is exactly how that went.
 */
export function eventsUrl(origin: string): string {
  const scheme = origin.startsWith('http://') ? 'ws' : 'wss'
  return `${scheme}://${originHost(origin)}${EVENTS_PATH}`
}

/** Host and port out of an origin — the one derivation, so the two agree. */
function originHost(origin: string): string {
  return new URL(origin).host
}

export interface WatchConfig {
  /**
   * Scheme, host and port — the one answer to which deployment this is.
   *
   * The socket's URL and the hostname the `watching` event publishes are both
   * derived from it, so neither can name a host the credential was not built
   * for.
   */
  origin: string
  /**
   * Where the command was run, and the directory whose git config decides the
   * authorization when this watcher follows more than one checkout.
   */
  cwd: string
  /**
   * The one authorization this watcher presents (`src/credential.ts`), asked
   * fresh per connect.
   *
   * A walgit event is a strict subset of what a fetch hands over (docs/adr/0009
   * and 0013), so it is the same decision a clone makes: a deployment token
   * where there is one, otherwise a signature over the host's challenge. It is
   * re-asked on each connect because a challenge stands for five minutes — a
   * cached header would come back after a long disconnect as a socket the host
   * refuses.
   */
  authorize: Authorize
  /** `repo` → the checkout to fetch into. */
  targets: Map<string, string>
  /** Empty watches every ref in each repository. */
  refs: string[]
  remoteName: string
  fetch: boolean
  once: boolean
  onChange: string | null
  /** Move the branch onto the fetched work when the tree is clean. Off by default. */
  ffOnClean: boolean
  json: boolean
  /** Also report the Proposals aimed at the watched branch (docs/adr/0018). */
  proposals: boolean
  /**
   * Who pushed a Proposal, read from `GET /<name>.git/proposals`.
   *
   * A Ref Event carries a ref and a sha and nothing else (docs/adr/0009), so
   * the fingerprint is a second read — optional, and answered `null` where it
   * cannot be made, because an event withheld until the host answers is worse
   * than one that names the pusher as unknown.
   */
  pusher?:
    | ((proposal: { repo: string; id: string; target: string }) => Promise<string | null>)
    | null
  /**
   * Where the events go, instead of this process's stdout.
   *
   * Everything a watcher reports already funnels through one `Emit`, so a
   * caller whose stdout is not its to write on — a test observing what the
   * watcher said, above all — substitutes a sink here rather than parsing lines
   * back out of a pipe. Absent means the CLI's own printer, and `--json` picks
   * its format.
   */
  emit?: Emit | null
  /**
   * Where a credential problem is said out loud, once (`src/problem.ts`).
   *
   * Passed in rather than made here because the Proposals lookup holds the same
   * one: a machine with no signing key fails the socket's authorization and the
   * Proposals read for a single reason, and whichever notices first is the one
   * that explains it. Absent means a latch of this watcher's own.
   */
  problems?: CredentialProblems | null
  /**
   * The watcher stopped, and why.
   *
   * `'once'` is `--once` satisfied; `'refused'` is the host naming what it
   * refused. The exit code is the caller's to decide, which is what lets the
   * same watcher be a command and a library call.
   */
  onDone?: ((reason: WatchStop) => void) | null
}

/** Why a watcher stopped on purpose, as opposed to dropping and reconnecting. */
export type WatchStop = 'once' | 'refused'

/** A running watcher, for a caller that has to be able to stop it. */
export interface Watcher {
  close(): void
}

/** Everything printed goes through here, so `--json` is a format and not a fork. */
export type Emit = (event: string, fields: Record<string, unknown>, human: string) => void

function makeEmit(json: boolean): Emit {
  if (json) {
    return (event, fields) => {
      process.stdout.write(
        `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`,
      )
    }
  }
  return (_event, _fields, human) => {
    process.stdout.write(`${new Date().toISOString()} ${human}\n`)
  }
}

/**
 * Which files the ref that just moved collides with, here, right now.
 *
 * This is the reason an event beats a timer: not that the fetch happens sooner,
 * but that the agent can be told *the branch you are working on just moved
 * underneath you, in these files* at the moment it becomes true.
 *
 * `git stash create` is what makes that answerable. `merge-tree` compares
 * COMMITS, so an agent mid-task — edits in the working tree, nothing committed
 * — is invisible to it, which is precisely the case worth warning about.
 * `stash create` writes a throwaway commit of the working tree and index
 * without touching the working tree, the refs or the stash list; the commit is
 * unreferenced and is collected on its own.
 *
 * Exit 1 is a conflict. Exit 0 is clean — including a clone that is merely
 * behind, where the merge is a fast-forward. Anything else means git could not
 * answer (unrelated histories, and similar), and is reported as nothing rather
 * than as a conflict: an agent sent to reconcile a collision that does not
 * exist has been given work, not information.
 */
function conflicts(dir: string, remoteRef: string): string[] {
  const wip = git(dir, ['stash', 'create']).stdout.trim()
  const merge = git(dir, ['merge-tree', '--write-tree', '--name-only', wip || 'HEAD', remoteRef])
  return merge.code === 1 ? conflictPaths(merge.stdout) : []
}

/**
 * What `--ff-on-clean` did, said once per fetch.
 *
 * Every outcome is reported, including the ones where nothing happened. A flag
 * that moves a branch has to account for itself on the turn it declines as much
 * as on the turn it acts — an owner who cannot see why their clone stayed put
 * has been given a mystery, not a feature.
 */
function reportFf(emit: Emit, key: string, repo: string, ref: string, ff: FfOutcome): void {
  switch (ff.kind) {
    case 'moved':
      return emit(
        'fast-forwarded',
        { repo, ref, commit: ff.commit, synthesized: ff.synthesized },
        `${key}: fast-forwarded onto ${ff.commit.slice(0, 8)}` +
          (ff.synthesized ? ' (merge made for it; your branch had diverged)' : ''),
      )
    case 'elsewhere':
      return emit(
        'held',
        { repo, ref, reason: 'elsewhere', head: ff.head },
        `${key}: not fast-forwarded; this checkout is on ${ff.head}, not ${ref}`,
      )
    case 'dirty':
      return emit(
        'held',
        { repo, ref, reason: 'dirty', paths: ff.paths },
        `${key}: not fast-forwarded; you have uncommitted changes in ${ff.paths.join(', ')}`,
      )
    case 'conflicts':
      return emit(
        'held',
        { repo, ref, reason: 'conflicts' },
        `${key}: not fast-forwarded; it conflicts with your branch`,
      )
    case 'refused':
      return emit(
        'held',
        { repo, ref, reason: 'refused', detail: ff.reason },
        `${key}: not fast-forwarded; git refused: ${ff.reason}`,
      )
    case 'current':
      return
  }
}

/** Where a Proposal lives, spelled the one way ADR-0018 spells it. */
const PROPOSALS_PREFIX = 'refs/walgit/proposals/'

/** What a watcher follows, and whether it also follows Proposals aimed at it. */
export interface Interest {
  /** The full ref names this watcher follows. Empty means every ref. */
  refs: readonly string[]
  proposals: boolean
}

/**
 * What a ref that moved is, to this watcher.
 *
 * `ref` is the ordinary path — fetch it, report it, warn about collisions —
 * and carries the Proposal ids this move merged (docs/adr/0018), empty unless
 * the flag is on. `proposal` is reported and never fetched: the whole reason
 * the flag is opt-in is that a stranger's commit must not reach a working
 * agent's clone.
 */
export type Routed =
  | { kind: 'ignore' }
  | { kind: 'ref'; merged: string[] }
  | { kind: 'proposal'; id: string; target: string }

/**
 * Which of the three a Ref Event is.
 *
 * The subscription under `--proposals` is the whole repository, because the
 * wire takes exact ref names and a Proposal's id is the pusher's word — there
 * is nothing to name in advance. So the narrowing happens here instead: a
 * wider subscription, and not one byte of wider effect.
 */
export function route(
  interest: Interest,
  event: { ref: string; merged?: readonly string[] },
): Routed {
  if (interest.proposals && event.ref.startsWith(PROPOSALS_PREFIX)) {
    const rest = event.ref.slice(PROPOSALS_PREFIX.length)
    const cut = rest.lastIndexOf('/')
    // `<target>/<id>`, and a target may itself hold slashes. Anything without
    // both halves is not a Proposal this client can name.
    if (cut <= 0) return { kind: 'ignore' }
    const target = rest.slice(0, cut)
    const id = rest.slice(cut + 1)
    if (id === '' || !interest.refs.includes(`refs/heads/${target}`)) return { kind: 'ignore' }
    return { kind: 'proposal', id, target }
  }

  if (interest.refs.length > 0 && !interest.refs.includes(event.ref)) return { kind: 'ignore' }
  return { kind: 'ref', merged: interest.proposals ? [...(event.merged ?? [])] : [] }
}

/**
 * Which directory's git config decides this watcher's authorization.
 *
 * The single target's, where there is exactly one — so a repository-local
 * `user.signingkey` decides a read of that clone exactly as it decides that
 * clone's pushes. Where several checkouts are followed no one of them is the
 * answer, so the directory the command was run in is, which is where a global
 * key is read from anyway.
 */
export function credentialDir(targets: ReadonlyMap<string, string>, cwd: string): string {
  if (targets.size !== 1) return cwd
  for (const dir of targets.values()) return dir
  return cwd
}

export function watch(config: WatchConfig): Watcher {
  const emit = config.emit ?? makeEmit(config.json)
  // The latch gets its sink here and not at construction: `src/resolve.ts`
  // builds it early so the Proposals lookup can share it, and the emitter is
  // this function's to choose.
  const problems = config.problems ?? credentialProblems()
  problems.sendTo(emit)
  /** The collision each watched ref last reported, so repeats stay quiet. */
  const standing = new Map<string, string>()
  let attempt = 0
  let closing = false
  /** The live socket, so a Proposal's pusher can arrive after the message did. */
  let socket: WebSocket | null = null

  /**
   * Stop for good, as opposed to the drop that `onclose` reconnects from.
   *
   * `closing` is what tells those two apart, so every deliberate stop goes
   * through here — including the caller's, which is how a timeout ends a watch
   * without racing the reconnect backoff.
   */
  const stop = (reason: WatchStop | null): void => {
    if (closing) return
    closing = true
    socket?.close()
    if (reason !== null) config.onDone?.(reason)
  }

  /**
   * What one event does, and whether it satisfies `--once`.
   *
   * `pending` is a Proposal whose pusher is still being read: the emission
   * happens in the callback, and so does the exit, because `--once` means "the
   * first thing was reported" and a line nobody printed was not reported.
   */
  const handle = (
    repo: string,
    ref: string,
    sha: string | null,
    catchUp: boolean,
    merged: readonly string[],
  ): boolean | 'pending' => {
    const dir = config.targets.get(repo)
    if (dir === undefined) return false
    const short = shortRef(ref)

    const routed = route({ refs: config.refs, proposals: config.proposals }, { ref, merged })
    if (routed.kind === 'ignore') return false

    if (routed.kind === 'proposal') {
      // Reported and never fetched. Under `--proposals` the subscription is the
      // whole repository, so this is the branch where a stranger's commit would
      // otherwise reach a working clone — and it stops here.
      if (sha === null) return false
      const { id, target } = routed
      const say = (pusher: string | null) =>
        emit(
          'proposal',
          { repo, ref, id, target, sha, pusher },
          `${repo} ${id} → ${target}: proposed ${sha.slice(0, 8)}${pusher ? ` by ${pusher}` : ''}`,
        )
      if (!config.pusher) {
        say(null)
        return true
      }
      void config
        .pusher({ repo, id, target })
        .catch(() => null)
        .then((pusher) => {
          say(pusher)
          if (!catchUp && config.once) stop('once')
        })
      return 'pending'
    }

    // What this move made an ancestor of the branch (docs/adr/0018) — the one
    // thing a watcher learns without a second call, which is why it is here
    // rather than behind the Proposals read.
    for (const id of routed.merged) {
      emit(
        'merged',
        { repo, ref, id, target: short, sha },
        `${repo} ${id} → ${short}: merged${sha ? ` at ${sha.slice(0, 8)}` : ''}`,
      )
    }

    if (sha === null) {
      // Nothing new exists to download, and pruning somebody's ref out from
      // under a working clone is a decision for its owner, not for a watcher.
      emit('deleted', { repo, ref }, `${repo} ${ref}: deleted upstream; leaving ${dir} alone`)
      return true
    }

    if (!config.fetch) {
      emit('moved', { repo, ref, sha }, `${repo} ${short}: now ${sha.slice(0, 8)}`)
      return true
    }

    const fetched = git(dir, ['fetch', '--quiet', config.remoteName, short])
    if (fetched.code !== 0) {
      emit(
        'fetch-failed',
        { repo, ref, code: fetched.code, stderr: fetched.stderr.trim() },
        `${repo} ${short}: fetch failed (${fetched.code}) ${fetched.stderr.trim()}`,
      )
      return true
    }

    const remoteRef = `${config.remoteName}/${short}`
    const local = git(dir, ['rev-parse', remoteRef]).stdout.trim()
    emit(
      'fetched',
      { repo, ref, sha, local, current: local === sha },
      `${repo} ${short}: ${remoteRef} is ${local.slice(0, 8)}${local === sha ? '' : ' (behind)'}`,
    )

    // Reported when it CHANGES, not on every event. A collision that is still
    // there is still true, but an agent told the same thing on every unrelated
    // push learns to ignore the channel — and this is only worth having if it
    // is believed.
    const key = `${repo} ${short}`
    const clash = conflicts(dir, remoteRef).join(', ')
    const before = standing.get(key) ?? ''
    if (clash !== before) {
      standing.set(key, clash)
      if (clash)
        emit(
          'collides',
          { repo, ref, paths: clash.split(', ') },
          `${key}: COLLIDES with your work in ${clash}`,
        )
      else if (before) emit('clear', { repo, ref }, `${key}: no longer collides with your work`)
    }

    // Before --on, so a command that inspects the tree sees the merged state
    // rather than racing it.
    if (config.ffOnClean) {
      reportFf(emit, key, repo, ref, fastForwardOnClean(dir, ref, remoteRef))
    }

    if (config.onChange && !catchUp) {
      const spawned = spawnCommand(config.onChange, dir, { repo, ref, sha })
      emit(
        'ran',
        { repo, ref, command: config.onChange, code: spawned },
        `${key}: ran --on (exit ${spawned})`,
      )
    }

    return true
  }

  const connect = async (): Promise<void> => {
    // A stop that lands inside a backoff window has a reconnect already
    // scheduled, and nothing cancels a timer that has not fired. As a command
    // that is a process about to exit; inside a host that outlives the watch it
    // is a socket that opens after the caller stopped listening and then
    // reconnects forever. Checked here because this is the one place both paths
    // pass through — including the `await` below, which is a second window in
    // which a stop can arrive.
    if (closing) return
    const url = eventsUrl(config.origin)
    // Nothing here can throw, so nothing here catches. A `problem` is reported
    // and not acted on: the socket still opens, because a repository that is
    // public needs no credential and a watcher that refused to try would be
    // wrong about the common case.
    const answered = await config.authorize(credentialDir(config.targets, config.cwd))
    problems.report(config.origin, answered)
    const authorization = answered.kind === 'header' ? answered.header : null
    if (closing) return
    socket = authorization
      ? new WebSocket(url, { headers: { authorization } } as never)
      : new WebSocket(url)
    const live = socket

    live.onopen = () => {
      attempt = 0
      // Under `--proposals` the whole repository is subscribed to: a Proposal's
      // id is the pusher's word, so there is no ref name to ask for in advance.
      // `route` is what keeps the wider subscription from being a wider effect.
      const entries = [...config.targets.keys()].map((repo) =>
        config.refs.length > 0 && !config.proposals ? { repo, refs: config.refs } : { repo },
      )
      live.send(JSON.stringify({ watch: entries }))
    }

    live.onmessage = (event: MessageEvent) => {
      let message: {
        error?: string
        ok?: boolean
        refs?: { repo: string; ref: string; sha: string | null }[]
        repo?: string
        ref?: string
        sha?: string | null
        merged?: string[]
      }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }

      // A refusal names what it refused — an unknown repository, a watch list
      // over the cap — and is worth reading rather than retrying blindly.
      if (message.error) {
        emit('refused', { error: message.error }, `refused: ${message.error}`)
        stop('refused')
        return
      }

      if (message.ok) {
        // Current state for everything watched, before any event can fire.
        // Acting on it here is what makes a freshly started watcher correct
        // rather than merely subscribed.
        // The hostname is derived, not carried: `host` stays in the event
        // because it is documented output, and it is the host of the origin
        // the socket was actually opened against.
        const host = originHost(config.origin)
        emit(
          'watching',
          { host, repos: [...config.targets.keys()], refs: config.refs },
          `${host}: watching ${[...config.targets.keys()].join(', ')}${config.refs.length ? ` for ${config.refs.join(', ')}` : ' (all refs)'}`,
        )
        // A handshake is state, not a move, so nothing in it merged anything
        // (docs/adr/0009) — a Proposal already standing is still reported, so a
        // watcher that starts late sees what is open.
        for (const state of message.refs ?? []) handle(state.repo, state.ref, state.sha, true, [])
        return
      }

      if (typeof message.repo !== 'string' || typeof message.ref !== 'string') return
      const acted = handle(
        message.repo,
        message.ref,
        message.sha ?? null,
        false,
        message.merged ?? [],
      )
      if (acted === true && config.once) stop('once')
    }

    // Reconnect with a backoff, and nothing else: whatever moved while the
    // socket was down is in the next handshake, so there is nothing to replay.
    live.onclose = (event: CloseEvent) => {
      if (closing) return
      const wait = Math.min(30_000, 500 * 2 ** attempt)
      attempt += 1
      emit(
        'disconnected',
        { code: event.code, retryMs: wait },
        `disconnected (${event.code}); reconnecting in ${wait}ms`,
      )
      setTimeout(() => void connect(), wait)
    }

    // Reported, not acted on: a close always follows, and reconnecting from
    // both would open two sockets.
    live.onerror = () => emit('socket-error', {}, 'socket error')
  }

  void connect()
  return { close: () => stop(null) }
}

/**
 * `--on`, run in the clone that just moved.
 *
 * A shell string rather than an argv, because the point is to paste whatever
 * the harness already uses. The three facts the command needs arrive as
 * environment variables so a one-liner does not have to parse anything.
 */
function spawnCommand(
  command: string,
  dir: string,
  env: { repo: string; ref: string; sha: string },
): number {
  const run = spawnSync(process.env.SHELL || '/bin/sh', ['-c', command], {
    cwd: dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENTGIT_REPO: env.repo,
      AGENTGIT_REF: env.ref,
      AGENTGIT_SHA: env.sha,
    },
  })
  return run.status ?? 1
}
