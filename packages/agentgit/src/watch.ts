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

import { git, shortRef } from './git'
import { conflictPaths } from './remote'

/** Where a subscriber connects. Frozen by the ADR above; not derived from the server. */
const EVENTS_PATH = '/_walgit/events'

export interface WatchConfig {
  host: string
  token: string | null
  /**
   * The `Authorization` a Private repository's event stream needs, built fresh
   * per connect, or `null` where there is nothing to present.
   *
   * A walgit event is a strict subset of what a fetch hands over (docs/adr/0009
   * and 0013), so the credential is the same one a clone presents: a signature
   * over the host's challenge. It is re-derived on each connect because a
   * challenge stands for five minutes — a cached header would come back after a
   * long disconnect as a socket the host refuses.
   */
  credential?: (() => Promise<string | null>) | null
  /** `repo` → the checkout to fetch into. */
  targets: Map<string, string>
  /** Empty watches every ref in each repository. */
  refs: string[]
  remoteName: string
  fetch: boolean
  once: boolean
  onChange: string | null
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
}

/** Everything printed goes through here, so `--json` is a format and not a fork. */
type Emit = (event: string, fields: Record<string, unknown>, human: string) => void

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

export function watch(config: WatchConfig): void {
  const emit = makeEmit(config.json)
  /** The collision each watched ref last reported, so repeats stay quiet. */
  const standing = new Map<string, string>()
  let attempt = 0
  let closing = false
  /** The live socket, so a Proposal's pusher can arrive after the message did. */
  let socket: WebSocket | null = null

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
          if (!catchUp && config.once) {
            closing = true
            socket?.close()
          }
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
    const url = `wss://${config.host}${EVENTS_PATH}`
    const authorization = config.token
      ? `Bearer ${config.token}`
      : ((await config.credential?.().catch(() => null)) ?? null)
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
        closing = true
        live.close()
        process.exitCode = 1
        return
      }

      if (message.ok) {
        // Current state for everything watched, before any event can fire.
        // Acting on it here is what makes a freshly started watcher correct
        // rather than merely subscribed.
        emit(
          'watching',
          { host: config.host, repos: [...config.targets.keys()], refs: config.refs },
          `${config.host}: watching ${[...config.targets.keys()].join(', ')}${config.refs.length ? ` for ${config.refs.join(', ')}` : ' (all refs)'}`,
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
      if (acted === true && config.once) {
        closing = true
        live.close()
      }
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
